/**
 * Đo baseline thật của 4 nguồn trên DB RIÊNG (không đụng data/finance.db).
 *
 *   npm run audit -- orders|paypal|stripe|pipo [file]
 *
 * In ra: dòng raw → event → chứng từ → dòng GL → Σ Nợ/Có + exception theo loại, kèm thời gian & RSS.
 * Số in ra chính là baseline ghi vào test, CLAUDE.md rule 9 và DEVELOPER_GUIDE §10.2.
 *
 * Mỗi nguồn chạy 1 tiến trình riêng để đỉnh bộ nhớ không cộng dồn (PayPal 142k dòng ~12GB RSS).
 */
import fs from "node:fs";
import path from "node:path";

const SOURCES = {
  orders: "order-data.csv",
  paypal: "Bank_Paypal.csv",
  stripe: "Bank_Stripe.csv",
  pipo: "Bank_Pipo.csv",
} as const;

type Source = keyof typeof SOURCES;

async function main() {
  const source = process.argv[2] as Source;
  if (!SOURCES[source]) {
    console.error(`Cách dùng: npm run audit -- ${Object.keys(SOURCES).join("|")} [file]`);
    process.exit(1);
  }
  const file = path.resolve(process.argv[3] ?? path.join("data", "samples", SOURCES[source]));
  const dbPath = path.resolve("data", "audit", `${source}.db`);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });
  // Phải set trước khi import module DB (client đọc DATABASE_PATH lúc load)
  process.env.DATABASE_PATH = dbPath;

  const { importOrders } = await import("@/lib/services/import-orders");
  const { importSourceFile } = await import("@/lib/services/import-source");
  const { runBuildOrders } = await import("@/lib/services/build");
  const { runBuildSource } = await import("@/lib/services/build-source");
  const { runPost } = await import("@/lib/services/post");
  const { closeDb, getDb } = await import("@/lib/db/client");
  const { seedTestCompanies } = await import("../tests/helpers/fixtures");

  const db = getDb();
  // Dùng đúng bộ Company/Gateway của test để số đo khớp với baseline test
  seedTestCompanies(db);

  const step = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
    const t = Date.now();
    const result = await fn();
    console.log(`\n== ${name} (${Date.now() - t} ms, RSS ${Math.round(process.memoryUsage().rss / 1e6)} MB)`);
    return result;
  };

  const buffer = fs.readFileSync(file);
  const imp = await step("IMPORT", () =>
    source === "orders" ? importOrders(buffer, path.basename(file)) : importSourceFile(source, buffer, path.basename(file)),
  );
  console.log({ ...imp, errors: imp.errors.slice(0, 5) });

  const build = await step("BUILD", () => (source === "orders" ? runBuildOrders({}) : runBuildSource(source, {})));
  console.log(build);

  const { SOURCE_DATA_SOURCES } = await import("@/lib/services/build-source");
  const post = await step("POST", () => runPost("All", source === "orders" ? {} : { dataSource: SOURCE_DATA_SOURCES[source] }));
  console.log(post.map((p) => ({ Classify: p.Classify, Status: p.Status, PostedEvents: p.PostedEvents, Documents: p.Documents, InsertedRows: p.InsertedRows })));

  const sqlite = db.$client;
  const print = (title: string, sql: string) => {
    console.log(`\n== ${title}`);
    console.table(sqlite.prepare(sql).all());
  };
  print("Event theo nghiệp vụ", "SELECT JournalTypeCode, PostStatus, count(*) n, round(sum(Amount), 2) amount FROM AccountingEvent GROUP BY 1, 2 ORDER BY n DESC");
  print("GLTrans", "SELECT count(*) lines, count(DISTINCT DocNum) docs, round(sum(AccountedDr), 2) dr, round(sum(AccountedCr), 2) cr, min(Period) pmin, max(Period) pmax FROM GLTrans");
  print("Chứng từ không cân (phải rỗng)", "SELECT DocNum, round(sum(AccountedDr), 2) dr, round(sum(AccountedCr), 2) cr FROM GLTrans GROUP BY DocNum HAVING abs(dr - cr) > 0.001");
  print("Exception", "SELECT Severity, ExceptionType, count(*) n FROM ExceptionLog GROUP BY 1, 2 ORDER BY n DESC");

  closeDb();
  console.log(`\nDB: ${dbPath}`);
}

void main();

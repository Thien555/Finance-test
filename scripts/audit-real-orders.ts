/**
 * Chạy Import → Build → Post trên 1 file order (thường là dữ liệu thật) vào DB RIÊNG, không đụng data/finance.db.
 *
 *   npx tsx scripts/audit-real-orders.ts <file.xlsx|file.csv> [db-path]
 *
 * - DB mặc định: data/audit/real-orders.db (gitignore). File DB cũ bị xóa trước khi chạy.
 * - File ~20MB cần khoảng 3GB RAM; nếu thiếu heap: NODE_OPTIONS=--max-old-space-size=8192
 * - Sau khi chạy, soi dữ liệu bằng DB Browser for SQLite hoặc better-sqlite3 (xem docs/DEVELOPER_GUIDE.md §12.1).
 */
import fs from "node:fs";
import path from "node:path";

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Cách dùng: npx tsx scripts/audit-real-orders.ts <file.xlsx|file.csv> [db-path]");
    process.exit(1);
  }
  const dbPath = path.resolve(process.argv[3] ?? "data/audit/real-orders.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });
  // Phải set trước khi import module DB (client đọc DATABASE_PATH lúc load)
  process.env.DATABASE_PATH = dbPath;

  const { importOrders } = await import("@/lib/services/import-orders");
  const { runBuildOrders } = await import("@/lib/services/build");
  const { runPost } = await import("@/lib/services/post");
  const { closeDb, getDb } = await import("@/lib/db/client");

  const step = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
    const t = Date.now();
    const result = await fn();
    const rss = Math.round(process.memoryUsage().rss / 1e6);
    console.log(`\n== ${name} (${Date.now() - t} ms, RSS ${rss} MB)`);
    return result;
  };

  const imp = await step("IMPORT", () => importOrders(fs.readFileSync(file), path.basename(file)));
  console.log({ ...imp, errors: imp.errors.slice(0, 10) });

  const build = await step("BUILD", () => runBuildOrders({}));
  console.log(build);

  const post = await step("POST", () => runPost("All", {}));
  console.log(post);

  const sqlite = getDb().$client;
  const print = (title: string, sql: string) => {
    console.log(`\n== ${title}`);
    console.table(sqlite.prepare(sql).all());
  };
  print("RawOrders theo trạng thái", "SELECT ItemStatus, BuildStatus, count(*) n FROM RawOrders GROUP BY 1, 2 ORDER BY n DESC");
  print("Exception", "SELECT BatchType, Severity, ExceptionType, count(*) n FROM ExceptionLog GROUP BY 1, 2, 3 ORDER BY n DESC");
  print(
    "Event theo nghiệp vụ",
    "SELECT JournalTypeCode, PostStatus, count(*) n, round(sum(Amount), 2) amount FROM AccountingEvent GROUP BY 1, 2",
  );
  print(
    "GLTrans",
    "SELECT count(*) lines, count(DISTINCT DocNum) docs, round(sum(AccountedDr), 2) dr, round(sum(AccountedCr), 2) cr, min(TransDate) dmin, max(TransDate) dmax FROM GLTrans",
  );
  print(
    "Chứng từ không cân (phải rỗng)",
    "SELECT DocNum, round(sum(AccountedDr), 2) dr, round(sum(AccountedCr), 2) cr FROM GLTrans GROUP BY DocNum HAVING abs(dr - cr) > 0.001",
  );
  print(
    "Cổng thanh toán chưa map",
    "SELECT PaymentGatewayName, ItemStatus, count(*) n FROM RawOrders WHERE ComCode IS NULL GROUP BY 1, 2 ORDER BY n DESC",
  );

  closeDb();
  console.log(`\nDB: ${dbPath}`);
}

void main();

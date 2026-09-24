/**
 * Chạy cả luồng của 3 nguồn ngoài Orders trên 1 file SQLite tạm (file dữ liệu thật, không cắt lát):
 * Import → Build → Post → Unpost → Unbuild → Build + Post lại.
 */
import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dbFile = path.join(os.tmpdir(), `finance-bank-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = dbFile;

const sample = (file: string) => readFileSync(path.join(process.cwd(), "data", "samples", file));

describe("luồng nguồn ngoài Orders → GLTrans trên DB", async () => {
  const { importSourceFile } = await import("@/lib/services/import-source");
  const { runBuildSource } = await import("@/lib/services/build-source");
  const { runPost } = await import("@/lib/services/post");
  const { unpost, unbuild } = await import("@/lib/services/clear");
  const { listGl, listEvents, listExceptions } = await import("@/lib/services/queries");
  const { getDb, closeDb } = await import("@/lib/db/client");
  const { seedTestCompanies } = await import("../helpers/fixtures");
  seedTestCompanies(getDb());

  afterAll(() => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(dbFile + suffix, { force: true });
  });

  /** Chỉ dùng `.total`/`.totals` (tính trên toàn bộ tập lọc) nên không cần kéo hàng nghìn dòng */
  const glOf = (dataSource: string) => listGl({ dataSource, pageSize: 1 });

  it("import 3 file vào 3 bảng raw", async () => {
    expect(await importSourceFile("paypal", sample("Bank_Paypal.csv"), "Bank_Paypal.csv")).toMatchObject({
      Status: "SUCCESS",
      DataSource: "PAYPAL",
      TotalRows: 142_659,
      InsertedRows: 142_659,
      ErrorRows: 0,
    });
    expect(await importSourceFile("stripe", sample("Bank_Stripe.csv"), "Bank_Stripe.csv")).toMatchObject({
      Status: "SUCCESS",
      TotalRows: 1_413,
      InsertedRows: 1_413,
    });
    expect(await importSourceFile("pipo", sample("Bank_Pipo.csv"), "Bank_Pipo.csv")).toMatchObject({
      Status: "SUCCESS",
      TotalRows: 952,
      InsertedRows: 952,
    });
  });

  it("import lại file y hệt thì bỏ qua hết", async () => {
    const again = await importSourceFile("paypal", sample("Bank_Paypal.csv"), "Bank_Paypal.csv");
    expect(again).toMatchObject({ InsertedRows: 0, ReplacedRows: 0, SkippedRows: 142_659, ErrorRows: 0 });
  });

  it("build PayPal / Stripe / PIPO", () => {
    expect(runBuildSource("paypal")).toMatchObject({ Status: "SUCCESS", SourceRows: 142_659, ErrorRows: 1, EventsCreated: 198_243 });
    expect(runBuildSource("stripe")).toMatchObject({ Status: "SUCCESS", SourceRows: 1_413, ErrorRows: 0, EventsCreated: 2_712 });
    expect(runBuildSource("pipo")).toMatchObject({ Status: "SUCCESS", SourceRows: 952, SkippedRows: 3, EventsCreated: 968 });
  });

  it("build lại khi chưa post → thay thế, không nhân đôi", () => {
    expect(runBuildSource("paypal")).toMatchObject({ EventsCreated: 0, EventsReplaced: 198_243 });
    expect(listEvents({ dataSource: "PAYPAL" }).total).toBe(198_243);
  });

  it("post từng nguồn → mọi chứng từ cân Nợ/Có", () => {
    for (const [dataSource, events] of [
      ["PAYPAL", 198_243],
      ["STRIPE", 2_712],
      ["PIPO", 968],
    ] as const) {
      const results = runPost("All", { dataSource });
      const posted = results.reduce((s, r) => s + r.PostedEvents, 0);
      expect(results.every((r) => r.Status !== "FAILED")).toBe(true);
      expect(posted).toBe(events);

      const gl = glOf(dataSource);
      expect(gl.totals.AccountedDr).toBe(gl.totals.AccountedCr);
      expect(gl.total).toBeGreaterThan(0);
    }
    expect(listEvents({ postStatus: "NEW" }).total).toBe(0);
  });

  it("sửa tay cột JournalType rồi import lại dòng đã build → bị chặn", async () => {
    // Chỉ gửi lại header + 1 dòng đã sửa: đủ để kiểm chốt chặn mà không phải import lại 142k dòng
    const EOL = String.fromCharCode(13, 10);
    const [header, ...lines] = sample("Bank_Paypal.csv").toString("utf8").split(EOL);
    const target = lines.find((l) => l.includes("PP_RESERVE_HOLD"))!;
    const changed = Buffer.from([header, target.replace("PP_RESERVE_HOLD", "PP_GENERAL_HOLD")].join(EOL) + EOL, "utf8");

    const r = await importSourceFile("paypal", changed, "Bank_Paypal.csv");
    expect(r.TotalRows).toBe(1);
    expect(r.ErrorRows).toBe(1);
    expect(r.errors[0].message).toContain("Unbuild");
  });

  it("exception của nguồn được gom nhóm, không ghi từng dòng", () => {
    const ex = listExceptions({ pageSize: 500 });
    const paypal = ex.rows.filter((e) => e.DataSource === "PAYPAL");
    // 198.243 event / 142.659 dòng nhưng exception gom nhóm nên chỉ vài chục dòng
    expect(paypal.length).toBeLessThan(60);
    expect(paypal).toHaveLength(37);
    expect(paypal.some((e) => e.ExceptionType === "MISSING_JOURNAL_TYPE" && e.Severity === "ERROR")).toBe(true);
    expect(paypal.some((e) => e.Message?.includes("dòng"))).toBe(true);
  });

  // Chu kỳ Unpost → Unbuild → Build + Post lại chạy trên Stripe (1.413 dòng): logic dùng chung cho mọi
  // nguồn, làm trên PayPal 142k dòng chỉ tốn thêm vài phút mà không kiểm thêm được gì.
  it("unpost + unbuild theo nguồn chỉ động vào nguồn đó", () => {
    const otherBefore = listEvents({ dataSource: "PAYPAL" }).total;

    unpost({ scope: { dataSource: "STRIPE" } });
    expect(glOf("STRIPE").total).toBe(0);
    expect(listEvents({ dataSource: "STRIPE", postStatus: "NEW" }).total).toBe(2_712);

    const r = unbuild({ scope: { dataSource: "STRIPE" } });
    expect(r).toMatchObject({ deletedEvents: 2_712, rawRowsReset: 1_413 });
    expect(listEvents({ dataSource: "STRIPE" }).total).toBe(0);

    expect(listEvents({ dataSource: "PAYPAL" }).total).toBe(otherBefore);
    expect(glOf("PAYPAL").total).toBeGreaterThan(0);
  });

  it("build + post lại Stripe ra kết quả giống hệt lần đầu", () => {
    expect(runBuildSource("stripe").EventsCreated).toBe(2_712);
    const posted = runPost("All", { dataSource: "STRIPE" }).reduce((s, r) => s + r.PostedEvents, 0);
    expect(posted).toBe(2_712);
    const gl = glOf("STRIPE");
    expect(gl.totals.AccountedDr).toBe(gl.totals.AccountedCr);
    expect(gl.totals.AccountedDr).toBe(123_799.26);
  });
});

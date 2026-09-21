/**
 * Chạy cả luồng của 4 nguồn ngoài Orders trên 1 file SQLite tạm:
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
  const { closeDb } = await import("@/lib/db/client");

  afterAll(() => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(dbFile + suffix, { force: true });
  });

  const glOf = (dataSource: string) => listGl({ dataSource, pageSize: 5000 });

  it("import 5 sheet vào 4 bảng raw", async () => {
    expect(await importSourceFile("paypal", sample("paypal-sample.csv"), "paypal-sample.csv")).toMatchObject({
      Status: "SUCCESS",
      DataSource: "PAYPAL",
      TotalRows: 81,
      InsertedRows: 81,
      ErrorRows: 0,
    });
    expect(await importSourceFile("stripe", sample("stripe-sample.csv"), "stripe-sample.csv")).toMatchObject({
      Status: "SUCCESS",
      TotalRows: 48,
      InsertedRows: 48,
    });
    expect(await importSourceFile("pipo", sample("pipo-sample.csv"), "pipo-sample.csv")).toMatchObject({
      Status: "SUCCESS",
      TotalRows: 36,
      InsertedRows: 36,
    });
    expect(
      await importSourceFile("accounting-source", sample("master-card-sample.csv"), "master-card-sample.csv", "Master Card"),
    ).toMatchObject({ Status: "SUCCESS", TotalRows: 39, InsertedRows: 39 });
    expect(
      await importSourceFile("accounting-source", sample("bank-royal-sample.csv"), "bank-royal-sample.csv", "Bank_Royal"),
    ).toMatchObject({ Status: "SUCCESS", TotalRows: 31, InsertedRows: 31 });
  });

  it("import lại file y hệt thì bỏ qua hết", async () => {
    const again = await importSourceFile("paypal", sample("paypal-sample.csv"), "paypal-sample.csv");
    expect(again).toMatchObject({ InsertedRows: 0, ReplacedRows: 0, SkippedRows: 81, ErrorRows: 0 });
  });

  it("2 sheet của AccountingSource nằm chung 1 bảng, khóa không đụng nhau", () => {
    const s = runBuildSource("accounting-source");
    expect(s).toMatchObject({ Status: "SUCCESS", SourceRows: 70, ErrorRows: 0, EventsError: 0 });
    expect(s.EventsCreated).toBe(39 + 55);
  });

  it("build PayPal / Stripe / PIPO", () => {
    expect(runBuildSource("paypal")).toMatchObject({ Status: "SUCCESS", SourceRows: 81, ErrorRows: 1, EventsCreated: 113 });
    expect(runBuildSource("stripe")).toMatchObject({ Status: "SUCCESS", SourceRows: 48, ErrorRows: 0, EventsCreated: 71 });
    expect(runBuildSource("pipo")).toMatchObject({ Status: "SUCCESS", SourceRows: 36, SkippedRows: 2, EventsCreated: 48 });
  });

  it("build lại khi chưa post → thay thế, không nhân đôi", () => {
    expect(runBuildSource("paypal")).toMatchObject({ EventsCreated: 0, EventsReplaced: 113 });
    expect(listEvents({ dataSource: "PAYPAL" }).total).toBe(113);
  });

  it("post từng nguồn → mọi chứng từ cân Nợ/Có", () => {
    for (const [dataSource, events] of [
      ["PAYPAL", 113],
      ["STRIPE", 71],
      ["PIPO", 48],
      ["ACCOUNTINGSOURCE", 94],
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

  it("Master Card ra đúng Nợ 11202091 / Có 11202061, tổng 1.076,87 USD", () => {
    const gl = glOf("ACCOUNTINGSOURCE");
    const card = gl.rows.filter((l) => l.AccountCode === "11202091");
    expect(card.length).toBe(39);
    expect(card.every((l) => (l.AccountedDr ?? 0) > 0)).toBe(true);
    expect(card.reduce((s, l) => s + (l.AccountedDr ?? 0), 0)).toBeCloseTo(1076.87, 2);
    // Bank_Royal cũng có dòng Có 11202061 nên phải ghép theo chứng từ của Master Card
    const cardDocs = new Set(card.map((l) => l.DocNum));
    const contra = gl.rows.filter((l) => cardDocs.has(l.DocNum) && l.AccountCode === "11202061");
    expect(contra.length).toBe(39);
    expect(contra.every((l) => (l.AccountedCr ?? 0) > 0)).toBe(true);
  });

  it("Bank_Royal ghi CAD và quy đổi sang USD", () => {
    const cad = glOf("ACCOUNTINGSOURCE").rows.filter((l) => l.InputCurr === "CAD");
    expect(cad.length).toBeGreaterThan(0);
    expect(cad.every((l) => l.FncCurr === "USD" && l.RateType === "DIV" && l.XRate > 1)).toBe(true);
  });

  it("sửa tay cột JournalType rồi import lại dòng đã build → bị chặn", async () => {
    const changed = Buffer.from(
      sample("paypal-sample.csv").toString("utf8").replace("PP_RESERVE_HOLD", "PP_GENERAL_HOLD"),
    );
    const r = await importSourceFile("paypal", changed, "paypal-sample.csv");
    expect(r.ErrorRows).toBeGreaterThan(0);
    expect(r.errors[0].message).toContain("Unbuild");
  });

  it("exception của nguồn được gom nhóm, không ghi từng dòng", () => {
    const ex = listExceptions({ pageSize: 500 });
    const paypal = ex.rows.filter((e) => e.DataSource === "PAYPAL");
    expect(paypal.length).toBeLessThan(60); // 113 event / 81 dòng nhưng chỉ vài chục dòng exception gom nhóm
    expect(paypal.some((e) => e.ExceptionType === "MISSING_JOURNAL_TYPE" && e.Severity === "ERROR")).toBe(true);
    expect(paypal.some((e) => e.Message?.includes("dòng"))).toBe(true);
  });

  it("unpost + unbuild theo nguồn chỉ động vào nguồn đó", () => {
    const otherBefore = listEvents({ dataSource: "STRIPE" }).total;

    unpost({ scope: { dataSource: "PAYPAL" } });
    expect(glOf("PAYPAL").total).toBe(0);
    expect(listEvents({ dataSource: "PAYPAL", postStatus: "NEW" }).total).toBe(113);

    const r = unbuild({ scope: { dataSource: "PAYPAL" } });
    expect(r).toMatchObject({ deletedEvents: 113, rawRowsReset: 81 });
    expect(listEvents({ dataSource: "PAYPAL" }).total).toBe(0);

    expect(listEvents({ dataSource: "STRIPE" }).total).toBe(otherBefore);
    expect(glOf("STRIPE").total).toBeGreaterThan(0);
  });

  it("build + post lại PayPal ra kết quả giống hệt lần đầu", () => {
    expect(runBuildSource("paypal").EventsCreated).toBe(113);
    const posted = runPost("All", { dataSource: "PAYPAL" }).reduce((s, r) => s + r.PostedEvents, 0);
    expect(posted).toBe(113);
    const gl = glOf("PAYPAL");
    expect(gl.totals.AccountedDr).toBe(gl.totals.AccountedCr);
  });
});

/**
 * Chạy cả luồng trên 1 file SQLite tạm: Import → Build → Post → Unpost → Unbuild → Build + Post lại.
 */
import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterAll, describe, expect, it } from "vitest";

const dbFile = path.join(os.tmpdir(), `finance-test-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = dbFile;

const sample = readFileSync(path.join(process.cwd(), "data", "samples", "orders-sample.csv"));

describe("luồng Orders → GLTrans trên DB", async () => {
  const { importOrders } = await import("@/lib/services/import-orders");
  const { runBuildOrders } = await import("@/lib/services/build");
  const { runPost } = await import("@/lib/services/post");
  const { unpost, unbuild } = await import("@/lib/services/clear");
  const { listGl, listEvents, dashboardStats } = await import("@/lib/services/queries");
  const { glWorkbook, GL_EXPORT_COLUMNS } = await import("@/lib/services/export");
  const { allGl } = await import("@/lib/services/queries");
  const { getDb, closeDb } = await import("@/lib/db/client");
  const { seedTestCompanies } = await import("../helpers/fixtures");
  seedTestCompanies(getDb());

  afterAll(() => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(dbFile + suffix, { force: true });
  });

  it("import 64 dòng; import lại file y hệt thì bỏ qua hết", async () => {
    const first = await importOrders(sample, "orders-sample.csv");
    expect(first).toMatchObject({ Status: "SUCCESS", TotalRows: 64, InsertedRows: 64, ErrorRows: 0 });
    const again = await importOrders(sample, "orders-sample.csv");
    expect(again).toMatchObject({ InsertedRows: 0, SkippedRows: 64 });
  });

  it("build → 174 event NEW", () => {
    const s = runBuildOrders();
    expect(s).toMatchObject({ Status: "SUCCESS", EventsCreated: 174, SkippedRows: 4, EventsError: 0 });
    expect(listEvents({ postStatus: "NEW" }).total).toBe(174);
  });

  it("build lại khi chưa post → thay thế, không nhân đôi", () => {
    const s = runBuildOrders();
    expect(s).toMatchObject({ EventsCreated: 0, EventsReplaced: 174 });
    expect(listEvents({}).total).toBe(174);
  });

  it("post All → Single không có gì, Bulk sinh 42 dòng GL cân Nợ/Có", () => {
    const [single, bulk] = runPost("All");
    expect(single.Status).toBe("NOTHING_TO_POST");
    expect(bulk).toMatchObject({ Status: "SUCCESS", PostedEvents: 174, Documents: 21, InsertedRows: 42 });
    const gl = listGl({ pageSize: 1000 });
    expect(gl.total).toBe(42);
    expect(gl.totals).toMatchObject({ AccountedDr: 6339.7, AccountedCr: 6339.7, Documents: 21 });
    expect(dashboardStats().events).toEqual({ POSTED: 174 });
  });

  it("export Excel đúng header sheet GlTrans", async () => {
    const buffer = await glWorkbook(allGl({}));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const ws = wb.getWorksheet("GlTrans")!;
    expect((ws.getRow(1).values as string[]).slice(1)).toEqual(GL_EXPORT_COLUMNS);
    expect(ws.rowCount).toBe(1 + 42 + 1);
  });

  it("build lại sau khi đã post → giữ nguyên event POSTED; import lại dòng đã build bị chặn", async () => {
    expect(runBuildOrders()).toMatchObject({ EventsCreated: 0, EventsReplaced: 0, EventsUnchangedPosted: 174 });
    const changed = Buffer.from(sample.toString("utf8").replace('"34,99","4,99","39,98"', '"35,99","4,99","40,98"'));
    const r = await importOrders(changed, "changed.csv");
    expect(r.ErrorRows).toBeGreaterThan(0);
    expect(r.errors[0].message).toContain("Unbuild");
  });

  it("unpost (preview rồi chạy thật) → GL xóa, event về NEW", () => {
    expect(unpost({ preview: true })).toMatchObject({ events: 174, glLines: 42, documents: 21 });
    unpost({});
    expect(listGl({}).total).toBe(0);
    expect(listEvents({ postStatus: "NEW" }).total).toBe(174);
  });

  it("unbuild → xóa event, raw về NOT_BUILT; build + post lại ra kết quả giống hệt", () => {
    const r = unbuild({});
    expect(r).toMatchObject({ deletedEvents: 174, rawRowsReset: 64 });
    expect(listEvents({}).total).toBe(0);
    expect(runBuildOrders().EventsCreated).toBe(174);
    const [, bulk] = runPost("All");
    expect(bulk.InsertedRows).toBe(42);
    expect(listGl({}).totals.AccountedDr).toBe(6339.7);
  });

  it("Unpost + Unbuild theo scope kỳ", () => {
    const preview = unbuild({ includePosted: true, preview: true, scope: { periodFrom: "202511", periodTo: "202511" } });
    expect(preview).toMatchObject({ deletedEvents: 174, postedEventsKept: 0 });
    unbuild({ includePosted: true, scope: { periodFrom: "202511", periodTo: "202511" } });
    expect(listGl({}).total).toBe(0);
    expect(listEvents({}).total).toBe(0);
  });
});

/**
 * Chạy cả luồng trên 1 file SQLite tạm: Import → Build → Post → Unpost → Unbuild → Build + Post lại.
 */
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterAll, describe, expect, it } from "vitest";

const dbFile = path.join(os.tmpdir(), `finance-test-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = dbFile;

/** Baseline đo trên toàn bộ file order thật — xem DEVELOPER_GUIDE §10.2 */
const ROWS = 55_112;
const VALID_ROWS = 55_111;
const EVENTS = 156_233;
const EVENTS_NEW = 153_845;
const EVENTS_ERROR = 2_388;
const DOCS = 3_397;
const GL_LINES = 6_794;
const GL_TOTAL = 4_013_848.04;

describe("luồng Orders → GLTrans trên DB", async () => {
  const { importOrders } = await import("@/lib/services/import-orders");
  const { runBuildOrders } = await import("@/lib/services/build");
  const { runPost } = await import("@/lib/services/post");
  const { unpost, unbuild } = await import("@/lib/services/clear");
  const { listGl, listEvents, dashboardStats } = await import("@/lib/services/queries");
  const { glWorkbook, GL_EXPORT_COLUMNS } = await import("@/lib/services/export");
  const { allGl } = await import("@/lib/services/queries");
  const { getDb, closeDb } = await import("@/lib/db/client");
  const { loadOrderRecords, oneRowCsv, seedTestCompanies, toCsv } = await import("../helpers/fixtures");
  seedTestCompanies(getDb());

  const { headers: allHeaders, records: allRecords } = await loadOrderRecords();
  const sample = toCsv(allHeaders, allRecords);

  afterAll(() => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(dbFile + suffix, { force: true });
  });

  it("import cả file thật; import lại y hệt thì bỏ qua hết", async () => {
    const first = await importOrders(sample, "order-data.csv");
    // 1 dòng rác trong file (dòng 27342 chỉ có StoreName + Profit) bị loại, không làm hỏng cả file
    expect(first).toMatchObject({ TotalRows: ROWS, InsertedRows: VALID_ROWS, ErrorRows: 1 });
    expect(first.errors[0]).toMatchObject({ row: 27_342, message: "Thiếu OrderId" });

    const again = await importOrders(sample, "order-data.csv");
    expect(again).toMatchObject({ InsertedRows: 0, ReplacedRows: 0, SkippedRows: VALID_ROWS, ErrorRows: 1 });
  });

  it("build → 156.233 event, 2.388 event ERROR do seller ngoài Partners", () => {
    const s = runBuildOrders();
    expect(s).toMatchObject({ Status: "SUCCESS", EventsCreated: EVENTS, SkippedRows: 2_674, EventsError: EVENTS_ERROR, ZeroAmountSkipped: 53_515 });
    expect(listEvents({ postStatus: "NEW" }).total).toBe(EVENTS_NEW);
  });

  it("build lại khi chưa post → thay thế, không nhân đôi", () => {
    const s = runBuildOrders();
    expect(s).toMatchObject({ EventsCreated: 0, EventsReplaced: EVENTS });
    expect(listEvents({}).total).toBe(EVENTS);
  });

  it("post All → Single không có gì, Bulk sinh 6.794 dòng GL cân Nợ/Có", () => {
    const [single, bulk] = runPost("All");
    expect(single.Status).toBe("NOTHING_TO_POST");
    expect(bulk).toMatchObject({ Status: "SUCCESS", PostedEvents: EVENTS_NEW, Documents: DOCS, InsertedRows: GL_LINES });
    const gl = listGl({ pageSize: 1 });
    expect(gl.total).toBe(GL_LINES);
    expect(gl.totals).toMatchObject({ AccountedDr: GL_TOTAL, AccountedCr: GL_TOTAL, Documents: DOCS });
    expect(dashboardStats().events).toEqual({ POSTED: EVENTS_NEW, ERROR: EVENTS_ERROR });
  });

  it("export Excel đúng header sheet GlTrans", async () => {
    const buffer = await glWorkbook(allGl({}));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const ws = wb.getWorksheet("GlTrans")!;
    expect((ws.getRow(1).values as string[]).slice(1)).toEqual(GL_EXPORT_COLUMNS);
    expect(ws.rowCount).toBe(1 + GL_LINES + 1);
  });

  it("build lại sau khi đã post → giữ nguyên event POSTED; import lại dòng đã build bị chặn", async () => {
    // 2.388 event ERROR (chưa post) vẫn được dựng lại mỗi lần Build; chỉ event POSTED mới giữ nguyên
    expect(runBuildOrders()).toMatchObject({ EventsCreated: 0, EventsReplaced: EVENTS_ERROR, EventsUnchangedPosted: EVENTS_NEW });
    // Sửa đúng 1 dòng đã ghi sổ rồi gửi lại header + dòng đó: đủ để kiểm chốt chặn, không phải import lại 55k dòng
    const changed = oneRowCsv(allHeaders, allRecords, (r) => r.OrderId === "MTUBV-181125-51MRR", { UnitPrice: "35.99" });
    const r = await importOrders(changed, "changed.csv");
    expect(r.TotalRows).toBe(1);
    expect(r.ErrorRows).toBe(1);
    expect(r.errors[0].message).toContain("Unbuild");
  });

  it("unpost (preview rồi chạy thật) → GL xóa, event về NEW", () => {
    expect(unpost({ preview: true })).toMatchObject({ events: EVENTS_NEW, glLines: GL_LINES, documents: DOCS });
    unpost({});
    expect(listGl({}).total).toBe(0);
    expect(listEvents({ postStatus: "NEW" }).total).toBe(EVENTS_NEW);
  });

  it("unbuild → xóa event, raw về NOT_BUILT; build + post lại ra kết quả giống hệt", () => {
    const r = unbuild({});
    expect(r).toMatchObject({ deletedEvents: EVENTS, rawRowsReset: VALID_ROWS });
    expect(listEvents({}).total).toBe(0);
    expect(runBuildOrders().EventsCreated).toBe(EVENTS);
    const [, bulk] = runPost("All");
    expect(bulk.InsertedRows).toBe(GL_LINES);
    expect(listGl({}).totals.AccountedDr).toBe(GL_TOTAL);
  });

  it("Unpost + Unbuild theo scope kỳ chỉ động vào kỳ đó, rồi toàn bộ", () => {
    // Dữ liệu thật trải 202511→202605 nên scope 1 kỳ phải để nguyên các kỳ khác
    const nov = { periodFrom: "202511", periodTo: "202511" };
    expect(unbuild({ includePosted: true, preview: true, scope: nov })).toMatchObject({ deletedEvents: 5_772, postedEventsKept: 0 });
    unbuild({ includePosted: true, scope: nov });
    expect(listEvents({}).total).toBe(EVENTS - 5_772);
    expect(listGl({}).total).toBeGreaterThan(0);

    // Lấy biên kỳ từ chính DB để không phải sửa test khi dữ liệu đổi
    const bounds = getDb().$client.prepare("SELECT min(Period) lo, max(Period) hi FROM AccountingEvent").get() as { lo: string; hi: string };
    unbuild({ includePosted: true, scope: { periodFrom: bounds.lo, periodTo: bounds.hi } });
    expect(listGl({}).total).toBe(0);
    expect(listEvents({}).total).toBe(0);
  });
});

/**
 * Master kỳ kế toán (services/periods.ts + /api/periods/**): lưới công ty × kỳ, xem trước việc dở, khóa / khóa đến hết kỳ,
 * mở khóa (tên + lý do), lịch sử, "Xóa dữ liệu test" bị từ chối khi còn kỳ khóa, Sync master không đụng bảng kỳ.
 * Việc Build/Post/Unpost/Unbuild/Import bỏ qua kỳ khóa được kiểm ở test khác; ở đây chỉ dùng Build để sinh tóm tắt INFO.
 *
 * Dữ liệu: tập con kịch bản 431 dòng thuần kỳ 202511 (tests/helpers/fixtures.ts) — 1.205 event, 50 CT / 100 dòng GL.
 */
import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import Papa from "papaparse";
import { afterAll, describe, expect, it } from "vitest";
import type { AccountingPeriodLogRow, AccountingPeriodRow } from "@/lib/db/schema";

const dbFile = path.join(os.tmpdir(), `finance-periods-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = dbFile;

const EVENTS = 1_205;
const DOCS = 50;
const GL_LINES = 100;
const GL_TOTAL = 43_227.58;
const P = "202511";
const ZEN = "ZENIROXPAY";
const ONT = "ONTARIO";
const TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
/** Khóa của ChecksSnapshot: PendingCheck bỏ ComCode/Period/Status (đã có trên dòng log) */
const SNAPSHOT_KEYS = ["balanced", "cr", "dr", "events", "glDocs", "glLines", "issues", "rawBySource", "rawError", "rawNoComCode", "rawNotBuilt"];

describe("kỳ kế toán: lưới, khóa, mở khóa, lịch sử", async () => {
  const { importOrders } = await import("@/lib/services/import-orders");
  const { importSourceFile } = await import("@/lib/services/import-source");
  const { runBuildOrders } = await import("@/lib/services/build");
  const { runPost } = await import("@/lib/services/post");
  const { resetTransactionalData } = await import("@/lib/services/clear");
  const { insertExceptions, loadPeriodLocks } = await import("@/lib/services/common");
  const { listPeriodGrid, listPeriodLog, lockPeriods, lockedPeriodSummary, unlockPeriod } = await import("@/lib/services/periods");
  const { readSnapshotTexts, replaceMasters } = await import("@/lib/db/seed");
  const { BadRequestError } = await import("@/lib/errors");
  const { lockKey } = await import("@/lib/engine/period-lock");
  const lockRoute = (await import("@/app/api/periods/lock/route")).POST;
  const unlockRoute = (await import("@/app/api/periods/unlock/route")).POST;
  const gridRoute = (await import("@/app/api/periods/route")).GET;
  const logRoute = (await import("@/app/api/periods/log/route")).GET;
  const { getDb, closeDb } = await import("@/lib/db/client");
  const { loadOrderRecords, scenarioRecords, seedTestCompanies, toCsv } = await import("../helpers/fixtures");
  seedTestCompanies(getDb());

  const { headers, records } = await loadOrderRecords();
  const sample = toCsv(headers, scenarioRecords(records));

  afterAll(() => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(dbFile + suffix, { force: true });
  });

  const sql = <T>(query: string, ...params: unknown[]) => getDb().$client.prepare(query).all(...params) as T[];
  const count = (query: string, ...params: unknown[]) => sql<{ n: number }>(`SELECT count(*) n FROM (${query})`, ...params)[0].n;
  const periodRow = (com: string, period: string) =>
    getDb().$client.prepare("SELECT * FROM AccountingPeriod WHERE ComCode = ? AND Period = ?").get(com, period) as AccountingPeriodRow | undefined;
  const periodRows = () => sql<AccountingPeriodRow>("SELECT * FROM AccountingPeriod ORDER BY ComCode, Period");
  const logRows = () => sql<AccountingPeriodLogRow>("SELECT * FROM AccountingPeriodLog ORDER BY ID");
  const cellOf = (grid: ReturnType<typeof listPeriodGrid>, com: string, period: string) => grid.cells.find((c) => c.ComCode === com && c.Period === period);
  const keysOf = (list: { ComCode: string; Period: string }[]) => list.map((t) => lockKey(t.ComCode, t.Period));
  const codesOf = (issues: { code: string }[]) => issues.map((i) => i.code);
  /** Lỗi BadRequestError kèm thông điệp khớp `message` */
  const badRequest = (fn: () => unknown, message: RegExp) => {
    let caught: unknown;
    try {
      fn();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestError);
    expect((caught as Error).message).toMatch(message);
  };
  const postJson = (handler: (req: Request) => Promise<Response>, url: string, body: unknown) =>
    handler(
      new Request(`http://localhost${url}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  const getJson = (handler: (req: NextRequest) => Promise<Response>, url: string) => handler(new NextRequest(`http://localhost${url}`));

  /** Số liệu raw Orders của ZENIROXPAY kỳ 202511 đếm thẳng bằng SQL để đối chiếu với lưới */
  const rawOrders = () =>
    sql<{ total: number; notBuilt: number; error: number }>(
      `SELECT count(*) total, coalesce(sum(BuildStatus = 'NOT_BUILT'), 0) notBuilt, coalesce(sum(BuildStatus = 'ERROR'), 0) error
       FROM RawOrders WHERE upper(trim(ComCode)) = ? AND substr(FulfilledAt, 1, 4) || substr(FulfilledAt, 6, 2) = ?`,
      ZEN,
      P,
    )[0];
  /** Raw cùng kỳ chưa xác định công ty (ComCode trống) mà chưa build / lỗi — lưới báo riêng ở `unassigned` */
  const rawNoComCode = () =>
    count(
      `SELECT 1 FROM RawOrders WHERE trim(coalesce(ComCode, '')) = '' AND BuildStatus IN ('NOT_BUILT', 'ERROR')
       AND substr(FulfilledAt, 1, 4) || substr(FulfilledAt, 6, 2) = ?`,
      P,
    );

  it("DB mới: lưới rỗng, đủ công ty; lọc đủ kỳ từ–đến thì hiện mọi tháng để khóa trước", () => {
    const grid = listPeriodGrid();
    expect(grid).toMatchObject({ cells: [], periods: [], unassigned: [], lockedCount: 0 });
    expect(grid.companies).toEqual([
      { ComCode: ONT, CompanyName: "Ontario", FunctionalCurrency: "USD", InCompanyTable: true },
      { ComCode: ZEN, CompanyName: "ZeniroxPay Inc.", FunctionalCurrency: "USD", InCompanyTable: true },
    ]);
    expect(listPeriodGrid({ periodFrom: "202511", periodTo: "202602" }).periods).toEqual(["202602", "202601", "202512", "202511"]);
    expect(listPeriodGrid({ comCode: " ontario " }).companies.map((c) => c.ComCode)).toEqual([ONT]);
    badRequest(() => listPeriodGrid({ periodFrom: "2025-11" }), /YYYYMM/);
  });

  it("import + build: ô ZENIROXPAY 202511 OPEN, event NEW, chưa có GL, số raw khớp SQL", async () => {
    expect(await importOrders(sample, "subset.csv")).toMatchObject({ Status: "SUCCESS", TotalRows: 431, InsertedRows: 431, ErrorRows: 0, LockedRows: 0 });
    expect(runBuildOrders()).toMatchObject({ Status: "SUCCESS", EventsCreated: EVENTS, LockedSkipped: 0, LockedConflicts: 0, LockedRows: 0, LockedPeriods: [] });

    const grid = listPeriodGrid();
    expect(grid.cells.map((c) => lockKey(c.ComCode, c.Period))).toEqual([`${ZEN}|${P}`]);
    expect(grid.periods).toEqual([P]);
    const raw = rawOrders();
    // 403 dòng đã giao (còn lại chưa giao → không có kỳ), build hết không lỗi
    expect(raw).toEqual({ total: 403, notBuilt: 0, error: 0 });
    const cell = cellOf(grid, ZEN, P)!;
    expect(cell).toMatchObject({
      Status: "OPEN",
      HasRow: false,
      LockedBy: null,
      LockedAt: null,
      events: { NEW: EVENTS, ERROR: 0, POSTED: 0, SKIPPED: 0 },
      glLines: 0,
      glDocs: 0,
      dr: 0,
      cr: 0,
      balanced: true,
      rawNotBuilt: raw.notBuilt,
      rawError: raw.error,
      rawBySource: {
        ORDERS: { total: raw.total, notBuilt: raw.notBuilt, error: raw.error },
        PAYPAL: { total: 0, notBuilt: 0, error: 0 },
        STRIPE: { total: 0, notBuilt: 0, error: 0 },
        PIPO: { total: 0, notBuilt: 0, error: 0 },
      },
    });
    expect(cell.issues.find((i) => i.code === "EVENTS_NEW")).toMatchObject({ count: EVENTS });
    expect(codesOf(cell.issues)).not.toContain("NO_DATA");
    // Raw không có ComCode không thành ô của công ty nào mà báo riêng
    expect(grid.unassigned.reduce((n, u) => n + u.NotBuilt + u.Error, 0)).toBe(rawNoComCode());
  });

  it("xem trước khóa: liệt kê việc dở (event NEW chưa post), khóa đến hết kỳ gồm kỳ có dữ liệu ≤ P; không ghi gì", () => {
    const preview = lockPeriods({ targets: [{ comCode: " zeniroxpay ", period: " 202511 " }], preview: true });
    expect(preview).toMatchObject({ preview: true, alreadyLocked: [] });
    expect(keysOf(preview.targets)).toEqual([`${ZEN}|${P}`]);
    const [t] = preview.targets;
    expect(t).toMatchObject({ Status: "OPEN", events: { NEW: EVENTS }, glLines: 0, rawNoComCode: rawNoComCode() });
    expect(t.issues.find((i) => i.code === "EVENTS_NEW")).toMatchObject({ count: EVENTS });

    // Khóa đến hết 202512: kỳ có dữ liệu 202511 + chính 202512 (chưa có dữ liệu → NO_DATA)
    const through = lockPeriods({ comCodes: [ZEN], throughPeriod: "202512", preview: true });
    expect(keysOf(through.targets)).toEqual([`${ZEN}|${P}`, `${ZEN}|202512`]);
    expect(codesOf(through.targets[1].issues)).toContain("NO_DATA");
    // Khóa đến hết 202510: kỳ có dữ liệu sau P không bị kéo vào
    expect(keysOf(lockPeriods({ comCodes: [ZEN], throughPeriod: "202510", preview: true }).targets)).toEqual([`${ZEN}|202510`]);

    expect(periodRows()).toEqual([]);
    expect(logRows()).toEqual([]);
  });

  it("khóa thiếu tên / tên quá dài / ghi chú quá dài → BadRequestError, không ghi", () => {
    const targets = [{ comCode: ZEN, period: P }];
    badRequest(() => lockPeriods({ targets }), /Nhập tên người thao tác/);
    badRequest(() => lockPeriods({ targets, actor: "   " }), /Nhập tên người thao tác/);
    badRequest(() => lockPeriods({ targets, actor: "x".repeat(101) }), /tối đa 100/);
    badRequest(() => lockPeriods({ targets, actor: "Kế toán A", note: "n".repeat(501) }), /Ghi chú tối đa 500/);
    expect(periodRows()).toEqual([]);
    expect(logRows()).toEqual([]);
  });

  it("post: ô có GL 100 dòng / 50 CT, Σ Nợ = Σ Có, hết việc dở event", () => {
    expect(runPost("All")[1]).toMatchObject({ Status: "SUCCESS", PostedEvents: EVENTS, Documents: DOCS, InsertedRows: GL_LINES, LockedEvents: 0, LockedPeriods: [] });
    const [gl] = sql<{ lines: number; docs: number }>("SELECT count(*) lines, count(DISTINCT DocNum) docs FROM GLTrans WHERE ComCode = ? AND Period = ?", ZEN, P);
    expect(gl).toEqual({ lines: GL_LINES, docs: DOCS });

    const cell = cellOf(listPeriodGrid({ comCode: ZEN, periodFrom: P, periodTo: P }), ZEN, P)!;
    expect(cell).toMatchObject({
      Status: "OPEN",
      events: { NEW: 0, ERROR: 0, POSTED: EVENTS, SKIPPED: 0 },
      glLines: GL_LINES,
      glDocs: DOCS,
      dr: GL_TOTAL,
      cr: GL_TOTAL,
      balanced: true,
    });
    expect(codesOf(cell.issues)).not.toContain("EVENTS_NEW");
    expect(codesOf(cell.issues)).not.toContain("GL_IMBALANCED");
  });

  it("khóa: ghi dòng LOCKED (tên, giờ, ghi chú) + đúng 1 dòng log kèm ChecksSnapshot", () => {
    const res = lockPeriods({ targets: [{ comCode: "zeniroxpay", period: P }], actor: "  Kế toán A  ", note: " Chốt sổ T11 " });
    expect(res).toMatchObject({ preview: false, locked: [{ ComCode: ZEN, Period: P }], alreadyLocked: [] });
    expect(res.targets[0]).toMatchObject({ glLines: GL_LINES, dr: GL_TOTAL });

    const row = periodRow(ZEN, P)!;
    expect(row).toMatchObject({ Status: "LOCKED", LockedBy: "Kế toán A", Note: "Chốt sổ T11", UnlockedBy: null, UnlockedAt: null, UnlockReason: null });
    expect(row.LockedAt).toMatch(TS);
    expect(row.ModifiedDate).toBe(row.LockedAt);

    const logs = logRows();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      ComCode: ZEN,
      Period: P,
      Action: "LOCK",
      FromStatus: "OPEN",
      ToStatus: "LOCKED",
      ActorName: "Kế toán A",
      Reason: "Chốt sổ T11",
      CreatedAt: row.LockedAt,
    });
    const snapshot = JSON.parse(logs[0].ChecksSnapshot!);
    expect(Object.keys(snapshot).sort()).toEqual(SNAPSHOT_KEYS);
    expect(snapshot).toMatchObject({ glLines: GL_LINES, glDocs: DOCS, dr: GL_TOTAL, cr: GL_TOTAL, balanced: true, events: { POSTED: EVENTS, NEW: 0 } });
    expect(codesOf(snapshot.issues)).not.toContain("EVENTS_NEW");

    const grid = listPeriodGrid();
    expect(cellOf(grid, ZEN, P)).toMatchObject({ Status: "LOCKED", HasRow: true, LockedBy: "Kế toán A", Note: "Chốt sổ T11" });
    expect(grid.lockedCount).toBe(1);
    expect(lockedPeriodSummary()).toEqual({ count: 1, keys: [`${ZEN}|${P}`] });
  });

  it("khóa lại kỳ đã khóa → alreadyLocked, không ghi đè người khóa, không thêm log", () => {
    const targets = [{ comCode: ZEN, period: P }];
    expect(lockPeriods({ targets, preview: true })).toEqual({ preview: true, targets: [], alreadyLocked: [{ ComCode: ZEN, Period: P }] });
    expect(lockPeriods({ targets, actor: "Người khác" })).toEqual({ preview: false, locked: [], alreadyLocked: [{ ComCode: ZEN, Period: P }], targets: [] });
    expect(periodRow(ZEN, P)).toMatchObject({ Status: "LOCKED", LockedBy: "Kế toán A" });
    expect(logRows()).toHaveLength(1);
  });

  it("khóa đến hết kỳ 202512 cho 2 công ty: khóa kỳ ≤ P có dữ liệu + chính P, bỏ qua kỳ đã khóa", () => {
    const req = { comCodes: ["zeniroxpay", ONT, " ontario "], throughPeriod: "202512" };
    const preview = lockPeriods({ ...req, preview: true });
    expect(keysOf(preview.targets)).toEqual([`${ONT}|202512`, `${ZEN}|202512`]);
    expect(keysOf(preview.alreadyLocked)).toEqual([`${ZEN}|${P}`]);

    const res = lockPeriods({ ...req, actor: "Kế toán A" });
    expect(res).toMatchObject({
      preview: false,
      locked: [
        { ComCode: ONT, Period: "202512" },
        { ComCode: ZEN, Period: "202512" },
      ],
      alreadyLocked: [{ ComCode: ZEN, Period: P }],
    });
    expect(periodRows().map((r) => [r.ComCode, r.Period, r.Status])).toEqual([
      [ONT, "202512", "LOCKED"],
      [ZEN, P, "LOCKED"],
      [ZEN, "202512", "LOCKED"],
    ]);
    const logs = logRows();
    expect(logs).toHaveLength(3);
    expect(logs.slice(1).map((l) => [l.ComCode, l.Period, l.Action, l.FromStatus, l.ToStatus])).toEqual([
      [ONT, "202512", "LOCK", "OPEN", "LOCKED"],
      [ZEN, "202512", "LOCK", "OPEN", "LOCKED"],
    ]);
    expect(codesOf(JSON.parse(logs[1].ChecksSnapshot!).issues)).toEqual(["NO_DATA"]);
    expect(loadPeriodLocks(getDb()).keys).toEqual([`${ONT}|202512`, `${ZEN}|${P}`, `${ZEN}|202512`]);
  });

  it("đầu vào khóa sai → BadRequestError (kỳ 202513, công ty lạ, chọn cả 2 cách / không chọn), không ghi", () => {
    const actor = "Kế toán A";
    badRequest(() => lockPeriods({ targets: [{ comCode: ZEN, period: "202513" }], actor }), /Kỳ "202513" của ZENIROXPAY không hợp lệ/);
    badRequest(() => lockPeriods({ targets: [{ comCode: ZEN, period: "202500" }], preview: true }), /không hợp lệ/);
    badRequest(() => lockPeriods({ targets: [{ comCode: ZEN, period: "2025-11" }], actor }), /không hợp lệ/);
    badRequest(() => lockPeriods({ comCodes: [ZEN], throughPeriod: "202513", actor }), /Kỳ "202513" không hợp lệ/);
    badRequest(() => lockPeriods({ comCodes: [ZEN], actor }), /không hợp lệ/);
    badRequest(() => lockPeriods({ throughPeriod: "202512", actor }), /Chọn ít nhất 1 công ty/);
    badRequest(() => lockPeriods({ targets: [{ comCode: "NOPE", period: P }], actor }), /Công ty NOPE không có trong danh mục Company/);
    badRequest(() => lockPeriods({ comCodes: ["NOPE"], throughPeriod: "202512", actor }), /NOPE không có trong danh mục Company/);
    badRequest(() => lockPeriods({ targets: [{ comCode: "", period: P }], actor }), /Thiếu ComCode/);
    // Nhiều lỗi gộp bằng "; "
    badRequest(
      () =>
        lockPeriods({
          targets: [
            { comCode: "NOPE", period: P },
            { comCode: ONT, period: "202513" },
          ],
          actor,
        }),
      /NOPE không có trong danh mục Company; Kỳ "202513" của ONTARIO không hợp lệ/,
    );
    badRequest(() => lockPeriods({ targets: [{ comCode: ONT, period: P }], comCodes: [ONT], throughPeriod: "202512", actor }), /Chỉ chọn 1 cách/);
    badRequest(() => lockPeriods({ actor }), /Chưa chọn kỳ cần khóa/);
    badRequest(() => lockPeriods({ targets: [], comCodes: [], actor }), /Chưa chọn kỳ cần khóa/);
    expect(periodRows()).toHaveLength(3);
    expect(logRows()).toHaveLength(3);
  });

  it("mở khóa sai đầu vào → BadRequestError (lý do ngắn, thiếu tên, kỳ đang mở, kỳ sai), kỳ vẫn khóa", () => {
    const base = { comCode: ZEN, period: P, actor: "Kế toán B" };
    badRequest(() => unlockPeriod({ ...base, reason: "quá ngắn" }), /Lý do mở khóa tối thiểu 10 ký tự/);
    // Lý do tính sau khi trim
    badRequest(() => unlockPeriod({ ...base, reason: "   123456789   " }), /tối thiểu 10/);
    badRequest(() => unlockPeriod({ ...base, reason: null }), /tối thiểu 10/);
    badRequest(() => unlockPeriod({ ...base, reason: "r".repeat(501) }), /tối đa 500/);
    badRequest(() => unlockPeriod({ ...base, actor: " ", reason: "Nhận sao kê bổ sung" }), /Nhập tên người thao tác/);
    // Kỳ đang OPEN (có hoặc chưa có dòng AccountingPeriod), kể cả chỉ xem trước
    badRequest(() => unlockPeriod({ comCode: ONT, period: P, actor: "Kế toán B", reason: "Nhận sao kê bổ sung" }), /ONTARIO kỳ 202511 đang không khóa/);
    badRequest(() => unlockPeriod({ comCode: ONT, period: P, preview: true }), /đang không khóa/);
    badRequest(() => unlockPeriod({ comCode: ZEN, period: "202513", preview: true }), /không hợp lệ/);
    badRequest(() => unlockPeriod({ period: P, preview: true }), /Thiếu ComCode/);

    expect(periodRow(ZEN, P)).toMatchObject({ Status: "LOCKED", UnlockedBy: null });
    expect(logRows()).toHaveLength(3);
  });

  it("xem trước mở khóa: báo kỳ sau còn khóa + số liệu kỳ, không ghi", () => {
    const preview = unlockPeriod({ comCode: "zeniroxpay", period: P, preview: true });
    expect(preview).toMatchObject({ preview: true, ComCode: ZEN, Period: P, laterLockedPeriods: ["202512"], row: { Status: "LOCKED", LockedBy: "Kế toán A" } });
    expect(preview.check).toMatchObject({ ComCode: ZEN, Period: P, Status: "LOCKED", glLines: GL_LINES, glDocs: DOCS, dr: GL_TOTAL, cr: GL_TOTAL });
    expect(unlockPeriod({ comCode: ZEN, period: "202512", preview: true })).toMatchObject({ laterLockedPeriods: [] });
    expect(periodRow(ZEN, P)?.Status).toBe("LOCKED");
    expect(logRows()).toHaveLength(3);
  });

  it("Build khi kỳ khóa ghi tóm tắt INFO; mở khóa → OPEN + tên/lý do + log UNLOCK, dọn đúng tóm tắt INFO của kỳ đó", () => {
    expect(runBuildOrders()).toMatchObject({ Status: "SUCCESS", LockedSkipped: EVENTS, LockedPeriods: [`${ZEN}|${P}`] });
    const summaries = () =>
      sql<{ BatchType: string; ComCode: string; Period: string; Severity: string; SourceKey: string }>(
        "SELECT BatchType, ComCode, Period, Severity, SourceKey FROM ExceptionLog WHERE ExceptionType = 'PERIOD_LOCKED' ORDER BY ID",
      );
    expect(summaries()).toEqual([{ BatchType: "BUILD", ComCode: ZEN, Period: P, Severity: "INFO", SourceKey: `PERIOD_LOCKED|ORDERS|${ZEN}|${P}` }]);

    // Thêm: tóm tắt của Post (BatchID null) cùng kỳ → cũng dọn; tóm tắt kỳ / công ty khác và ERROR PERIOD_LOCKED → giữ
    const draft = (ComCode: string, Period: string, Severity: "INFO" | "ERROR", SourceKey: string) => ({
      DataSource: "ORDERS",
      ComCode,
      Period,
      Severity,
      ExceptionType: "PERIOD_LOCKED" as const,
      SourceKey,
      Message: "test",
    });
    insertExceptions(getDb(), "POST", null, [
      draft(ZEN, P, "INFO", `PERIOD_LOCKED|ORDERS|${ZEN}|${P}`),
      draft(ZEN, "202512", "INFO", `PERIOD_LOCKED|ORDERS|${ZEN}|202512`),
      draft(ONT, P, "INFO", `PERIOD_LOCKED|ORDERS|${ONT}|${P}`),
      draft(ONT, P, "ERROR", "SO-1|PRODUCT"),
    ]);

    const res = unlockPeriod({ comCode: ZEN, period: P, actor: " Kế toán B ", reason: "  Nhận sao kê bổ sung tháng 11  " });
    expect(res).toMatchObject({
      preview: false,
      ComCode: ZEN,
      Period: P,
      laterLockedPeriods: ["202512"],
      removedSummaries: 2,
      check: { Status: "LOCKED", glLines: GL_LINES },
    });
    expect(summaries()).toEqual([
      { BatchType: "POST", ComCode: ZEN, Period: "202512", Severity: "INFO", SourceKey: `PERIOD_LOCKED|ORDERS|${ZEN}|202512` },
      { BatchType: "POST", ComCode: ONT, Period: P, Severity: "INFO", SourceKey: `PERIOD_LOCKED|ORDERS|${ONT}|${P}` },
      { BatchType: "POST", ComCode: ONT, Period: P, Severity: "ERROR", SourceKey: "SO-1|PRODUCT" },
    ]);

    const row = periodRow(ZEN, P)!;
    // Giữ vết lần khóa gần nhất (LockedBy, Note) cạnh lần mở khóa
    expect(row).toMatchObject({
      Status: "OPEN",
      UnlockedBy: "Kế toán B",
      UnlockReason: "Nhận sao kê bổ sung tháng 11",
      LockedBy: "Kế toán A",
      Note: "Chốt sổ T11",
    });
    expect(row.UnlockedAt).toMatch(TS);
    expect(row.ModifiedDate).toBe(row.UnlockedAt);

    const logs = logRows();
    expect(logs).toHaveLength(4);
    expect(logs[3]).toMatchObject({
      ComCode: ZEN,
      Period: P,
      Action: "UNLOCK",
      FromStatus: "LOCKED",
      ToStatus: "OPEN",
      ActorName: "Kế toán B",
      Reason: "Nhận sao kê bổ sung tháng 11",
      CreatedAt: row.UnlockedAt,
    });
    const snapshot = JSON.parse(logs[3].ChecksSnapshot!);
    expect(Object.keys(snapshot).sort()).toEqual(SNAPSHOT_KEYS);
    expect(snapshot).toMatchObject({ glLines: GL_LINES, dr: GL_TOTAL });

    const grid = listPeriodGrid();
    expect(cellOf(grid, ZEN, P)).toMatchObject({ Status: "OPEN", HasRow: true, UnlockedBy: "Kế toán B" });
    expect(grid.lockedCount).toBe(2);
    expect(loadPeriodLocks(getDb()).isLocked({ ComCode: ZEN, Period: P })).toBe(false);

    // Mở khóa lần nữa: kỳ đã OPEN
    badRequest(() => unlockPeriod({ comCode: ZEN, period: P, actor: "Kế toán B", reason: "Nhận sao kê bổ sung tháng 11" }), /đang không khóa/);
    expect(logRows()).toHaveLength(4);
  });

  it("khóa lại sau khi mở: dòng cũ OPEN → LOCKED, log FromStatus OPEN", () => {
    expect(lockPeriods({ targets: [{ comCode: ZEN, period: P }], actor: "Kế toán C" })).toMatchObject({ locked: [{ ComCode: ZEN, Period: P }] });
    expect(periodRow(ZEN, P)).toMatchObject({ Status: "LOCKED", LockedBy: "Kế toán C", Note: null });
    const logs = logRows();
    expect(logs).toHaveLength(5);
    expect(logs[4]).toMatchObject({ Action: "LOCK", FromStatus: "OPEN", ToStatus: "LOCKED", ActorName: "Kế toán C", Reason: null });
  });

  it("lịch sử: mới nhất trước, lọc công ty / kỳ / khoảng kỳ / hành động, phân trang", () => {
    const all = listPeriodLog();
    expect(all.total).toBe(5);
    expect(all.rows.map((r) => r.ID)).toEqual([5, 4, 3, 2, 1]);

    const zen = listPeriodLog({ comCode: " zeniroxpay ", period: P });
    expect(zen.total).toBe(3);
    expect(zen.rows.map((r) => r.Action)).toEqual(["LOCK", "UNLOCK", "LOCK"]);
    expect(listPeriodLog({ action: "unlock" }).rows.map((r) => [r.ComCode, r.Period, r.ActorName])).toEqual([[ZEN, P, "Kế toán B"]]);
    expect(listPeriodLog({ periodFrom: "202512" }).rows.map((r) => lockKey(r.ComCode, r.Period))).toEqual([`${ZEN}|202512`, `${ONT}|202512`]);
    expect(listPeriodLog({ periodTo: P }).total).toBe(3);
    expect(listPeriodLog({ comCode: ONT, action: "LOCK" }).total).toBe(1);

    expect(listPeriodLog({ pageSize: 2, page: 1 })).toMatchObject({ total: 5 });
    expect(listPeriodLog({ pageSize: 2, page: 1 }).rows.map((r) => r.ID)).toEqual([5, 4]);
    expect(listPeriodLog({ pageSize: 2, page: 3 }).rows.map((r) => r.ID)).toEqual([1]);
    expect(listPeriodLog({ pageSize: 2, page: 4 }).rows).toEqual([]);
    expect(listPeriodLog({ pageSize: 10_000 }).rows).toHaveLength(5);

    badRequest(() => listPeriodLog({ action: "DELETE" }), /Action "DELETE" không hợp lệ/);
    badRequest(() => listPeriodLog({ period: "2025-11" }), /YYYYMM/);
    badRequest(() => listPeriodLog({ periodFrom: "2025" }), /YYYYMM/);
  });

  it("route handler: lỗi đầu vào → 400 { error }, hợp lệ → 200 JSON", async () => {
    const lock = (body: unknown) => postJson(lockRoute, "/api/periods/lock", body);
    const unlock = (body: unknown) => postJson(unlockRoute, "/api/periods/unlock", body);
    const expect400 = async (res: Promise<Response>, message: RegExp) => {
      const r = await res;
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toMatch(message);
    };

    await expect400(lock("không phải JSON"), /Chưa chọn kỳ cần khóa/);
    await expect400(lock({ targets: "x" }), /Chưa chọn kỳ cần khóa/);
    await expect400(lock({ targets: [null, 5] }), /Thiếu ComCode/);
    await expect400(lock({ targets: [{ comCode: ONT, period: "202513" }], preview: true }), /không hợp lệ/);
    await expect400(lock({ targets: [{ comCode: ONT, period: P }] }), /Nhập tên người thao tác/);
    await expect400(lock({ comCodes: ["NOPE"], throughPeriod: "202512", actor: "A" }), /NOPE không có trong danh mục Company/);
    await expect400(unlock({ comCode: ZEN, period: P, actor: "Kế toán B", reason: "ngắn" }), /Lý do mở khóa tối thiểu 10 ký tự/);
    await expect400(unlock({ comCode: ONT, period: P, preview: "true" }), /đang không khóa/);
    await expect400(getJson(gridRoute, "/api/periods?periodFrom=2025"), /YYYYMM/);
    await expect400(getJson(logRoute, "/api/periods/log?action=DELETE"), /không hợp lệ/);

    const preview = await lock({ targets: [{ comCode: "ontario", period: P }, { comCode: ZEN, period: P }], preview: "true" });
    expect(preview.status).toBe(200);
    const pj = (await preview.json()) as { preview: boolean; targets: { ComCode: string; Period: string }[]; alreadyLocked: { ComCode: string; Period: string }[] };
    expect(pj.preview).toBe(true);
    expect(keysOf(pj.targets)).toEqual([`${ONT}|${P}`]);
    expect(keysOf(pj.alreadyLocked)).toEqual([`${ZEN}|${P}`]);

    const unlockPreview = await unlock({ comCode: "zeniroxpay", period: P, preview: true });
    expect(unlockPreview.status).toBe(200);
    expect(await unlockPreview.json()).toMatchObject({ preview: true, ComCode: ZEN, Period: P, laterLockedPeriods: ["202512"] });

    const grid = await getJson(gridRoute, "/api/periods?comCode=zeniroxpay&periodFrom=202511&periodTo=202512");
    expect(grid.status).toBe(200);
    const gj = (await grid.json()) as {
      periods: string[];
      companies: { ComCode: string }[];
      cells: { ComCode: string; Period: string; Status: string }[];
      lockedCount: number;
    };
    expect(gj.periods).toEqual(["202512", P]);
    expect(gj.companies.map((c) => c.ComCode)).toEqual([ZEN]);
    expect(gj.cells.map((c) => [c.ComCode, c.Period, c.Status])).toEqual([
      [ZEN, "202512", "LOCKED"],
      [ZEN, P, "LOCKED"],
    ]);
    expect(gj.lockedCount).toBe(3);

    const log = await getJson(logRoute, "/api/periods/log?comCode=zeniroxpay&period=202511&pageSize=1&page=2");
    expect(log.status).toBe(200);
    expect(await log.json()).toMatchObject({ total: 3, rows: [{ ID: 4, Action: "UNLOCK" }] });

    // Không lệnh nào ở trên ghi gì
    expect(periodRows().filter((r) => r.Status === "LOCKED")).toHaveLength(3);
    expect(logRows()).toHaveLength(5);
  });

  it("Xóa dữ liệu test bị từ chối khi còn kỳ khóa; mở hết khóa thì xóa được, bảng kỳ + lịch sử còn nguyên", () => {
    badRequest(() => resetTransactionalData(), /Còn 3 kỳ đang khóa sổ \(ONTARIO kỳ 202512, ZENIROXPAY kỳ 202511, ZENIROXPAY kỳ 202512\)/);
    // Bị từ chối trong transaction → không bảng nào bị xóa
    expect(count("SELECT 1 FROM GLTrans")).toBe(GL_LINES);
    expect(count("SELECT 1 FROM AccountingEvent")).toBe(EVENTS);
    expect(count("SELECT 1 FROM RawOrders")).toBe(431);

    const reason = "Dọn dữ liệu test cuối ngày";
    for (const [comCode, period] of [
      [ONT, "202512"],
      [ZEN, "202512"],
      [ZEN, P],
    ]) {
      expect(unlockPeriod({ comCode, period, actor: "Kế toán B", reason })).toMatchObject({ preview: false });
    }
    const before = { periods: periodRows(), logs: logRows() };
    expect(before.logs).toHaveLength(8);

    resetTransactionalData();
    for (const t of ["GLTrans", "AccountingEvent", "RawOrders", "ExceptionLog", "ImportBatch", "BuildBatch", "PostingBatch"]) {
      expect(count(`SELECT 1 FROM "${t}"`), t).toBe(0);
    }
    expect(periodRows()).toEqual(before.periods);
    expect(logRows()).toEqual(before.logs);

    // Lưới sau khi xóa: chỉ còn ô có dòng AccountingPeriod, OPEN, chưa có dữ liệu
    const grid = listPeriodGrid();
    expect(grid.lockedCount).toBe(0);
    expect(grid.cells.map((c) => [c.ComCode, c.Period, c.Status, c.HasRow])).toEqual([
      [ONT, "202512", "OPEN", true],
      [ZEN, "202512", "OPEN", true],
      [ZEN, P, "OPEN", true],
    ]);
    for (const c of grid.cells) expect(codesOf(c.issues)).toEqual(["NO_DATA"]);
  });

  it("Sync master (replaceMasters) không đụng AccountingPeriod / AccountingPeriodLog, kỳ khóa vẫn còn hiệu lực", () => {
    lockPeriods({ targets: [{ comCode: ZEN, period: P }], actor: "Kế toán A", note: "Khóa trước khi Sync" });
    const before = { periods: periodRows(), logs: logRows() };
    expect(before.logs).toHaveLength(9);

    const counts = replaceMasters(getDb(), readSnapshotTexts());
    expect(counts.journalType).toBeGreaterThan(0);
    expect(periodRows()).toEqual(before.periods);
    expect(logRows()).toEqual(before.logs);
    expect(loadPeriodLocks(getDb()).keys).toEqual([`${ZEN}|${P}`]);
    badRequest(() => resetTransactionalData(), /Còn 1 kỳ đang khóa sổ/);
  });

  describe("việc dở theo nguồn: raw chưa build / lỗi / chưa có công ty, ComCode lạ, sổ lệch (kỳ 202512 đang mở)", () => {
    const D = "202512";
    const fulfilled = scenarioRecords(records).filter((r) => r.ItemStatus?.trim().toUpperCase() === "FULFILLED");
    const toDecember = (r: Record<string, string>, patch: Record<string, string> = {}) => ({
      ...r,
      FulfilledAt: r.FulfilledAt.replace(/^\d{4}-\d{2}-\d{2}/, "2025-12-05"),
      ...patch,
    });
    const [mapped, unmapped, ghost] = [...new Map(fulfilled.map((r) => [r.OrderId, r])).values()].slice(0, 3);
    const noCom = (u: { NotBuilt: number; Error: number }[]) => u.reduce((n, x) => n + x.NotBuilt + x.Error, 0);

    it("import (chưa build): dòng Orders + Stripe có ComCode vào ô công ty, dòng thiếu ComCode vào unassigned, ComCode lạ thành cột riêng", async () => {
      // 3 dòng Orders giao ngày 05/12: cổng có mapping, cổng không mapping (ComCode trống), cổng có mapping rồi sửa tay ComCode lạ
      const orders = toCsv(headers, [toDecember(mapped), toDecember(unmapped, { PaymentGatewayName: "Zenirox Pay SPF-BDU" }), toDecember(ghost)]);
      expect(await importOrders(orders, "december.csv")).toMatchObject({ Status: "SUCCESS", InsertedRows: 3, ErrorRows: 0, LockedRows: 0 });
      getDb().$client.prepare("UPDATE RawOrders SET ComCode = ' ghost ' WHERE OrderId = ?").run(ghost.OrderId);

      // 2 dòng Stripe ngày 03–04/12: 1 dòng ComCode ZENIROXPAY, 1 dòng ComCode trống
      const stripe = Papa.parse<Record<string, string>>(readFileSync(path.join(process.cwd(), "data", "samples", "Bank_Stripe.csv"), "utf8"), {
        header: true,
        skipEmptyLines: true,
      });
      const [s1, s2] = stripe.data.filter((r) => r.ComCode === ZEN && r.Type === "charge");
      const stripeCsv = Papa.unparse(
        [
          { ...s1, Date: "2025-12-03" },
          { ...s2, Date: "2025-12-04", ComCode: "" },
        ],
        { columns: stripe.meta.fields },
      );
      expect(await importSourceFile("stripe", Buffer.from(stripeCsv, "utf8"), "december-stripe.csv")).toMatchObject({ InsertedRows: 2, ErrorRows: 0, LockedRows: 0 });

      const grid = listPeriodGrid();
      expect(cellOf(grid, ZEN, D)).toMatchObject({
        Status: "OPEN",
        HasRow: true,
        rawNotBuilt: 2,
        rawError: 0,
        rawBySource: {
          ORDERS: { notBuilt: 1, error: 0, total: 1 },
          STRIPE: { notBuilt: 1, error: 0, total: 1 },
          PAYPAL: { notBuilt: 0, error: 0, total: 0 },
          PIPO: { notBuilt: 0, error: 0, total: 0 },
        },
      });
      expect(cellOf(grid, ZEN, D)!.issues.map((i) => [i.code, i.count])).toEqual([["RAW_NOT_BUILT", 2]]);
      expect(grid.unassigned).toEqual([
        { Period: D, DataSource: "ORDERS", NotBuilt: 1, Error: 0 },
        { Period: D, DataSource: "STRIPE", NotBuilt: 1, Error: 0 },
      ]);
      // ComCode chỉ có trong dữ liệu: hiện thành cột, không khóa được
      expect(grid.companies.find((c) => c.ComCode === "GHOST")).toEqual({ ComCode: "GHOST", CompanyName: null, FunctionalCurrency: null, InCompanyTable: false });
      expect(cellOf(grid, "GHOST", D)).toMatchObject({ rawNotBuilt: 1, rawBySource: { ORDERS: { notBuilt: 1, total: 1 } } });
      badRequest(() => lockPeriods({ targets: [{ comCode: "ghost", period: D }], preview: true }), /GHOST không có trong danh mục Company/);
      // Lọc 1 công ty: raw thiếu ComCode vẫn được báo, công ty khác không hiện
      const onlyZen = listPeriodGrid({ comCode: ZEN });
      expect(onlyZen.companies.map((c) => c.ComCode)).toEqual([ZEN]);
      expect(onlyZen.cells.every((c) => c.ComCode === ZEN)).toBe(true);
      expect(noCom(onlyZen.unassigned)).toBe(2);

      const [check] = lockPeriods({ targets: [{ comCode: ZEN, period: D }], preview: true }).targets;
      expect(check).toMatchObject({ rawNotBuilt: 2, rawNoComCode: 2 });
      expect(check.issues.map((i) => [i.code, i.count])).toEqual([
        ["RAW_NOT_BUILT", 2],
        ["RAW_NO_COMCODE", 2],
      ]);
    });

    it("build + post Orders: dòng không mapping thành raw ERROR chưa có công ty; sổ bị sửa lệch → GL_IMBALANCED", () => {
      const build = runBuildOrders();
      expect(build).toMatchObject({ Status: "SUCCESS", LockedSkipped: 0, LockedRows: 0 });
      expect(build.EventsCreated).toBeGreaterThan(0);
      const posted = runPost("All").reduce((n, r) => n + r.PostedEvents, 0);
      expect(posted).toBe(build.EventsCreated);

      const [gl] = sql<{ lines: number; docs: number; dr: number }>(
        "SELECT count(*) lines, count(DISTINCT DocNum) docs, round(sum(AccountedDr), 2) dr FROM GLTrans WHERE ComCode = ? AND Period = ?",
        ZEN,
        D,
      );
      expect(gl.lines).toBeGreaterThan(0);
      let grid = listPeriodGrid({ periodFrom: D, periodTo: D });
      // Build ghi lại ComCode theo mapping → dòng "ghost" về ZENIROXPAY
      expect(grid.companies.map((c) => c.ComCode)).toEqual([ONT, ZEN]);
      expect(cellOf(grid, ZEN, D)).toMatchObject({
        rawNotBuilt: 1,
        rawError: 0,
        rawBySource: { ORDERS: { notBuilt: 0, error: 0, total: 2 }, STRIPE: { notBuilt: 1, total: 1 } },
        events: { NEW: 0, ERROR: 0, POSTED: posted },
        glLines: gl.lines,
        glDocs: gl.docs,
        dr: gl.dr,
        cr: gl.dr,
        balanced: true,
      });
      expect(grid.unassigned).toEqual([
        { Period: D, DataSource: "ORDERS", NotBuilt: 0, Error: 1 },
        { Period: D, DataSource: "STRIPE", NotBuilt: 1, Error: 0 },
      ]);

      // Sửa tay 1 dòng GL cho lệch 1,00 → ô báo lệch
      getDb()
        .$client.prepare(
          "UPDATE GLTrans SET AccountedDr = AccountedDr + 1 WHERE ID = (SELECT min(ID) FROM GLTrans WHERE ComCode = ? AND Period = ? AND AccountedDr > 0)",
        )
        .run(ZEN, D);
      grid = listPeriodGrid({ periodFrom: D, periodTo: D });
      const cell = cellOf(grid, ZEN, D)!;
      expect(cell).toMatchObject({ balanced: false, cr: gl.dr });
      expect(cell.dr).toBeCloseTo(gl.dr + 1, 2);
      expect(cell.issues.map((i) => i.code)).toEqual(["RAW_NOT_BUILT", "GL_IMBALANCED"]);
    });

    it("khóa khi còn việc dở chỉ cảnh báo: vẫn khóa, việc dở lưu vào ChecksSnapshot", () => {
      // ZENIROXPAY 202511 đang khóa nhưng đã hết dữ liệu (sau Xóa dữ liệu test) → không thuộc "kỳ có dữ liệu ≤ P", không liệt kê
      const res = lockPeriods({ comCodes: [ZEN], throughPeriod: D, actor: "Kế toán A" });
      expect(res).toMatchObject({ locked: [{ ComCode: ZEN, Period: D }], alreadyLocked: [] });
      const [log] = listPeriodLog({ comCode: ZEN, period: D, action: "LOCK", pageSize: 1 }).rows;
      const snapshot = JSON.parse(log.ChecksSnapshot!);
      expect(snapshot).toMatchObject({ rawNotBuilt: 1, rawNoComCode: 2, balanced: false });
      expect(snapshot.issues.map((i: { code: string }) => i.code)).toEqual(["RAW_NOT_BUILT", "RAW_NO_COMCODE", "GL_IMBALANCED"]);
      expect(periodRow(ZEN, D)?.Status).toBe("LOCKED");
    });
  });
});

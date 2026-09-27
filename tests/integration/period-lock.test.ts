/**
 * Khóa sổ kỳ kế toán (guide §6.12) trên 1 DB SQLite tạm: mọi chốt chặn của Import / Build / Post / Unpost / Unbuild /
 * Xóa dữ liệu test khi (ComCode, kỳ) đang LOCKED.
 *
 * Bất biến kiểm ở mọi bước: dữ liệu của kỳ khóa (`snapshot` = AccountingEvent, GLTrans, dòng raw, ExceptionLog trừ tóm tắt
 * INFO PERIOD_LOCKED) không đổi 1 byte; số `Locked*` trong kết quả khớp đúng phần bị bỏ qua.
 *
 *  1. Build sau khi khóa kỳ đã post (toàn bộ / theo phạm vi): bỏ qua hết, đúng 1 tóm tắt INFO.
 *  2. Post khi kỳ khóa còn event NEW (+ Run Accounting Cycle); mở khóa rồi Post đủ.
 *  3. Unpost / Unbuild / Unpost + Unbuild: không gỡ gì của kỳ khóa (kể cả dòng raw không có event).
 *  4. Xóa dữ liệu test bị từ chối (service + API 400); mở khóa thì xóa được, bảng kỳ còn nguyên.
 *  5. Import: dòng giống hệt bỏ qua; sửa / thêm / dời ngày dòng thuộc kỳ khóa bị từ chối; kỳ mở / chưa giao được nhận.
 *     5b. Dòng đã rời BUILT nhưng item còn trong event kỳ khóa.
 *  6. Đổi cổng Stripe → ONTARIO khi ZENIROXPAY khóa: chặn ERROR PERIOD_LOCKED, không ghi sổ trùng; làm theo thông điệp.
 *     6b. Khóa công ty đích ONTARIO. 6c. Dòng đổi ngày giao sẵn trong DB sang kỳ mở.
 *  7. Kỳ trộn 202511 khóa + 202512 mở. 7b. 1 lần post gồm cả 2 kỳ → Unpost theo lần post.
 *  8. Stripe (60 dòng): import / build / unbuild; dòng đổi ngày sẵn trong DB → EVENT_LOCKED, không lỗi UNIQUE.
 *  9. PayPal (20 dòng): dời ngày tạo dòng raw mới (SourceKey có ngày) → ERROR PERIOD_LOCKED.
 *
 * Kỳ khóa / mở khóa ghi thẳng bằng SQL vào AccountingPeriod (+ AccountingPeriodLog) để test không phụ thuộc service kỳ
 * (đã có tests/integration/periods.test.ts). Orders chạy trên tập con kịch bản 431 dòng thuần kỳ 202511 (1.205 event,
 * 50 chứng từ / 100 dòng GL, Σ 43.227,58 — xem `scenarioRecords`); Stripe / PayPal chỉ lấy vài chục dòng đầu file thật.
 */
import { closeSync, openSync, readSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Papa from "papaparse";
import { afterAll, describe, expect, it } from "vitest";
import type { BuildSummary } from "@/lib/services/build";
import type { PostSummary } from "@/lib/services/post";

const dbFile = path.join(os.tmpdir(), `finance-period-lock-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = dbFile;

const STRIPE = "ZeniroxPay - Stripe";
const Z = "ZENIROXPAY";
const NOV = "202511";
const DEC = "202512";
const Z_NOV = "ZENIROXPAY|202511";
/** Tập con kịch bản: số event, phần của cổng Stripe, số chứng từ và tổng sổ */
const EVENTS = 1_205;
const STRIPE_EVENTS = 123;
const DOCS = 50;
const GL_TOTAL = 43_227.58;

const samplePath = (file: string) => path.join(process.cwd(), "data", "samples", file);

/** Header + `rows` dòng đầu của 1 file sao kê thật (chỉ đọc phần đầu file — PayPal ~30MB) */
function sourceHead(file: string, rows: number): { fields: string[]; records: Record<string, string>[] } {
  const fd = openSync(samplePath(file), "r");
  const buffer = Buffer.alloc(1 << 17);
  const bytes = readSync(fd, buffer, 0, buffer.length, 0);
  closeSync(fd);
  const parsed = Papa.parse<Record<string, string>>(buffer.subarray(0, bytes).toString("utf8"), { header: true, skipEmptyLines: true, preview: rows });
  return { fields: parsed.meta.fields ?? [], records: parsed.data };
}

describe("khóa sổ kỳ kế toán: chốt chặn ở mọi thao tác", async () => {
  const { importOrders } = await import("@/lib/services/import-orders");
  const { importSourceFile } = await import("@/lib/services/import-source");
  const { runBuildOrders } = await import("@/lib/services/build");
  const { runBuildSource } = await import("@/lib/services/build-source");
  const { runPost } = await import("@/lib/services/post");
  const { unpost, unbuild, resetTransactionalData } = await import("@/lib/services/clear");
  const { deleteGatewayMapping, upsertGatewayMapping } = await import("@/lib/services/master");
  const { BadRequestError } = await import("@/lib/errors");
  const { POST: cycleRoute } = await import("@/app/api/cycle/route");
  const { POST: resetRoute } = await import("@/app/api/reset/route");
  const { getDb, closeDb } = await import("@/lib/db/client");
  const { loadOrderRecords, oneRowCsv, scenarioRecords, seedTestCompanies, TEST_GATEWAY_MAPPINGS, toCsv } = await import("../helpers/fixtures");
  seedTestCompanies(getDb());

  const { headers, records } = await loadOrderRecords();
  const sampleRecords = scenarioRecords(records);
  const csvOf = (list: Record<string, string>[]) => toCsv(headers, list);

  afterAll(() => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(dbFile + suffix, { force: true });
  });

  const sql = <T>(query: string, ...params: unknown[]) => getDb().$client.prepare(query).all(...params) as T[];
  const exec = (query: string, ...params: unknown[]) => getDb().$client.prepare(query).run(...params);
  const count = (query: string, ...params: unknown[]) => sql<{ n: number }>(`SELECT count(*) n FROM (${query})`, ...params)[0].n;
  /** Kỳ YYYYMM của cột ngày YYYY-MM-DD (cùng biểu thức với `periodOfDateColumn`) */
  const periodOf = (column: string) => `substr(${column}, 1, 4) || substr(${column}, 6, 2)`;

  // ── Khóa / mở khóa: ghi thẳng bảng kỳ như service periods (upsert + 1 dòng lịch sử) ──
  const setPeriod = (comCode: string, period: string, status: "OPEN" | "LOCKED") => {
    const now = "2026-01-01 00:00:00";
    const from = sql<{ Status: string }>("SELECT Status FROM AccountingPeriod WHERE ComCode = ? AND Period = ?", comCode, period)[0]?.Status ?? "OPEN";
    exec(
      `INSERT INTO AccountingPeriod (ComCode, Period, Status, LockedBy, LockedAt, ModifiedDate) VALUES (?, ?, ?, 'test', ?, ?)
       ON CONFLICT (ComCode, Period) DO UPDATE SET Status = excluded.Status, ModifiedDate = excluded.ModifiedDate`,
      comCode,
      period,
      status,
      now,
      now,
    );
    exec(
      "INSERT INTO AccountingPeriodLog (ComCode, Period, Action, FromStatus, ToStatus, ActorName, Reason, CreatedAt) VALUES (?, ?, ?, ?, ?, 'test', ?, ?)",
      comCode,
      period,
      status === "LOCKED" ? "LOCK" : "UNLOCK",
      from,
      status,
      status === "LOCKED" ? null : "Mở khóa để chạy lại test",
      now,
    );
  };
  const lock = (comCode: string, period: string) => setPeriod(comCode, period, "LOCKED");
  const unlockAll = () => {
    for (const p of sql<{ ComCode: string; Period: string }>("SELECT ComCode, Period FROM AccountingPeriod WHERE Status = 'LOCKED'")) {
      setPeriod(p.ComCode, p.Period, "OPEN");
    }
  };

  /** Toàn bộ dữ liệu của 1 công ty × kỳ (mọi cột), trừ tóm tắt INFO PERIOD_LOCKED — phải giữ nguyên khi kỳ khóa */
  const snapshot = (comCode: string, period: string) => {
    const of = (query: string) => sql(query, comCode, period);
    const where = (dateCol: string) => `upper(trim(ComCode)) = ? AND ${periodOf(dateCol)} = ?`;
    const raw = (table: string, id: string) =>
      of(`SELECT ${id}, SourceKey, RowHash, BuildStatus, BuildMessage, ComCode, PostingDate FROM ${table} WHERE ${where("PostingDate")} ORDER BY 1`);
    return JSON.stringify({
      events: of("SELECT * FROM AccountingEvent WHERE upper(trim(ComCode)) = ? AND Period = ? ORDER BY AccountingEventID"),
      gl: of("SELECT * FROM GLTrans WHERE upper(trim(ComCode)) = ? AND Period = ? ORDER BY ID"),
      rawOrders: of(
        `SELECT RawOrderID, ItemCode, RowHash, BuildStatus, BuildMessage, ComCode, FulfilledAt FROM RawOrders WHERE ${where("FulfilledAt")} ORDER BY 1`,
      ),
      rawPaypal: raw("RawPaypal", "RawPaypalID"),
      rawStripe: raw("RawStripe", "RawStripeID"),
      exceptions: of(
        "SELECT * FROM ExceptionLog WHERE upper(trim(ComCode)) = ? AND Period = ? AND NOT (ExceptionType = 'PERIOD_LOCKED' AND Severity = 'INFO') ORDER BY ID",
      ),
    });
  };

  const lockSummaries = (batchType: "BUILD" | "POST") =>
    sql<{ BatchID: number | null; DataSource: string; ComCode: string; Period: string; SourceKey: string; Message: string }>(
      `SELECT BatchID, DataSource, ComCode, Period, SourceKey, Message FROM ExceptionLog
       WHERE ExceptionType = 'PERIOD_LOCKED' AND Severity = 'INFO' AND BatchType = ? ORDER BY ID`,
      batchType,
    );
  const lockErrors = (dataSource = "ORDERS") =>
    count("SELECT 1 FROM ExceptionLog WHERE ExceptionType = 'PERIOD_LOCKED' AND Severity = 'ERROR' AND DataSource = ?", dataSource);
  const exceptions = (type: string) => count("SELECT 1 FROM ExceptionLog WHERE ExceptionType = ?", type);
  /** Item + nghiệp vụ bị ghi sổ nhiều hơn 1 lần */
  const duplicateItems = () =>
    count("SELECT j.value, e.JournalTypeCode FROM AccountingEvent e, json_each(e.ItemCodes) j WHERE e.PostStatus = 'POSTED' GROUP BY 1, 2 HAVING count(*) > 1");
  const gl = () =>
    Object.fromEntries(
      sql<{ ComCode: string; dr: number }>("SELECT ComCode, round(sum(AccountedDr), 2) dr FROM GLTrans GROUP BY ComCode").map((r) => [r.ComCode, r.dr]),
    );
  const glTotal = () => sql<{ dr: number | null }>("SELECT round(sum(AccountedDr), 2) dr FROM GLTrans")[0].dr ?? 0;
  const sum = <T extends object>(list: T[], key: { [K in keyof T]: T[K] extends number ? K : never }[keyof T]) =>
    list.reduce((n, x) => n + (x[key] as number), 0);

  const stripeMappingId = () => sql<{ ID: number }>("SELECT ID FROM GatewayCompanyMapping WHERE PaymentGatewayName = ?", STRIPE)[0]?.ID;
  const setStripe = (comCode: string) => upsertGatewayMapping({ ID: stripeMappingId(), PaymentGatewayName: STRIPE, ComCode: comCode, IsActive: 1 });

  const isFulfilled = (r: Record<string, string>) => (r.ItemStatus ?? "").trim().toUpperCase() === "FULFILLED";
  /** Cổng có mapping → dòng thuộc ZENIROXPAY (dòng cổng không map có ComCode trống, không thuộc kỳ khóa nào) */
  const mappedGateways = new Set(TEST_GATEWAY_MAPPINGS.map((m) => m.PaymentGatewayName.trim().toUpperCase()));
  const fulfilledOn = (day: string) =>
    sampleRecords.filter((r) => isFulfilled(r) && r.FulfilledAt.startsWith(day) && mappedGateways.has((r.PaymentGatewayName ?? "").trim().toUpperCase()));
  /** Dòng raw Orders thuộc Z|202511 (sau Build: ComCode đã lưu theo mapping) */
  const novRawRows = () => count(`SELECT 1 FROM RawOrders WHERE ComCode = ? AND ${periodOf("FulfilledAt")} = ?`, Z, NOV);
  const rawOrder = (itemCode: string) => sql("SELECT * FROM RawOrders WHERE ItemCode = ?", itemCode)[0];

  /** Mở mọi kỳ, xóa dữ liệu test, Stripe → ZENIROXPAY, import tập kịch bản + Build (+ Post); chưa khóa gì thì Locked* = 0 */
  const fresh = async (post = true) => {
    unlockAll();
    resetTransactionalData();
    setStripe(Z);
    expect(await importOrders(csvOf(sampleRecords), "orders-sample.csv")).toMatchObject({ InsertedRows: sampleRecords.length, ErrorRows: 0, LockedRows: 0 });
    expect(runBuildOrders()).toMatchObject({ Status: "SUCCESS", EventsCreated: EVENTS, LockedSkipped: 0, LockedConflicts: 0, LockedRows: 0, LockedPeriods: [] });
    if (!post) return;
    const posts = runPost("All");
    expect(posts.map((p) => [p.LockedEvents, p.LockedPeriods])).toEqual([
      [0, []],
      [0, []],
    ]);
    expect(posts[1]).toMatchObject({ Status: "SUCCESS", PostedEvents: EVENTS, Documents: DOCS });
    expect(glTotal()).toBe(GL_TOTAL);
  };

  describe("1. Build sau khi khóa kỳ đã post", () => {
    it("chuẩn bị: import + build + post khi chưa khóa kỳ nào", async () => {
      await fresh();
      expect(lockSummaries("BUILD")).toEqual([]);
      expect(lockSummaries("POST")).toEqual([]);
    });

    it("khóa ZENIROXPAY 202511 → Build bỏ qua mọi draft + dòng raw của kỳ, dữ liệu kỳ không đổi, đúng 1 tóm tắt INFO (build 2 lần)", () => {
      lock(Z, NOV);
      const before = snapshot(Z, NOV);
      const rows = novRawRows();
      // Snapshot có dữ liệu thật thì so sánh bên dưới mới có nghĩa
      expect(JSON.parse(before)).toMatchObject({ events: { length: EVENTS }, gl: { length: 2 * DOCS }, rawOrders: { length: rows } });
      expect(rows).toBeGreaterThan(0);

      for (let i = 0; i < 2; i++) {
        const r = runBuildOrders();
        expect(r).toMatchObject({
          Status: "SUCCESS",
          EventsCreated: 0,
          EventsReplaced: 0,
          EventsRemoved: 0,
          EventsBlocked: 0,
          EventsUnchangedPosted: 0,
          LockedSkipped: EVENTS,
          LockedConflicts: 0,
          LockedRows: rows,
          LockedPeriods: [Z_NOV],
        });
        expect(snapshot(Z, NOV)).toBe(before);
        const summaries = lockSummaries("BUILD");
        expect(summaries).toEqual([
          { BatchID: r.BuildBatchID, DataSource: "ORDERS", ComCode: Z, Period: NOV, SourceKey: "PERIOD_LOCKED|ORDERS|ZENIROXPAY|202511", Message: expect.any(String) },
        ]);
        expect(summaries[0].Message).toContain(`Build bỏ qua ${rows} dòng nguồn, ${EVENTS} event`);
      }
    });

    it("Build theo phạm vi: ComCode + kỳ khóa → vẫn bỏ qua; ComCode khác → không đụng tóm tắt của ZENIROXPAY", () => {
      const before = snapshot(Z, NOV);
      expect(runBuildOrders({ comCode: Z, periodFrom: NOV, periodTo: NOV })).toMatchObject({
        EventsCreated: 0,
        EventsReplaced: 0,
        EventsRemoved: 0,
        LockedSkipped: EVENTS,
        LockedPeriods: [Z_NOV],
      });
      expect(runBuildOrders({ comCode: "ONTARIO" })).toMatchObject({ EventsCreated: 0, LockedSkipped: 0, LockedRows: 0, LockedPeriods: [] });
      expect(lockSummaries("BUILD")).toHaveLength(1);
      expect(snapshot(Z, NOV)).toBe(before);
    });

    it("Post khi mọi event của kỳ đã POSTED: không có gì để post, không báo kỳ khóa", () => {
      const posts = runPost("All");
      expect(posts.map((p) => [p.Status, p.LockedEvents, p.LockedPeriods])).toEqual([
        ["NOTHING_TO_POST", 0, []],
        ["NOTHING_TO_POST", 0, []],
      ]);
      expect(lockSummaries("POST")).toEqual([]);
    });
  });

  describe("2. Post khi kỳ khóa còn event NEW", () => {
    it("khóa sau Build, trước Post → Post bỏ qua (2 lần), không ghi GL, đúng 1 tóm tắt INFO không gắn batch", async () => {
      await fresh(false);
      lock(Z, NOV);
      const pending = count("SELECT 1 FROM AccountingEvent WHERE PostStatus = 'NEW'");
      expect(pending).toBe(EVENTS);
      const before = snapshot(Z, NOV);

      for (let i = 0; i < 2; i++) {
        const posts = runPost("All");
        expect(posts.map((p) => p.Status)).toEqual(["NOTHING_TO_POST", "NOTHING_TO_POST"]);
        expect(sum(posts, "LockedEvents")).toBe(pending);
        // Mọi event Orders của tập kịch bản là Bulk
        expect(posts[1]).toMatchObject({ Classify: "Bulk", PostBatchID: null, LockedEvents: EVENTS, LockedPeriods: [Z_NOV] });
        expect(count("SELECT 1 FROM GLTrans")).toBe(0);
        expect(count("SELECT 1 FROM PostingBatch")).toBe(0);
        expect(snapshot(Z, NOV)).toBe(before);
        const summaries = lockSummaries("POST");
        expect(summaries).toMatchObject([{ BatchID: null, DataSource: "ORDERS", ComCode: Z, Period: NOV, SourceKey: "PERIOD_LOCKED|ORDERS|ZENIROXPAY|202511" }]);
        expect(summaries[0].Message).toContain(`Post bỏ qua ${EVENTS} event`);
      }
    });

    it("Post Single / theo phạm vi kỳ khóa: không post, tóm tắt vẫn đếm cả event Bulk", () => {
      expect(runPost("Single")).toMatchObject([{ Status: "NOTHING_TO_POST", LockedEvents: 0, LockedPeriods: [] }]);
      expect(runPost("Bulk", { comCode: Z, periodFrom: NOV, periodTo: NOV })).toMatchObject([
        { Status: "NOTHING_TO_POST", LockedEvents: EVENTS, LockedPeriods: [Z_NOV] },
      ]);
      const summaries = lockSummaries("POST");
      expect(summaries).toHaveLength(1);
      expect(summaries[0].Message).toContain(`Post bỏ qua ${EVENTS} event`);
      expect(count("SELECT 1 FROM GLTrans")).toBe(0);
    });

    it("Run Accounting Cycle (/api/cycle): Build và Post đều bỏ qua kỳ khóa, báo số lượng", async () => {
      const before = snapshot(Z, NOV);
      const res = await cycleRoute(new Request("http://localhost/api/cycle", { method: "POST", body: "{}" }));
      expect(res.status).toBe(200);
      const { build, post } = (await res.json()) as { build: BuildSummary; post: PostSummary[] };
      expect(build).toMatchObject({ Status: "SUCCESS", EventsCreated: 0, EventsReplaced: 0, EventsRemoved: 0, LockedSkipped: EVENTS, LockedPeriods: [Z_NOV] });
      expect(post.map((p) => [p.Status, p.LockedEvents])).toEqual([
        ["NOTHING_TO_POST", 0],
        ["NOTHING_TO_POST", EVENTS],
      ]);
      expect(count("SELECT 1 FROM GLTrans")).toBe(0);
      expect(snapshot(Z, NOV)).toBe(before);
    });

    it("mở khóa → Post ghi đủ 50 chứng từ, tóm tắt POST được dọn", () => {
      unlockAll();
      const posts = runPost("All");
      expect(posts[1]).toMatchObject({ Status: "SUCCESS", PostedEvents: EVENTS, Documents: DOCS, InsertedRows: 2 * DOCS, LockedEvents: 0, LockedPeriods: [] });
      expect(glTotal()).toBe(GL_TOTAL);
      expect(lockSummaries("POST")).toEqual([]);
    });
  });

  describe("3. Unpost / Unbuild khi kỳ đã khóa", () => {
    let before = "";
    const builtUnfulfilled = () => count("SELECT 1 FROM RawOrders WHERE FulfilledAt IS NULL AND BuildStatus <> 'NOT_BUILT'");
    // Item đã giao rồi bị hủy: thuộc kỳ (ComCode × FulfilledAt) nhưng không có event → chỉ điều kiện kỳ khóa trên raw giữ được nó
    const cancelled = { ...fulfilledOn("2025-11-21")[0], ItemCode: `${fulfilledOn("2025-11-21")[0].ItemCode}-CANCELLED`, ItemStatus: "CANCELLED" };

    it("chuẩn bị: thêm 1 item giao 21/11 rồi hủy → Build ghi SKIPPED, ComCode ZENIROXPAY, không event", async () => {
      expect(await importOrders(csvOf([cancelled]), "cancelled.csv")).toMatchObject({ InsertedRows: 1, ErrorRows: 0 });
      expect(runBuildOrders()).toMatchObject({ EventsCreated: 0, EventsUnchangedPosted: EVENTS, LockedSkipped: 0 });
      expect(rawOrder(cancelled.ItemCode)).toMatchObject({ ComCode: Z, FulfilledAt: "2025-11-21", BuildStatus: "SKIPPED" });
    });

    it("Unpost (toàn bộ, theo ComCode, theo lần post; preview và chạy thật): 0 chứng từ, báo 50 chứng từ kỳ khóa", () => {
      lock(Z, NOV);
      before = snapshot(Z, NOV);
      const [{ PostBatchID }] = sql<{ PostBatchID: number }>("SELECT DISTINCT PostBatchID FROM GLTrans");
      for (const options of [{}, { scope: { comCode: Z } }, { scope: { periodFrom: NOV, periodTo: NOV } }, { postBatchId: PostBatchID }]) {
        for (const preview of [true, false]) {
          expect(unpost({ ...options, preview })).toEqual({
            preview,
            events: 0,
            glLines: 0,
            documents: 0,
            batches: [],
            lockedDocuments: DOCS,
            lockedEvents: EVENTS,
            lockedPeriods: [Z_NOV],
          });
        }
      }
      expect(snapshot(Z, NOV)).toBe(before);
      expect(sql("SELECT Status FROM PostingBatch WHERE PostBatchID = ?", PostBatchID)).toEqual([{ Status: "SUCCESS" }]);
    });

    it("Unbuild / Unpost + Unbuild (preview và chạy thật): không xóa event nào, dòng raw kỳ khóa giữ BUILT", () => {
      const lockedRaw = novRawRows();
      const cases = [
        { scope: { comCode: Z, periodFrom: NOV, periodTo: NOV }, includePosted: true },
        { scope: { periodFrom: NOV, periodTo: NOV } },
        { includePosted: true },
        {},
      ];
      for (const options of cases) {
        for (const preview of [true, false]) {
          // Dòng chưa giao không thuộc kỳ nào → không bị khóa (chỉ có khi phạm vi không lọc kỳ)
          const unfulfilled = options.scope?.periodFrom ? 0 : builtUnfulfilled();
          const r = unbuild({ ...options, preview });
          expect(r).toMatchObject({
            preview,
            deletedEvents: 0,
            postedEventsKept: 0,
            rawRowsReset: unfulfilled,
            lockedEvents: EVENTS,
            lockedRawRows: lockedRaw,
            lockedPeriods: [Z_NOV],
          });
          expect(r.unposted).toEqual(
            options.includePosted ? expect.objectContaining({ documents: 0, events: 0, lockedDocuments: DOCS, lockedEvents: EVENTS, lockedPeriods: [Z_NOV] }) : null,
          );
          expect(snapshot(Z, NOV)).toBe(before);
        }
      }
      expect(count("SELECT 1 FROM RawOrders WHERE FulfilledAt IS NOT NULL AND ComCode = ? AND BuildStatus = 'BUILT'", Z)).toBe(lockedRaw - 1);
      expect(rawOrder(cancelled.ItemCode)).toMatchObject({ BuildStatus: "SKIPPED" });
      expect(glTotal()).toBe(GL_TOTAL);
    });
  });

  describe("4. Xóa dữ liệu test", () => {
    it("bị từ chối khi còn kỳ khóa (service và API), dữ liệu giữ nguyên", async () => {
      const before = snapshot(Z, NOV);
      const rows = count("SELECT 1 FROM RawOrders");
      expect(() => resetTransactionalData()).toThrow(BadRequestError);
      expect(() => resetTransactionalData()).toThrow(/ZENIROXPAY kỳ 202511/);
      // Nút "Xóa dữ liệu test" trên dashboard: API trả 400 kèm thông điệp
      const res = await resetRoute();
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("Còn 1 kỳ đang khóa sổ (ZENIROXPAY kỳ 202511)");
      expect(snapshot(Z, NOV)).toBe(before);
      expect(count("SELECT 1 FROM RawOrders")).toBe(rows);
    });

    it("mở khóa rồi xóa được; bảng kỳ và lịch sử khóa giữ nguyên", () => {
      unlockAll();
      const periods = sql("SELECT * FROM AccountingPeriod ORDER BY ComCode, Period");
      const log = sql("SELECT * FROM AccountingPeriodLog ORDER BY ID");
      expect(periods).toMatchObject([{ ComCode: Z, Period: NOV, Status: "OPEN" }]);
      expect(log.length).toBeGreaterThanOrEqual(6);

      resetTransactionalData();
      for (const t of ["RawOrders", "AccountingEvent", "GLTrans", "PostingBatch", "BuildBatch", "ExceptionLog", "ImportBatch"]) {
        expect(count(`SELECT 1 FROM ${t}`), t).toBe(0);
      }
      expect(sql("SELECT * FROM AccountingPeriod ORDER BY ComCode, Period")).toEqual(periods);
      expect(sql("SELECT * FROM AccountingPeriodLog ORDER BY ID")).toEqual(log);
    });
  });

  describe("5. Import khi kỳ đã khóa", () => {
    const [target] = fulfilledOn("2025-11-20");
    const template = fulfilledOn("2025-11-21")[0];
    const unfulfilled = sampleRecords.find((r) => !isFulfilled(r) && !r.FulfilledAt?.trim())!;
    let before = "";

    it("chuẩn bị: import + build + post rồi khóa ZENIROXPAY 202511", async () => {
      expect(target && template && unfulfilled).toBeTruthy();
      await fresh();
      lock(Z, NOV);
      before = snapshot(Z, NOV);
    });

    it("file giống hệt → bỏ qua hết, không lỗi", async () => {
      expect(await importOrders(csvOf(sampleRecords), "orders-sample.csv")).toMatchObject({
        TotalRows: sampleRecords.length,
        InsertedRows: 0,
        ReplacedRows: 0,
        SkippedRows: sampleRecords.length,
        ErrorRows: 0,
        LockedRows: 0,
      });
    });

    it("sửa Profit 1 dòng giao 20/11 → từ chối, dòng giữ nguyên", async () => {
      const old = rawOrder(target.ItemCode);
      const r = await importOrders(
        oneRowCsv(headers, sampleRecords, (x) => x.ItemCode === target.ItemCode, { Profit: String(Number(target.Profit) + 1) }),
        "profit.csv",
      );
      expect(r).toMatchObject({ TotalRows: 1, InsertedRows: 0, ReplacedRows: 0, ErrorRows: 1, LockedRows: 1 });
      expect(r.errors[0]).toMatchObject({ key: target.ItemCode, message: expect.stringContaining("ZENIROXPAY kỳ 202511 đã khóa sổ") });
      expect(rawOrder(target.ItemCode)).toEqual(old);
    });

    it("dòng mới giao 30/11 → từ chối; giao 01/12 → nhận", async () => {
      const novItem = `${template.ItemCode}-LATE-NOV`;
      const decItem = `${template.ItemCode}-LATE-DEC`;
      const late = await importOrders(csvOf([{ ...template, ItemCode: novItem, FulfilledAt: "2025-11-30 00:00:00" }]), "late-nov.csv");
      expect(late).toMatchObject({ InsertedRows: 0, ErrorRows: 1, LockedRows: 1 });
      expect(late.errors[0].message).toContain("khóa sổ");
      expect(rawOrder(novItem)).toBeUndefined();

      const next = await importOrders(csvOf([{ ...template, ItemCode: decItem, FulfilledAt: "2025-12-01 00:00:00" }]), "late-dec.csv");
      expect(next).toMatchObject({ InsertedRows: 1, ErrorRows: 0, LockedRows: 0 });
      expect(rawOrder(decItem)).toMatchObject({ ComCode: Z, FulfilledAt: "2025-12-01", BuildStatus: "NOT_BUILT" });
    });

    it("dời ngày giao dòng đã có sang 02/12 → từ chối (kỳ cũ đang khóa)", async () => {
      const old = rawOrder(target.ItemCode);
      const r = await importOrders(
        oneRowCsv(headers, sampleRecords, (x) => x.ItemCode === target.ItemCode, { FulfilledAt: "2025-12-02 00:00:00" }),
        "moved.csv",
      );
      expect(r).toMatchObject({ ReplacedRows: 0, ErrorRows: 1, LockedRows: 1 });
      expect(r.errors[0].message).toContain("ZENIROXPAY kỳ 202511 đã khóa sổ");
      expect(rawOrder(target.ItemCode)).toEqual(old);
    });

    it("dòng mới chưa giao (không thuộc kỳ nào) → nhận", async () => {
      const itemCode = `${unfulfilled.ItemCode}-NEW`;
      expect(await importOrders(csvOf([{ ...unfulfilled, ItemCode: itemCode }]), "unfulfilled.csv")).toMatchObject({
        InsertedRows: 1,
        ErrorRows: 0,
        LockedRows: 0,
      });
      expect(rawOrder(itemCode)).toMatchObject({ FulfilledAt: null, BuildStatus: "NOT_BUILT" });
    });

    it("dữ liệu kỳ khóa không đổi sau mọi lần import", () => {
      expect(snapshot(Z, NOV)).toBe(before);
    });
  });

  describe("5b. Dòng đã rời BUILT nhưng item còn trong event kỳ khóa", () => {
    const STRIPE_ROWS = sampleRecords.filter((r) => r.PaymentGatewayName === STRIPE);

    it("gỡ mapping Stripe → Build (raw ERROR, ComCode trống) → khóa → import dòng đổi ngày giao: từ chối, báo event kỳ khóa", async () => {
      await fresh();
      deleteGatewayMapping(stripeMappingId());
      runBuildOrders();
      expect(sql("SELECT BuildStatus, ComCode, count(*) n FROM RawOrders WHERE PaymentGatewayName = ? GROUP BY 1, 2", STRIPE)).toEqual([
        { BuildStatus: "ERROR", ComCode: null, n: STRIPE_ROWS.length },
      ]);
      lock(Z, NOV);
      const before = snapshot(Z, NOV);

      // Dòng không còn ComCode nên (ComCode, kỳ) mới/cũ không khóa; chốt còn lại là event POSTED đang giữ item ở kỳ khóa
      const redated = csvOf(STRIPE_ROWS.map((r) => ({ ...r, FulfilledAt: "2025-12-03 00:00:00" })));
      const r = await importOrders(redated, "redated.csv");
      expect(r).toMatchObject({ ReplacedRows: 0, ErrorRows: STRIPE_ROWS.length, LockedRows: STRIPE_ROWS.length });
      expect(r.errors.every((e) => e.message.includes("(POSTED) thuộc ZENIROXPAY kỳ 202511 đã khóa sổ"))).toBe(true);
      expect(snapshot(Z, NOV)).toBe(before);
      upsertGatewayMapping({ PaymentGatewayName: STRIPE, ComCode: Z, IsActive: 1 });
    });
  });

  describe("6. Đổi cổng Stripe → ONTARIO sau khi khóa ZENIROXPAY 202511", () => {
    let before = "";

    it("Build (2 lần): draft ONTARIO trùng item với event kỳ khóa → ERROR PERIOD_LOCKED, dữ liệu kỳ khóa không đổi", async () => {
      await fresh();
      lock(Z, NOV);
      before = snapshot(Z, NOV);
      setStripe("ONTARIO");

      for (let i = 0; i < 2; i++) {
        expect(runBuildOrders()).toMatchObject({
          Status: "SUCCESS",
          EventsCreated: i === 0 ? STRIPE_EVENTS : 0,
          EventsReplaced: i === 0 ? 0 : STRIPE_EVENTS,
          EventsBlocked: STRIPE_EVENTS,
          EventsError: STRIPE_EVENTS,
          EventsRemoved: 0,
          EventsUnchangedPosted: 0,
          LockedSkipped: EVENTS - STRIPE_EVENTS,
          LockedConflicts: STRIPE_EVENTS,
          LockedPeriods: [Z_NOV],
        });
        expect(snapshot(Z, NOV)).toBe(before);
        expect(sql("SELECT ComCode, PostStatus, ErrorStage, count(*) n FROM AccountingEvent WHERE ComCode = 'ONTARIO' GROUP BY 1, 2, 3")).toEqual([
          { ComCode: "ONTARIO", PostStatus: "ERROR", ErrorStage: "BUILD", n: STRIPE_EVENTS },
        ]);
        // Exception không nhân đôi; thay cho POSTED_KEY_CHANGED (lời khuyên "Unpost" không làm được khi kỳ còn khóa)
        expect(lockErrors()).toBe(STRIPE_EVENTS);
        expect(exceptions("POSTED_KEY_CHANGED")).toBe(0);
        expect(exceptions("POSTED_SOURCE_CHANGED")).toBe(0);
        expect(lockSummaries("BUILD")).toHaveLength(1);
      }
      const messages = sql<{ ErrorMessage: string }>("SELECT DISTINCT ErrorMessage FROM AccountingEvent WHERE ComCode = 'ONTARIO'");
      expect(messages.every((m) => m.ErrorMessage.includes("mở khóa ZENIROXPAY kỳ 202511"))).toBe(true);
    });

    it("Post không ghi thêm cho ONTARIO, không ghi sổ trùng item", () => {
      const posts = runPost("All");
      expect(posts.map((p) => [p.Status, p.LockedEvents])).toEqual([
        ["NOTHING_TO_POST", 0],
        ["NOTHING_TO_POST", 0],
      ]);
      expect(gl()).toEqual({ ZENIROXPAY: GL_TOTAL });
      expect(duplicateItems()).toBe(0);
      expect(snapshot(Z, NOV)).toBe(before);
    });

    it("làm theo thông điệp: mở khóa → Unpost ZENIROXPAY 202511 → Build + Post: đơn Stripe sang ONTARIO, tổng sổ không đổi, hết exception kỳ khóa", () => {
      unlockAll();
      unpost({ scope: { comCode: Z, periodFrom: NOV, periodTo: NOV } });
      expect(runBuildOrders()).toMatchObject({ EventsBlocked: 0, EventsRemoved: STRIPE_EVENTS, LockedSkipped: 0, LockedConflicts: 0, LockedRows: 0, LockedPeriods: [] });
      runPost("All");
      expect(gl()).toEqual({ ONTARIO: 3976.68, ZENIROXPAY: 39250.9 });
      expect(glTotal()).toBe(GL_TOTAL);
      expect(duplicateItems()).toBe(0);
      expect(lockErrors()).toBe(0);
      expect(lockSummaries("BUILD")).toEqual([]);
      setStripe(Z);
    });
  });

  describe("6b. Khóa công ty đích ONTARIO 202511 rồi đổi cổng Stripe → ONTARIO", () => {
    it("Build bỏ qua draft ONTARIO, event ZENIROXPAY đã POSTED chỉ bị cảnh báo; Post không ghi thêm", async () => {
      await fresh();
      lock("ONTARIO", NOV);
      const stripeRows = count("SELECT 1 FROM RawOrders WHERE PaymentGatewayName = ? AND FulfilledAt IS NOT NULL", STRIPE);
      const zBefore = JSON.stringify([sql("SELECT * FROM AccountingEvent ORDER BY 1"), sql("SELECT * FROM GLTrans ORDER BY 1")]);
      setStripe("ONTARIO");

      for (let i = 0; i < 2; i++) {
        expect(runBuildOrders()).toMatchObject({
          Status: "SUCCESS",
          EventsCreated: 0,
          EventsReplaced: 0,
          EventsRemoved: 0,
          EventsBlocked: 0,
          EventsUnchangedPosted: EVENTS - STRIPE_EVENTS,
          LockedSkipped: STRIPE_EVENTS,
          LockedConflicts: 0,
          LockedRows: stripeRows,
          LockedPeriods: ["ONTARIO|202511"],
        });
        expect(exceptions("POSTED_SOURCE_CHANGED")).toBe(STRIPE_EVENTS);
        expect(lockSummaries("BUILD")).toMatchObject([{ ComCode: "ONTARIO", Period: NOV }]);
      }
      // Dòng raw Stripe giữ ComCode / trạng thái cũ (ComCode theo mapping mới thuộc kỳ khóa); event và sổ cái không đổi
      expect(sql("SELECT ComCode, BuildStatus, count(*) n FROM RawOrders WHERE PaymentGatewayName = ? GROUP BY 1, 2", STRIPE)).toEqual([
        { ComCode: Z, BuildStatus: "BUILT", n: stripeRows },
      ]);
      expect(JSON.stringify([sql("SELECT * FROM AccountingEvent ORDER BY 1"), sql("SELECT * FROM GLTrans ORDER BY 1")])).toBe(zBefore);
      expect(runPost("All").map((p) => p.Status)).toEqual(["NOTHING_TO_POST", "NOTHING_TO_POST"]);
      expect(gl()).toEqual({ ZENIROXPAY: GL_TOTAL });
      expect(duplicateItems()).toBe(0);
      setStripe(Z);
    });
  });

  describe("6c. Dòng đã đổi ngày giao sẵn trong DB sang kỳ mở (dữ liệu từ phiên bản cũ) khi kỳ cũ khóa", () => {
    it("Build: event ngày cũ (SourceID đã chết) ở kỳ khóa được giữ, không cảnh báo; draft ngày mới bị chặn ERROR PERIOD_LOCKED", async () => {
      await fresh();
      lock(Z, NOV);
      exec("UPDATE RawOrders SET FulfilledAt = '2025-12-03' WHERE PaymentGatewayName = ?", STRIPE);
      const before = snapshot(Z, NOV);

      for (let i = 0; i < 2; i++) {
        expect(runBuildOrders()).toMatchObject({
          Status: "SUCCESS",
          EventsCreated: i === 0 ? STRIPE_EVENTS : 0,
          EventsReplaced: i === 0 ? 0 : STRIPE_EVENTS,
          EventsBlocked: STRIPE_EVENTS,
          EventsRemoved: 0,
          LockedSkipped: EVENTS - STRIPE_EVENTS,
          LockedConflicts: STRIPE_EVENTS,
          LockedPeriods: [Z_NOV],
        });
        expect(snapshot(Z, NOV)).toBe(before);
        expect(sql("SELECT Period, PostStatus, count(*) n FROM AccountingEvent WHERE PostStatus <> 'POSTED' GROUP BY 1, 2")).toEqual([
          { Period: DEC, PostStatus: "ERROR", n: STRIPE_EVENTS },
        ]);
        expect(lockErrors()).toBe(STRIPE_EVENTS);
        expect(exceptions("POSTED_KEY_CHANGED")).toBe(0);
        expect(exceptions("POSTED_SOURCE_CHANGED")).toBe(0);
      }
      expect(runPost("All").map((p) => p.Status)).toEqual(["NOTHING_TO_POST", "NOTHING_TO_POST"]);
      expect(glTotal()).toBe(GL_TOTAL);
      expect(duplicateItems()).toBe(0);
    });
  });

  // Giao nốt 5 item của các đơn đã ghi sổ ở tháng 11 (cùng OrderId, ItemCode mới, ngày giao tháng 12)
  const decRows = fulfilledOn("2025-11-21")
    .slice(0, 5)
    .map((r) => ({ ...r, ItemCode: `${r.ItemCode}-DEC`, FulfilledAt: "2025-12-05 00:00:00" }));

  describe("7. Kỳ trộn: 202511 khóa, 202512 mở", () => {
    const DEC_SCOPE = { periodFrom: DEC, periodTo: DEC };
    let before = "";
    let decEvents = 0;

    it("chuẩn bị: tháng 11 đã post rồi khóa; import thêm dòng giao tháng 12 → nhận", async () => {
      await fresh();
      lock(Z, NOV);
      before = snapshot(Z, NOV);
      expect(await importOrders(csvOf(decRows), "dec.csv")).toMatchObject({ InsertedRows: decRows.length, ErrorRows: 0, LockedRows: 0 });
    });

    it("Build toàn bộ chỉ tạo event kỳ 202512", () => {
      const r = runBuildOrders();
      expect(r).toMatchObject({ Status: "SUCCESS", EventsReplaced: 0, EventsRemoved: 0, EventsBlocked: 0, LockedSkipped: EVENTS, LockedConflicts: 0, LockedPeriods: [Z_NOV] });
      decEvents = r.EventsCreated;
      expect(decEvents).toBeGreaterThan(0);
      expect(sql("SELECT ComCode, Period, PostStatus, count(*) n FROM AccountingEvent WHERE PostStatus <> 'POSTED' GROUP BY 1, 2, 3")).toEqual([
        { ComCode: Z, Period: DEC, PostStatus: "NEW", n: decEvents },
      ]);
      expect(count("SELECT 1 FROM RawOrders WHERE ItemCode LIKE '%-DEC' AND BuildStatus = 'BUILT'")).toBe(decRows.length);
      expect(snapshot(Z, NOV)).toBe(before);
    });

    it("Post chỉ ghi kỳ 202512; Unpost / Unbuild / Build theo kỳ 202512 chạy bình thường", () => {
      const posts = runPost("All");
      expect(sum(posts, "PostedEvents")).toBe(decEvents);
      expect(sum(posts, "LockedEvents")).toBe(0);
      const decGl = sql<{ dr: number }>("SELECT round(sum(AccountedDr), 2) dr FROM GLTrans WHERE Period = ?", DEC)[0].dr;
      expect(decGl).toBeGreaterThan(0);
      expect(snapshot(Z, NOV)).toBe(before);

      expect(unpost({ scope: DEC_SCOPE })).toMatchObject({ events: decEvents, lockedDocuments: 0, lockedEvents: 0, lockedPeriods: [] });
      expect(unbuild({ scope: DEC_SCOPE })).toMatchObject({
        deletedEvents: decEvents,
        rawRowsReset: decRows.length,
        lockedEvents: 0,
        lockedRawRows: 0,
        lockedPeriods: [],
      });
      expect(count("SELECT 1 FROM AccountingEvent WHERE Period = ?", DEC)).toBe(0);
      expect(count("SELECT 1 FROM RawOrders WHERE ItemCode LIKE '%-DEC' AND BuildStatus = 'NOT_BUILT'")).toBe(decRows.length);

      // Build theo kỳ mở: event tháng 11 cùng đơn chỉ là vật cản ngoài phạm vi, không bị tính là bỏ qua
      expect(runBuildOrders(DEC_SCOPE)).toMatchObject({ EventsCreated: decEvents, EventsBlocked: 0, LockedSkipped: 0, LockedRows: 0, LockedPeriods: [] });
      expect(runPost("All", DEC_SCOPE)[1]).toMatchObject({ Status: "SUCCESS", PostedEvents: decEvents, LockedEvents: 0 });
      expect(sql<{ dr: number }>("SELECT round(sum(AccountedDr), 2) dr FROM GLTrans WHERE Period = ?", DEC)[0].dr).toBe(decGl);
      expect(snapshot(Z, NOV)).toBe(before);
    });

    it("Unpost + Unbuild toàn bộ: chỉ gỡ kỳ 202512, kỳ khóa giữ nguyên", () => {
      const r = unbuild({ includePosted: true });
      expect(r).toMatchObject({ deletedEvents: decEvents, postedEventsKept: 0, lockedEvents: EVENTS, lockedPeriods: [Z_NOV] });
      expect(r.unposted).toMatchObject({ events: decEvents, lockedDocuments: DOCS, lockedEvents: EVENTS, lockedPeriods: [Z_NOV] });
      expect(count("SELECT 1 FROM AccountingEvent WHERE Period = ?", DEC)).toBe(0);
      expect(count("SELECT 1 FROM RawOrders WHERE ItemCode LIKE '%-DEC' AND BuildStatus = 'NOT_BUILT'")).toBe(decRows.length);
      expect(glTotal()).toBe(GL_TOTAL);
      expect(snapshot(Z, NOV)).toBe(before);
      expect(duplicateItems()).toBe(0);
    });
  });

  describe("7b. 1 lần post gồm cả kỳ khóa và kỳ mở", () => {
    it("Unpost theo lần post chỉ gỡ chứng từ kỳ mở, batch giữ SUCCESS; mở khóa rồi Unpost tiếp → UNPOSTED", async () => {
      unlockAll();
      resetTransactionalData();
      setStripe(Z);
      expect(await importOrders(csvOf([...sampleRecords, ...decRows]), "orders-nov-dec.csv")).toMatchObject({ ErrorRows: 0 });
      runBuildOrders();
      const [, bulk] = runPost("All");
      expect(bulk).toMatchObject({ Status: "SUCCESS", LockedEvents: 0 });
      const batchId = bulk.PostBatchID!;
      const decDocs = count("SELECT DISTINCT DocNum FROM GLTrans WHERE Period = ?", DEC);
      const decEvents = count("SELECT 1 FROM AccountingEvent WHERE Period = ? AND PostStatus = 'POSTED'", DEC);
      expect(decDocs).toBeGreaterThan(0);
      expect(sql("SELECT DISTINCT PostBatchID FROM GLTrans")).toEqual([{ PostBatchID: batchId }]);

      lock(Z, NOV);
      const before = snapshot(Z, NOV);
      expect(unpost({ postBatchId: batchId })).toEqual({
        preview: false,
        events: decEvents,
        glLines: 2 * decDocs,
        documents: decDocs,
        batches: [batchId],
        lockedDocuments: DOCS,
        lockedEvents: EVENTS,
        lockedPeriods: [Z_NOV],
      });
      expect(count("SELECT 1 FROM GLTrans WHERE Period = ?", DEC)).toBe(0);
      expect(glTotal()).toBe(GL_TOTAL);
      expect(snapshot(Z, NOV)).toBe(before);
      // Batch còn dòng GL của kỳ khóa → vẫn SUCCESS
      expect(sql("SELECT Status FROM PostingBatch WHERE PostBatchID = ?", batchId)).toEqual([{ Status: "SUCCESS" }]);

      unlockAll();
      expect(unpost({ postBatchId: batchId })).toMatchObject({ documents: DOCS, events: EVENTS, lockedDocuments: 0, lockedPeriods: [] });
      expect(sql("SELECT Status FROM PostingBatch WHERE PostBatchID = ?", batchId)).toEqual([{ Status: "UNPOSTED" }]);
    });
  });

  describe("8. Nguồn ngân hàng: 60 dòng đầu Bank_Stripe.csv", () => {
    const { fields, records: stripeRows } = sourceHead("Bank_Stripe.csv", 60);
    const stripeCsv = (rows: Record<string, string>[]) => Buffer.from(Papa.unparse(rows, { columns: fields }), "utf8");
    const novRows = stripeRows.filter((r) => r.Date.startsWith("2025-11"));
    const target = novRows[0];
    const stripeEvents = (period: string) => count("SELECT 1 FROM AccountingEvent WHERE DataSource = 'STRIPE' AND Period = ?", period);
    const lockedRawBuilt = () => count(`SELECT 1 FROM RawStripe WHERE ${periodOf("PostingDate")} = ? AND BuildStatus = 'BUILT'`, NOV);
    let novEvents = 0;
    let before = "";

    it("chuẩn bị: import + build + post, khóa ZENIROXPAY 202511 (kỳ sớm nhất của lát)", async () => {
      expect(stripeRows).toHaveLength(60);
      expect(novRows.length).toBeGreaterThan(0);
      expect(novRows.length).toBeLessThan(60);
      expect(stripeRows.every((r) => r.ComCode === Z && r.Date >= "2025-11")).toBe(true);

      unlockAll();
      resetTransactionalData();
      expect(await importSourceFile("stripe", stripeCsv(stripeRows), "Bank_Stripe.csv")).toMatchObject({ InsertedRows: 60, ErrorRows: 0, LockedRows: 0 });
      expect(runBuildSource("stripe")).toMatchObject({ Status: "SUCCESS", ErrorRows: 0, LockedSkipped: 0, LockedConflicts: 0, LockedRows: 0, LockedPeriods: [] });
      const posts = runPost("All", { dataSource: "STRIPE" });
      expect(posts.every((p) => p.Status !== "FAILED" && p.LockedEvents === 0)).toBe(true);
      novEvents = stripeEvents(NOV);
      expect(novEvents).toBeGreaterThan(0);
      expect(count("SELECT 1 FROM AccountingEvent WHERE DataSource = 'STRIPE' AND PostStatus <> 'POSTED'")).toBe(0);

      // Dòng đã POSTED bị sửa thẳng trong DB (dữ liệu từ phiên bản cũ) → Build cảnh báo POSTED_SOURCE_CHANGED ở kỳ 202511.
      // Cảnh báo thuộc kỳ sắp khóa: mọi lần Build / Unbuild sau khi khóa phải giữ nguyên (exception ngân hàng xóa theo nguồn)
      exec("UPDATE RawStripe SET Amount = Amount + 1 WHERE SourceKey = ?", novRows[1].id);
      expect(runBuildSource("stripe")).toMatchObject({ EventsCreated: 0, EventsUnchangedPosted: stripeEvents(NOV) + stripeEvents(DEC) });
      const warnings = "SELECT 1 FROM ExceptionLog WHERE DataSource = 'STRIPE' AND ExceptionType = 'POSTED_SOURCE_CHANGED' AND ComCode = ? AND Period = ?";
      expect(count(warnings, Z, NOV)).toBeGreaterThan(0);

      lock(Z, NOV);
      before = snapshot(Z, NOV);
      expect(JSON.parse(before).exceptions).toHaveLength(count(warnings, Z, NOV));
    });

    it("import: file giống hệt → bỏ qua; dòng kỳ khóa dời ngày sang tháng 12 → từ chối; dòng mới ngày tháng 11 → từ chối", async () => {
      expect(await importSourceFile("stripe", stripeCsv(stripeRows), "Bank_Stripe.csv")).toMatchObject({ SkippedRows: 60, ErrorRows: 0, LockedRows: 0 });

      const moved = stripeRows.map((r) => (r.id === target.id ? { ...r, Date: "2025-12-10" } : r));
      const r = await importSourceFile("stripe", stripeCsv(moved), "Bank_Stripe.csv");
      expect(r).toMatchObject({ SkippedRows: 59, ReplacedRows: 0, ErrorRows: 1, LockedRows: 1 });
      expect(r.errors[0]).toMatchObject({ key: target.id, message: expect.stringContaining("ZENIROXPAY kỳ 202511 đã khóa sổ") });

      const added = await importSourceFile("stripe", stripeCsv([{ ...target, id: `${target.id}_LATE` }]), "late.csv");
      expect(added).toMatchObject({ InsertedRows: 0, ErrorRows: 1, LockedRows: 1 });
      expect(snapshot(Z, NOV)).toBe(before);
    });

    it("Build: bỏ qua đúng số event + dòng raw của kỳ khóa, đúng 1 tóm tắt INFO của STRIPE", () => {
      for (let i = 0; i < 2; i++) {
        expect(runBuildSource("stripe")).toMatchObject({
          Status: "SUCCESS",
          EventsCreated: 0,
          EventsRemoved: 0,
          LockedSkipped: novEvents,
          LockedConflicts: 0,
          LockedRows: novRows.length,
          LockedPeriods: [Z_NOV],
        });
        expect(snapshot(Z, NOV)).toBe(before);
        expect(lockSummaries("BUILD")).toMatchObject([{ DataSource: "STRIPE", ComCode: Z, Period: NOV, SourceKey: "PERIOD_LOCKED|STRIPE|ZENIROXPAY|202511" }]);
      }
    });

    it("dòng raw đã đổi ngày sẵn trong DB (không qua Import) → Build báo ERROR PERIOD_LOCKED, không ghi event mới, không lỗi UNIQUE; import dòng đó bị chặn theo event", async () => {
      const sourceId = `STRIPE|${target.id}`;
      const targetEvents = count("SELECT 1 FROM AccountingEvent WHERE SourceID = ?", sourceId);
      expect(targetEvents).toBeGreaterThan(0);
      exec("UPDATE RawStripe SET Date = '2025-12-10', PostingDate = '2025-12-10' WHERE SourceKey = ?", target.id);
      const movedBefore = snapshot(Z, NOV);

      const r = runBuildSource("stripe");
      expect(r).toMatchObject({
        Status: "SUCCESS",
        EventsCreated: 0,
        EventsReplaced: 0,
        LockedSkipped: novEvents - targetEvents,
        LockedConflicts: targetEvents,
        LockedRows: novRows.length - 1,
        LockedPeriods: [Z_NOV],
      });
      expect(lockErrors("STRIPE")).toBe(targetEvents);
      expect(sql("SELECT Period, PostStatus, count(*) n FROM AccountingEvent WHERE SourceID = ? GROUP BY 1, 2", sourceId)).toEqual([
        { Period: NOV, PostStatus: "POSTED", n: targetEvents },
      ]);
      expect(snapshot(Z, NOV)).toBe(movedBefore);

      // Import dòng đó (ngày mới, đổi JournalType): (ComCode, kỳ) mới và cũ đều mở → chốt là event cùng SourceID ở kỳ khóa
      const edited = stripeRows.map((r) => (r.id === target.id ? { ...r, Date: "2025-12-10", JournalType: "STRIPE_ADJUSTMENT" } : r));
      const refused = await importSourceFile("stripe", stripeCsv(edited), "Bank_Stripe.csv");
      expect(refused).toMatchObject({ ReplacedRows: 0, ErrorRows: 1, LockedRows: 1 });
      expect(refused.errors[0]).toMatchObject({ key: target.id, message: expect.stringContaining("(POSTED) thuộc ZENIROXPAY kỳ 202511 đã khóa sổ") });
      expect(snapshot(Z, NOV)).toBe(movedBefore);

      // Trả lại ngày cũ → Build như trước, ERROR PERIOD_LOCKED được dọn
      exec("UPDATE RawStripe SET Date = ?, PostingDate = ? WHERE SourceKey = ?", target.Date, target.Date, target.id);
      expect(runBuildSource("stripe")).toMatchObject({ LockedSkipped: novEvents, LockedConflicts: 0, LockedRows: novRows.length });
      expect(lockErrors("STRIPE")).toBe(0);
      expect(snapshot(Z, NOV)).toBe(before);
    });

    it("Unbuild STRIPE (preview, Unbuild, Unpost + Unbuild): chỉ gỡ tháng 12, dòng raw kỳ khóa vẫn BUILT", () => {
      const decEvents = stripeEvents(DEC);
      const decRows = stripeRows.length - novRows.length;
      const scope = { dataSource: "STRIPE" };
      const lockedPart = { lockedEvents: novEvents, lockedRawRows: novRows.length, lockedPeriods: [Z_NOV] };

      expect(unbuild({ scope, preview: true })).toMatchObject({ deletedEvents: 0, postedEventsKept: decEvents, ...lockedPart });
      const r = unbuild({ scope, includePosted: true });
      expect(r).toMatchObject({ deletedEvents: decEvents, postedEventsKept: 0, rawRowsReset: decRows, ...lockedPart });
      expect(r.unposted).toMatchObject({ events: decEvents, lockedEvents: novEvents, lockedPeriods: [Z_NOV] });
      expect(r.unposted!.lockedDocuments).toBeGreaterThan(0);

      expect(stripeEvents(DEC)).toBe(0);
      expect(stripeEvents(NOV)).toBe(novEvents);
      expect(lockedRawBuilt()).toBe(novRows.length);
      expect(count("SELECT 1 FROM RawStripe WHERE BuildStatus = 'NOT_BUILT'")).toBe(decRows);
      expect(snapshot(Z, NOV)).toBe(before);

      // Chạy lại khi đã gỡ hết phần mở: chỉ còn phần kỳ khóa
      expect(unbuild({ scope, includePosted: true })).toMatchObject({ deletedEvents: 0, rawRowsReset: 0, ...lockedPart });
      expect(snapshot(Z, NOV)).toBe(before);
    });

    it("Build + Post lại tháng 12 rồi mở khóa: sổ Stripe cân Nợ/Có", () => {
      expect(runBuildSource("stripe")).toMatchObject({ LockedSkipped: novEvents, LockedRows: novRows.length });
      const decEvents = stripeEvents(DEC);
      expect(decEvents).toBeGreaterThan(0);
      expect(sum(runPost("All", { dataSource: "STRIPE" }), "PostedEvents")).toBe(decEvents);
      expect(snapshot(Z, NOV)).toBe(before);

      unlockAll();
      expect(runBuildSource("stripe")).toMatchObject({ EventsCreated: 0, LockedSkipped: 0, LockedRows: 0, LockedPeriods: [], EventsUnchangedPosted: novEvents + decEvents });
      expect(lockSummaries("BUILD")).toEqual([]);
      const [{ dr, cr }] = sql<{ dr: number; cr: number }>("SELECT round(sum(AccountedDr), 2) dr, round(sum(AccountedCr), 2) cr FROM GLTrans WHERE DataSource = 'STRIPE'");
      expect(dr).toBe(cr);
    });
  });

  describe("9. PayPal: dòng dời ngày sang kỳ mở thành dòng raw mới (SourceKey có ngày)", () => {
    const { fields, records: paypalRows } = sourceHead("Bank_Paypal.csv", 20);
    const paypalCsv = (rows: Record<string, string>[]) => Buffer.from(Papa.unparse(rows, { columns: fields }), "utf8");
    const target = paypalRows.find((r) => r.JournalType === "PP_EXPRESS_CHECKOUT_PAYMENT")!;

    it("import + build + post rồi khóa; import lại dòng đổi ngày sang 01/12 → nhận thành dòng mới; Build chặn ERROR PERIOD_LOCKED, không lỗi UNIQUE", async () => {
      expect(paypalRows.every((r) => r.ComCode === Z && r.Date.startsWith("2025-11"))).toBe(true);
      unlockAll();
      resetTransactionalData();
      expect(await importSourceFile("paypal", paypalCsv(paypalRows), "Bank_Paypal.csv")).toMatchObject({ InsertedRows: 20, ErrorRows: 0 });
      expect(runBuildSource("paypal")).toMatchObject({ Status: "SUCCESS", LockedSkipped: 0 });
      runPost("All", { dataSource: "PAYPAL" });
      const events = count("SELECT 1 FROM AccountingEvent WHERE DataSource = 'PAYPAL'");
      const targetEvents = count("SELECT 1 FROM AccountingEvent WHERE DataSource = 'PAYPAL' AND TransactionID = ?", target["Transaction ID"]);
      expect(targetEvents).toBeGreaterThan(0);
      expect(count("SELECT 1 FROM AccountingEvent WHERE DataSource = 'PAYPAL' AND PostStatus <> 'POSTED'")).toBe(0);
      lock(Z, NOV);
      const before = snapshot(Z, NOV);

      const moved = paypalRows.map((r) => (r === target ? { ...r, Date: "2025-12-01" } : r));
      expect(await importSourceFile("paypal", paypalCsv(moved), "Bank_Paypal.csv")).toMatchObject({ InsertedRows: 1, SkippedRows: 19, ErrorRows: 0, LockedRows: 0 });

      const r = runBuildSource("paypal");
      expect(r).toMatchObject({
        Status: "SUCCESS",
        EventsCreated: 0,
        EventsReplaced: 0,
        EventsRemoved: 0,
        LockedSkipped: events,
        LockedConflicts: targetEvents,
        LockedPeriods: [Z_NOV],
      });
      expect(lockErrors("PAYPAL")).toBe(targetEvents);
      expect(count("SELECT 1 FROM AccountingEvent WHERE DataSource = 'PAYPAL' AND Period = ?", DEC)).toBe(0);
      expect(runPost("All", { dataSource: "PAYPAL" }).map((p) => p.Status)).toEqual(["NOTHING_TO_POST", "NOTHING_TO_POST"]);
      expect(snapshot(Z, NOV)).toBe(before);
    });
  });
});

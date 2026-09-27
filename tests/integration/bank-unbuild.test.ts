/**
 * Unbuild nguồn ngoài Orders (PayPal / Stripe / PIPO) giữ BUILT cho dòng raw còn event — bug cũ guide §13.3 #21:
 * Unbuild (không Unpost) từng đưa MỌI dòng đã build về NOT_BUILT, kể cả dòng có event POSTED được giữ lại → Import mất chốt
 * "dòng đã build + dữ liệu đổi" → sửa tay JournalType, import lại, Build sinh event khóa mới (JTC mới) → Post ghi sổ trùng.
 * Kèm bug "để trống nguồn": Unbuild xóa event chưa post của mọi nguồn nhưng chỉ reset RawOrders.
 *
 * Chạy trên 1 DB SQLite tạm, lát nhỏ cắt từ file thật (không kỳ nào khóa):
 *  - Stripe 60 dòng đầu Bank_Stripe.csv: 43 dòng 11/2025, 17 dòng 12/2025 (1 dòng đổi Currency → eur để có dòng SKIPPED
 *    không sinh event). Post hết rồi Unpost tháng 12 → tháng 11 POSTED, tháng 12 NEW.
 *    1. Unbuild STRIPE: preview + chạy thật, chỉ dòng không còn event về NOT_BUILT.
 *    2. Import lại dòng đã ghi sổ sửa tay JournalType → từ chối "Unpost + Unbuild" (kể cả DB đã hỏng bởi bug cũ: NOT_BUILT mà còn event).
 *    3. Unpost + Unbuild → mọi dòng NOT_BUILT, import dòng sửa được nhận, Build + Post ghi sổ đúng 1 lần.
 *    4. Chốt thứ 2 ở Build: dòng POSTED bị đổi JournalType thẳng trong DB → draft ERROR POSTED_KEY_CHANGED, Post không ghi thêm.
 *    6. Preview "Unpost + Unbuild": rawRowsReset = mọi dòng đã build trong phạm vi.
 *  - 5. Unbuild để trống nguồn trên DB có cả Orders (tập kịch bản 431 dòng) + lát Stripe: dòng Stripe không còn event về NOT_BUILT,
 *    preview = số dòng reset thật (Orders + ngân hàng).
 *  - 7. PayPal 30 dòng đầu Bank_Paypal.csv: chốt Build + Unbuild + Import như Stripe.
 */
import { closeSync, openSync, readFileSync, readSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Decimal from "decimal.js";
import Papa from "papaparse";
import { afterAll, describe, expect, it } from "vitest";
import type { PostSummary } from "@/lib/services/post";

const dbFile = path.join(os.tmpdir(), `finance-bank-unbuild-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = dbFile;

const Z = "ZENIROXPAY";
const NOV = "202511";
const DEC = "202512";

const samplePath = (file: string) => path.join(process.cwd(), "data", "samples", file);
type Rec = Record<string, string>;

/** File sao kê nhỏ (Stripe 1.413 dòng) → parse cả file bằng Papa (không tự tách dòng: file có thể LF hoặc CRLF) */
function sourceFile(file: string): { fields: string[]; records: Rec[] } {
  const parsed = Papa.parse<Rec>(readFileSync(samplePath(file), "utf8"), { header: true, skipEmptyLines: true });
  return { fields: parsed.meta.fields ?? [], records: parsed.data };
}

/** Header + `rows` dòng đầu của file lớn (PayPal ~30MB): chỉ đọc 128KB đầu */
function sourceHead(file: string, rows: number): { fields: string[]; records: Rec[] } {
  const fd = openSync(samplePath(file), "r");
  const buffer = Buffer.alloc(1 << 17);
  const bytes = readSync(fd, buffer, 0, buffer.length, 0);
  closeSync(fd);
  const parsed = Papa.parse<Rec>(buffer.subarray(0, bytes).toString("utf8"), { header: true, skipEmptyLines: true, preview: rows });
  return { fields: parsed.meta.fields ?? [], records: parsed.data };
}

const sumPosted = (list: PostSummary[]) => list.reduce((n, p) => n + p.PostedEvents, 0);

describe("Unbuild nguồn ngân hàng giữ BUILT cho dòng còn event (bug cũ §13.3 #21)", async () => {
  const { importOrders } = await import("@/lib/services/import-orders");
  const { importSourceFile } = await import("@/lib/services/import-source");
  const { runBuildOrders } = await import("@/lib/services/build");
  const { runBuildSource } = await import("@/lib/services/build-source");
  const { runPost } = await import("@/lib/services/post");
  const { unpost, unbuild, resetTransactionalData } = await import("@/lib/services/clear");
  const { getDb, closeDb } = await import("@/lib/db/client");
  const { loadOrderRecords, scenarioRecords, seedTestCompanies, toCsv } = await import("../helpers/fixtures");
  seedTestCompanies(getDb());

  afterAll(() => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(dbFile + suffix, { force: true });
  });

  const sql = <T>(query: string, ...params: unknown[]) => getDb().$client.prepare(query).all(...params) as T[];
  const exec = (query: string, ...params: unknown[]) => getDb().$client.prepare(query).run(...params);
  const count = (query: string, ...params: unknown[]) => sql<{ n: number }>(`SELECT count(*) n FROM (${query})`, ...params)[0].n;

  const events = (dataSource: string, where = "1 = 1", ...params: unknown[]) =>
    count(`SELECT 1 FROM AccountingEvent WHERE DataSource = ? AND ${where}`, dataSource, ...params);
  const gl = (dataSource: string, where = "1 = 1", ...params: unknown[]) =>
    sql<{ lines: number; dr: number | null; cr: number | null }>(
      `SELECT count(*) lines, round(sum(AccountedDr), 2) dr, round(sum(AccountedCr), 2) cr FROM GLTrans WHERE DataSource = ? AND ${where}`,
      dataSource,
      ...params,
    )[0];
  /** Dòng raw đã build (BuildStatus ≠ NOT_BUILT) */
  const built = (table: string, where = "1 = 1", ...params: unknown[]) =>
    count(`SELECT 1 FROM ${table} WHERE BuildStatus <> 'NOT_BUILT' AND ${where}`, ...params);
  /** Dòng raw đã build không còn event nào của nó (SourceID = DataSource|SourceKey) thỏa `eventWhere` — đếm độc lập với service */
  const builtWithoutEvents = (table: string, dataSource: string, eventWhere: string) =>
    count(
      `SELECT 1 FROM ${table} r WHERE r.BuildStatus <> 'NOT_BUILT' AND NOT EXISTS (
         SELECT 1 FROM AccountingEvent e WHERE e.DataSource = ? AND e.SourceID = ? || '|' || r.SourceKey AND ${eventWhere})`,
      dataSource,
      dataSource,
    );
  const statusOf = (table: string, sourceKey: string) =>
    sql<{ BuildStatus: string; JournalType: string | null; RowHash: string }>(
      `SELECT BuildStatus, JournalType, RowHash FROM ${table} WHERE SourceKey = ?`,
      sourceKey,
    )[0];
  const exceptionsOf = (dataSource: string, type: string) =>
    count("SELECT 1 FROM ExceptionLog WHERE DataSource = ? AND ExceptionType = ?", dataSource, type);

  // ── Lát Stripe: 60 dòng đầu file thật, 1 dòng tháng 12 đổi sang eur → SKIPPED, không sinh event ──
  const stripeFile = sourceFile("Bank_Stripe.csv");
  const first60 = stripeFile.records.slice(0, 60);
  const eurIdx = first60.findLastIndex((r) => r.Date.startsWith("2025-12") && r.Type === "charge");
  const stripeRows = first60.map((r, i) => (i === eurIdx ? { ...r, Currency: "eur" } : r));
  const stripeCsv = (rows: Rec[]) => Buffer.from(Papa.unparse(rows, { columns: stripeFile.fields }), "utf8");
  const novRows = stripeRows.filter((r) => r.Date.startsWith("2025-11"));
  const decRows = stripeRows.filter((r) => r.Date.startsWith("2025-12"));
  const charges = novRows.filter((r) => r.Type === "charge" && r.JournalType === "STRIPE_RECEIPT_CUSTOMER" && Number(r.Fee) > 0);
  /** Dòng tháng 11 sẽ bị sửa tay JournalType (import) */
  const target = charges[0];
  /** Dòng tháng 11 bị đổi JournalType thẳng trong DB (chốt ở Build) */
  const target2 = charges[1];
  /** Dòng tháng 12 (event NEW sau bước chuẩn bị) */
  const decTarget = decRows.find((r) => r.Type === "charge" && r.Currency === "usd")!;
  const sid = (r: Rec) => `STRIPE|${r.id}`;
  /** Σ Nợ của 1 dòng charge trên sổ: BANK_CONTRA (Amount) + FEE_BANK (Fee) */
  const chargeDr = (...rows: Rec[]) => rows.reduce((s, r) => s.plus(r.Amount).plus(r.Fee), new Decimal(0)).toNumber();

  /** Reset DB, import + Build + Post cả lát Stripe rồi Unpost tháng 12 → tháng 11 POSTED, tháng 12 NEW. Trả số liệu mốc */
  const stripeFresh = async () => {
    expect(await importSourceFile("stripe", stripeCsv(stripeRows), "Bank_Stripe.csv")).toMatchObject({ Status: "SUCCESS", InsertedRows: 60, ErrorRows: 0 });
    expect(runBuildSource("stripe")).toMatchObject({ Status: "SUCCESS", SourceRows: 60, SkippedRows: 1, ErrorRows: 0, EventsBlocked: 0, EventsError: 0 });
    const posts = runPost("All", { dataSource: "STRIPE" });
    expect(posts.every((p) => p.Status !== "FAILED")).toBe(true);
    const total = gl("STRIPE");
    expect(total.dr).toBe(total.cr);
    const novEvents = events("STRIPE", "Period = ?", NOV);
    const decEvents = events("STRIPE", "Period = ?", DEC);
    expect(sumPosted(posts)).toBe(novEvents + decEvents);

    expect(unpost({ scope: { dataSource: "STRIPE", periodFrom: DEC, periodTo: DEC } })).toMatchObject({ events: decEvents });
    expect(events("STRIPE", "PostStatus = 'POSTED'")).toBe(novEvents);
    expect(events("STRIPE", "PostStatus = 'NEW' AND Period = ?", DEC)).toBe(decEvents);
    expect(built("RawStripe")).toBe(60);
    return { totalAll: total.dr ?? 0, totalNov: gl("STRIPE").dr ?? 0, novEvents, decEvents };
  };

  it("lát dữ liệu đúng như mô tả (43 dòng 11/2025, 17 dòng 12/2025, 1 dòng eur; PayPal ≥ 30 dòng)", () => {
    expect(stripeRows).toHaveLength(60);
    expect(novRows).toHaveLength(43);
    expect(decRows).toHaveLength(17);
    expect(stripeRows[eurIdx].Currency).toBe("eur");
    expect(stripeRows.every((r) => r.ComCode === Z)).toBe(true);
    expect(target && target2 && decTarget).toBeTruthy();
    expect(new Set([target.id, target2.id, decTarget.id]).size).toBe(3);
  });

  describe("Stripe: Unbuild / Import / Build trên lát 60 dòng", () => {
    let base = { totalAll: 0, totalNov: 0, novEvents: 0, decEvents: 0 };

    it("chuẩn bị: import + build + post, Unpost tháng 12", async () => {
      resetTransactionalData();
      base = await stripeFresh();
      expect(base.novEvents).toBeGreaterThan(0);
      expect(base.decEvents).toBeGreaterThan(0);
    });

    it("import dòng tháng 12 (event NEW) sửa tay JournalType → từ chối, bảo Unbuild (không cần Unpost)", async () => {
      const before = statusOf("RawStripe", decTarget.id);
      const r = await importSourceFile("stripe", stripeCsv([{ ...decTarget, JournalType: "STRIPE_CHARGE" }]), "edit.csv");
      expect(r).toMatchObject({ InsertedRows: 0, ReplacedRows: 0, ErrorRows: 1, LockedRows: 0 });
      expect(r.errors[0].key).toBe(decTarget.id);
      expect(r.errors[0].message).toContain("chưa post");
      expect(r.errors[0].message).toContain(`Unbuild STRIPE ComCode ${Z} kỳ ${DEC}`);
      expect(r.errors[0].message).not.toContain("Unpost");
      expect(statusOf("RawStripe", decTarget.id)).toEqual(before);
    });

    it("6. preview Unpost + Unbuild: rawRowsReset = mọi dòng đã build trong phạm vi, không sửa dữ liệu", () => {
      const all = unbuild({ scope: { dataSource: "STRIPE" }, includePosted: true, preview: true });
      expect(all).toMatchObject({ preview: true, deletedEvents: base.novEvents + base.decEvents, postedEventsKept: 0, rawRowsReset: 60 });
      expect(all.unposted).toMatchObject({ preview: true, events: base.novEvents });
      expect(unbuild({ scope: { dataSource: "STRIPE", periodFrom: NOV, periodTo: NOV }, includePosted: true, preview: true })).toMatchObject({
        deletedEvents: base.novEvents,
        rawRowsReset: novRows.length,
      });
      expect(unbuild({ scope: { dataSource: "STRIPE", periodFrom: DEC, periodTo: DEC }, includePosted: true, preview: true })).toMatchObject({
        deletedEvents: base.decEvents,
        rawRowsReset: decRows.length,
      });
      expect(built("RawStripe")).toBe(60);
      expect(events("STRIPE")).toBe(base.novEvents + base.decEvents);
    });

    it("1. Unbuild STRIPE: chỉ dòng không còn event về NOT_BUILT; dòng có event POSTED giữ BUILT; preview = chạy thật", () => {
      const expected = { deletedEvents: base.decEvents, postedEventsKept: base.novEvents, rawRowsReset: decRows.length };
      // Đếm độc lập: dòng đã build không có event POSTED (tháng 12 + dòng eur không có event nào)
      expect(builtWithoutEvents("RawStripe", "STRIPE", "e.PostStatus = 'POSTED'")).toBe(decRows.length);
      expect(builtWithoutEvents("RawStripe", "STRIPE", "1 = 1")).toBe(1);

      const preview = unbuild({ scope: { dataSource: "STRIPE" }, preview: true });
      expect(preview).toMatchObject({ preview: true, unposted: null, ...expected, lockedEvents: 0, lockedRawRows: 0, lockedPeriods: [] });
      expect(built("RawStripe")).toBe(60);

      const r = unbuild({ scope: { dataSource: "STRIPE" } });
      expect(r).toMatchObject({ preview: false, ...expected });

      expect(sql("SELECT BuildStatus, substr(PostingDate, 1, 7) m, count(*) n FROM RawStripe GROUP BY 1, 2 ORDER BY 2")).toEqual([
        { BuildStatus: "BUILT", m: "2025-11", n: novRows.length },
        { BuildStatus: "NOT_BUILT", m: "2025-12", n: decRows.length },
      ]);
      expect(events("STRIPE")).toBe(base.novEvents);
      expect(events("STRIPE", "PostStatus <> 'POSTED'")).toBe(0);
      expect(gl("STRIPE").dr).toBe(base.totalNov);
      expect(count("SELECT 1 FROM ExceptionLog WHERE DataSource = 'STRIPE' AND BatchType = 'BUILD'")).toBe(0);

      // Chạy lại: không còn gì để gỡ
      expect(unbuild({ scope: { dataSource: "STRIPE" } })).toMatchObject({ deletedEvents: 0, postedEventsKept: base.novEvents, rawRowsReset: 0 });
    });

    it("2. import lại dòng đã ghi sổ, sửa tay JournalType (STRIPE_CHARGE / để trống) → từ chối, bảo Unpost + Unbuild", async () => {
      const before = statusOf("RawStripe", target.id);
      expect(before).toMatchObject({ BuildStatus: "BUILT", JournalType: "STRIPE_RECEIPT_CUSTOMER" });
      for (const JournalType of ["STRIPE_CHARGE", ""]) {
        const r = await importSourceFile("stripe", stripeCsv([{ ...target, JournalType }]), "edit.csv");
        expect(r).toMatchObject({ InsertedRows: 0, ReplacedRows: 0, SkippedRows: 0, ErrorRows: 1, LockedRows: 0 });
        expect(r.errors[0]).toMatchObject({ key: target.id });
        expect(r.errors[0].message).toContain("POSTED");
        expect(r.errors[0].message).toContain(`Unpost + Unbuild STRIPE ComCode ${Z} kỳ ${NOV}`);
        expect(statusOf("RawStripe", target.id)).toEqual(before);
      }
      // File giống hệt vẫn bỏ qua như cũ
      expect(await importSourceFile("stripe", stripeCsv(stripeRows), "Bank_Stripe.csv")).toMatchObject({ SkippedRows: 60, ErrorRows: 0 });
    });

    it("2b. DB đã hỏng bởi bug cũ (dòng NOT_BUILT mà còn event POSTED) → Import vẫn chặn theo event", async () => {
      exec("UPDATE RawStripe SET BuildStatus = 'NOT_BUILT', BuildMessage = NULL WHERE SourceKey = ?", target.id);
      const r = await importSourceFile("stripe", stripeCsv([{ ...target, JournalType: "STRIPE_CHARGE" }]), "edit.csv");
      expect(r).toMatchObject({ ReplacedRows: 0, ErrorRows: 1 });
      expect(r.errors[0].message).toContain("Unpost + Unbuild");
      expect(statusOf("RawStripe", target.id).JournalType).toBe("STRIPE_RECEIPT_CUSTOMER");
      exec("UPDATE RawStripe SET BuildStatus = 'BUILT' WHERE SourceKey = ?", target.id);
    });

    it("dòng tháng 12 đã về NOT_BUILT, không còn event → import dòng sửa được nhận; trả lại bản gốc", async () => {
      expect(await importSourceFile("stripe", stripeCsv([{ ...decTarget, JournalType: "STRIPE_CHARGE" }]), "edit.csv")).toMatchObject({
        ReplacedRows: 1,
        ErrorRows: 0,
      });
      expect(statusOf("RawStripe", decTarget.id)).toMatchObject({ BuildStatus: "NOT_BUILT", JournalType: "STRIPE_CHARGE" });
      expect(await importSourceFile("stripe", stripeCsv([decTarget]), "restore.csv")).toMatchObject({ ReplacedRows: 1, ErrorRows: 0 });
      expect(statusOf("RawStripe", decTarget.id).JournalType).toBe("STRIPE_RECEIPT_CUSTOMER");
    });

    it("Build + Post lại sau Unbuild: chỉ tháng 12 sinh event mới, không chặn nhầm; sổ về đúng tổng ban đầu", () => {
      expect(runBuildSource("stripe")).toMatchObject({
        Status: "SUCCESS",
        EventsCreated: base.decEvents,
        EventsReplaced: 0,
        EventsUnchangedPosted: base.novEvents,
        EventsBlocked: 0,
        EventsError: 0,
      });
      expect(sumPosted(runPost("All", { dataSource: "STRIPE" }))).toBe(base.decEvents);
      expect(gl("STRIPE")).toMatchObject({ dr: base.totalAll, cr: base.totalAll });
      expect(built("RawStripe")).toBe(60);
    });

    it("3. Unpost + Unbuild STRIPE → mọi dòng NOT_BUILT; import dòng sửa JournalType được nhận; Build + Post ghi sổ đúng 1 lần", async () => {
      const all = base.novEvents + base.decEvents;
      const r = unbuild({ scope: { dataSource: "STRIPE" }, includePosted: true });
      expect(r).toMatchObject({ deletedEvents: all, postedEventsKept: 0, rawRowsReset: 60 });
      expect(r.unposted).toMatchObject({ events: all });
      expect(built("RawStripe")).toBe(0);
      expect(events("STRIPE")).toBe(0);
      expect(gl("STRIPE").lines).toBe(0);

      const edited = await importSourceFile("stripe", stripeCsv([{ ...target, JournalType: "STRIPE_CHARGE" }]), "edit.csv");
      expect(edited).toMatchObject({ ReplacedRows: 1, ErrorRows: 0 });

      // STRIPE_CHARGE có cùng hình dạng rule với STRIPE_RECEIPT_CUSTOMER (seq 10 Amount + seq 30 Fee) → cùng số event, cùng tổng sổ
      expect(runBuildSource("stripe")).toMatchObject({ Status: "SUCCESS", EventsCreated: all, EventsBlocked: 0, EventsError: 0 });
      expect(sumPosted(runPost("All", { dataSource: "STRIPE" }))).toBe(all);
      expect(sql("SELECT JournalTypeCode, PostStatus, count(*) n FROM AccountingEvent WHERE SourceID = ? GROUP BY 1, 2", sid(target))).toEqual([
        { JournalTypeCode: "STRIPE_CHARGE", PostStatus: "POSTED", n: 2 },
      ]);
      expect(gl("STRIPE")).toMatchObject({ dr: base.totalAll, cr: base.totalAll });
      expect(gl("STRIPE", "JournalTypeCode = 'STRIPE_CHARGE'").dr).toBe(chargeDr(target));
    });

    it("4. dòng POSTED đổi JournalType thẳng trong DB + NOT_BUILT → Build ERROR POSTED_KEY_CHANGED, Post không ghi thêm, event cũ nguyên vẹn", () => {
      const all = base.novEvents + base.decEvents;
      const oldEvents = () => sql("SELECT * FROM AccountingEvent WHERE SourceID = ? AND PostStatus = 'POSTED' ORDER BY AccountingEventID", sid(target2));
      const posted = oldEvents();
      expect(posted).toHaveLength(2);
      const ledger = gl("STRIPE");

      exec("UPDATE RawStripe SET JournalType = 'STRIPE_CHARGE', BuildStatus = 'NOT_BUILT' WHERE SourceKey = ?", target2.id);
      for (let i = 0; i < 2; i++) {
        expect(runBuildSource("stripe")).toMatchObject({
          Status: "SUCCESS",
          EventsCreated: i === 0 ? 2 : 0,
          EventsReplaced: i === 0 ? 0 : 2,
          EventsUnchangedPosted: all - 2,
          EventsBlocked: 2,
          EventsError: 2,
          EventsRemoved: 0,
        });
        expect(sql("SELECT JournalTypeCode, PostStatus, ErrorStage, count(*) n FROM AccountingEvent WHERE SourceID = ? GROUP BY 1, 2, 3 ORDER BY 1", sid(target2))).toEqual([
          { JournalTypeCode: "STRIPE_CHARGE", PostStatus: "ERROR", ErrorStage: "BUILD", n: 2 },
          { JournalTypeCode: "STRIPE_RECEIPT_CUSTOMER", PostStatus: "POSTED", ErrorStage: null, n: 2 },
        ]);
        expect(exceptionsOf("STRIPE", "POSTED_KEY_CHANGED")).toBe(2);
        // Event POSTED cũ đã được thông điệp chặn nhắc tới → không cảnh báo thêm
        expect(exceptionsOf("STRIPE", "POSTED_SOURCE_CHANGED")).toBe(0);

        const posts = runPost("All", { dataSource: "STRIPE" });
        expect(sumPosted(posts)).toBe(0);
        expect(posts.every((p) => p.Status === "NOTHING_TO_POST")).toBe(true);
        expect(gl("STRIPE")).toEqual(ledger);
        expect(oldEvents()).toEqual(posted);
      }
      const message = sql<{ ErrorMessage: string }>("SELECT ErrorMessage FROM AccountingEvent WHERE SourceID = ? AND PostStatus = 'ERROR'", sid(target2))[0].ErrorMessage;
      expect(message).toContain("JournalTypeCode STRIPE_RECEIPT_CUSTOMER → STRIPE_CHARGE");
      expect(message).toContain(`Unpost ComCode ${Z} kỳ ${NOV}`);
    });

    it("4b. làm theo thông điệp: Unpost + Unbuild STRIPE ZENIROXPAY 202511 → Build + Post: dòng ghi sổ đúng 1 lần dưới JournalType mới", () => {
      const r = unbuild({ scope: { dataSource: "STRIPE", comCode: Z, periodFrom: NOV, periodTo: NOV }, includePosted: true });
      expect(r).toMatchObject({ deletedEvents: base.novEvents + 2, rawRowsReset: novRows.length });
      expect(runBuildSource("stripe")).toMatchObject({
        EventsCreated: base.novEvents,
        EventsUnchangedPosted: base.decEvents,
        EventsBlocked: 0,
        EventsError: 0,
      });
      expect(sumPosted(runPost("All", { dataSource: "STRIPE" }))).toBe(base.novEvents);
      expect(exceptionsOf("STRIPE", "POSTED_KEY_CHANGED")).toBe(0);
      expect(sql("SELECT JournalTypeCode, PostStatus, count(*) n FROM AccountingEvent WHERE SourceID = ? GROUP BY 1, 2", sid(target2))).toEqual([
        { JournalTypeCode: "STRIPE_CHARGE", PostStatus: "POSTED", n: 2 },
      ]);
      expect(gl("STRIPE")).toMatchObject({ dr: base.totalAll, cr: base.totalAll });
      expect(gl("STRIPE", "JournalTypeCode = 'STRIPE_CHARGE'").dr).toBe(chargeDr(target, target2));
    });
  });

  describe("5. Unbuild để trống nguồn: Orders (tập kịch bản) + lát Stripe", async () => {
    const { headers, records } = await loadOrderRecords();
    const orderRecords = scenarioRecords(records);
    let base = { totalAll: 0, totalNov: 0, novEvents: 0, decEvents: 0 };

    it("chuẩn bị: Orders import + build + post; Stripe import + build + post, Unpost tháng 12", async () => {
      resetTransactionalData();
      expect(await importOrders(toCsv(headers, orderRecords), "orders-sample.csv")).toMatchObject({ InsertedRows: orderRecords.length, ErrorRows: 0 });
      expect(runBuildOrders()).toMatchObject({ Status: "SUCCESS" });
      runPost("All", { dataSource: "ORDERS" });
      expect(events("ORDERS", "PostStatus = 'POSTED'")).toBeGreaterThan(0);
      base = await stripeFresh();
    });

    it("6. preview Unpost + Unbuild để trống nguồn: rawRowsReset = mọi dòng đã build của Orders + Stripe", () => {
      const r = unbuild({ includePosted: true, preview: true });
      expect(r.rawRowsReset).toBe(built("RawOrders") + built("RawStripe"));
      expect(r.postedEventsKept).toBe(0);
      expect(r.deletedEvents).toBe(count("SELECT 1 FROM AccountingEvent"));
    });

    it("Unbuild để trống nguồn: dòng Stripe không còn event về NOT_BUILT, dòng có event POSTED giữ BUILT; preview = số dòng reset thật", () => {
      const ordersBefore = built("RawOrders");
      const stripeBefore = built("RawStripe");
      const postedBefore = count("SELECT 1 FROM AccountingEvent WHERE PostStatus = 'POSTED'");
      const unposted = count("SELECT 1 FROM AccountingEvent WHERE PostStatus <> 'POSTED'");
      const stripeGl = gl("STRIPE");
      const ordersGl = gl("ORDERS");
      expect(unposted).toBeGreaterThanOrEqual(base.decEvents);

      const preview = unbuild({ preview: true });
      expect(preview).toMatchObject({ deletedEvents: unposted, postedEventsKept: postedBefore });

      const r = unbuild({});
      const ordersReset = ordersBefore - built("RawOrders");
      const stripeReset = stripeBefore - built("RawStripe");
      expect(stripeReset).toBe(decRows.length);
      expect(r).toMatchObject({ deletedEvents: unposted, postedEventsKept: postedBefore, rawRowsReset: ordersReset + stripeReset });
      expect(preview.rawRowsReset).toBe(r.rawRowsReset);

      expect(sql("SELECT BuildStatus, substr(PostingDate, 1, 7) m, count(*) n FROM RawStripe GROUP BY 1, 2 ORDER BY 2")).toEqual([
        { BuildStatus: "BUILT", m: "2025-11", n: novRows.length },
        { BuildStatus: "NOT_BUILT", m: "2025-12", n: decRows.length },
      ]);
      expect(count("SELECT 1 FROM AccountingEvent WHERE PostStatus <> 'POSTED'")).toBe(0);
      expect(count("SELECT 1 FROM AccountingEvent WHERE PostStatus = 'POSTED'")).toBe(postedBefore);
      expect(gl("STRIPE")).toEqual(stripeGl);
      expect(gl("ORDERS")).toEqual(ordersGl);
      expect(count("SELECT 1 FROM ExceptionLog WHERE BatchType = 'BUILD'")).toBe(0);

      // Chạy lại: không còn gì để gỡ
      expect(unbuild({ preview: true })).toMatchObject({ deletedEvents: 0, rawRowsReset: 0 });
    });

    it("dòng Stripe đã ghi sổ vẫn bị Import chặn; Build + Post lại Stripe về đúng tổng ban đầu", async () => {
      const r = await importSourceFile("stripe", stripeCsv([{ ...target, JournalType: "STRIPE_CHARGE" }]), "edit.csv");
      expect(r).toMatchObject({ ReplacedRows: 0, ErrorRows: 1 });
      expect(r.errors[0].message).toContain("Unpost + Unbuild");

      expect(runBuildSource("stripe")).toMatchObject({ EventsCreated: base.decEvents, EventsUnchangedPosted: base.novEvents, EventsBlocked: 0 });
      expect(sumPosted(runPost("All", { dataSource: "STRIPE" }))).toBe(base.decEvents);
      expect(gl("STRIPE")).toMatchObject({ dr: base.totalAll, cr: base.totalAll });
    });

    it("để trống nguồn + phạm vi kỳ 12: exception gom nhóm của Stripe (Period null) cũng bị xóa; preview = chạy thật", () => {
      expect(unpost({ scope: { dataSource: "STRIPE", periodFrom: DEC, periodTo: DEC } })).toMatchObject({ events: base.decEvents });
      // Dòng eur SKIPPED sinh exception gom nhóm SOURCE_ROW_SKIPPED, không có kỳ → exWhere lọc theo kỳ không chạm tới
      expect(count("SELECT 1 FROM ExceptionLog WHERE DataSource = 'STRIPE' AND BatchType = 'BUILD' AND Period IS NULL")).toBeGreaterThan(0);

      const scope = { periodFrom: DEC, periodTo: DEC };
      const preview = unbuild({ scope, preview: true });
      const r = unbuild({ scope });
      expect(r).toMatchObject({ deletedEvents: base.decEvents, rawRowsReset: decRows.length });
      expect(preview.rawRowsReset).toBe(r.rawRowsReset);
      expect(count("SELECT 1 FROM ExceptionLog WHERE DataSource = 'STRIPE' AND BatchType = 'BUILD'")).toBe(0);
      expect(sql("SELECT BuildStatus, substr(PostingDate, 1, 7) m, count(*) n FROM RawStripe GROUP BY 1, 2 ORDER BY 2")).toEqual([
        { BuildStatus: "BUILT", m: "2025-11", n: novRows.length },
        { BuildStatus: "NOT_BUILT", m: "2025-12", n: decRows.length },
      ]);

      // Trả lại trạng thái đầy đủ cho ca sau
      expect(runBuildSource("stripe")).toMatchObject({ EventsCreated: base.decEvents, EventsBlocked: 0 });
      expect(sumPosted(runPost("All", { dataSource: "STRIPE" }))).toBe(base.decEvents);
      expect(gl("STRIPE")).toMatchObject({ dr: base.totalAll, cr: base.totalAll });
    });

    it("để trống nguồn khi ZENIROXPAY 202511 khóa: dòng Stripe tháng 11 giữ BUILT, tính vào lockedRawRows / lockedPeriods", () => {
      expect(unpost({ scope: { dataSource: "STRIPE", periodFrom: DEC, periodTo: DEC } })).toMatchObject({ events: base.decEvents });
      exec("INSERT INTO AccountingPeriod (ComCode, Period, Status, LockedBy, LockedAt, ModifiedDate) VALUES (?, ?, 'LOCKED', 'test', '2026-01-01 00:00:00', '2026-01-01 00:00:00')", Z, NOV);
      try {
        const lockedOrders = built("RawOrders", "ComCode = ? AND substr(FulfilledAt, 1, 7) = '2025-11'", Z);
        const novStripeEvents = () => sql("SELECT * FROM AccountingEvent WHERE DataSource = 'STRIPE' AND Period = ? ORDER BY AccountingEventID", NOV);
        const before = JSON.stringify(novStripeEvents());
        const expected = { lockedRawRows: lockedOrders + novRows.length, lockedPeriods: [`${Z}|${NOV}`] };

        expect(unbuild({ preview: true })).toMatchObject(expected);
        expect(unbuild({ includePosted: true, preview: true })).toMatchObject(expected);
        const r = unbuild({ includePosted: true });
        expect(r).toMatchObject({ ...expected, rawRowsReset: decRows.length });
        expect(r.lockedEvents).toBeGreaterThanOrEqual(base.novEvents);

        expect(JSON.stringify(novStripeEvents())).toBe(before);
        expect(built("RawStripe", "substr(PostingDate, 1, 7) = '2025-11'")).toBe(novRows.length);
        expect(built("RawStripe", "substr(PostingDate, 1, 7) = '2025-12'")).toBe(0);
      } finally {
        exec("DELETE FROM AccountingPeriod");
      }
      expect(runBuildSource("stripe")).toMatchObject({ EventsCreated: base.decEvents, EventsBlocked: 0 });
      expect(sumPosted(runPost("All", { dataSource: "STRIPE" }))).toBe(base.decEvents);
      expect(gl("STRIPE")).toMatchObject({ dr: base.totalAll, cr: base.totalAll });
    });
  });

  describe("7. PayPal: 30 dòng đầu Bank_Paypal.csv", () => {
    const { fields, records } = sourceHead("Bank_Paypal.csv", 30);
    const paypalCsv = (rows: Rec[]) => Buffer.from(Papa.unparse(rows, { columns: fields }), "utf8");
    const first20 = records.slice(0, 20);
    const next10 = records.slice(20, 30);
    const target = first20.find((r) => r.JournalType === "PP_RESERVE_HOLD")!;
    const sourceKey = () => sql<{ SourceKey: string }>("SELECT SourceKey FROM RawPaypal WHERE SourceKey LIKE ?", `${target["Transaction ID"]}|%`)[0].SourceKey;
    let postedEvents = 0;
    let ledger = { lines: 0, dr: null as number | null, cr: null as number | null };

    it("chuẩn bị: import + build + post 20 dòng đầu", async () => {
      expect(records).toHaveLength(30);
      expect(records.every((r) => r.ComCode === Z && r.Currency === "USD")).toBe(true);
      resetTransactionalData();
      expect(await importSourceFile("paypal", paypalCsv(first20), "Bank_Paypal.csv")).toMatchObject({ InsertedRows: 20, ErrorRows: 0 });
      expect(runBuildSource("paypal")).toMatchObject({ Status: "SUCCESS", SourceRows: 20, ErrorRows: 0, EventsBlocked: 0 });
      postedEvents = sumPosted(runPost("All", { dataSource: "PAYPAL" }));
      expect(postedEvents).toBe(events("PAYPAL"));
      ledger = gl("PAYPAL");
      expect(ledger.dr).toBe(ledger.cr);
    });

    it("chốt Build: dòng POSTED đổi JournalType thẳng trong DB → ERROR POSTED_KEY_CHANGED, Post không ghi thêm; trả lại thì hết chặn", () => {
      const key = sourceKey();
      const n = events("PAYPAL", "SourceID = ?", `PAYPAL|${key}`);
      expect(n).toBeGreaterThan(0);
      exec("UPDATE RawPaypal SET JournalType = 'PP_GENERAL_HOLD', BuildStatus = 'NOT_BUILT' WHERE SourceKey = ?", key);
      expect(runBuildSource("paypal")).toMatchObject({ EventsCreated: n, EventsBlocked: n, EventsError: n, EventsUnchangedPosted: postedEvents - n });
      expect(exceptionsOf("PAYPAL", "POSTED_KEY_CHANGED")).toBe(n);
      expect(sumPosted(runPost("All", { dataSource: "PAYPAL" }))).toBe(0);
      expect(gl("PAYPAL")).toEqual(ledger);

      exec("UPDATE RawPaypal SET JournalType = 'PP_RESERVE_HOLD' WHERE SourceKey = ?", key);
      expect(runBuildSource("paypal")).toMatchObject({ EventsCreated: 0, EventsRemoved: n, EventsBlocked: 0, EventsUnchangedPosted: postedEvents });
      expect(exceptionsOf("PAYPAL", "POSTED_KEY_CHANGED")).toBe(0);
      expect(events("PAYPAL")).toBe(postedEvents);
    });

    it("thêm 10 dòng (event NEW) → Unbuild PAYPAL: chỉ 10 dòng mới về NOT_BUILT; import dòng đã ghi sổ sửa JournalType bị chặn", async () => {
      expect(await importSourceFile("paypal", paypalCsv(next10), "Bank_Paypal.csv")).toMatchObject({ InsertedRows: 10, ErrorRows: 0 });
      const r0 = runBuildSource("paypal");
      expect(r0).toMatchObject({ EventsUnchangedPosted: postedEvents, EventsBlocked: 0 });
      const newEvents = r0.EventsCreated;
      expect(newEvents).toBeGreaterThan(0);

      const expected = { deletedEvents: newEvents, postedEventsKept: postedEvents, rawRowsReset: 10 };
      expect(builtWithoutEvents("RawPaypal", "PAYPAL", "e.PostStatus = 'POSTED'")).toBe(10);
      expect(unbuild({ scope: { dataSource: "PAYPAL" }, preview: true })).toMatchObject(expected);
      expect(unbuild({ scope: { dataSource: "PAYPAL" } })).toMatchObject(expected);
      expect(sql("SELECT BuildStatus, count(*) n FROM RawPaypal GROUP BY 1 ORDER BY 1")).toEqual([
        { BuildStatus: "BUILT", n: 20 },
        { BuildStatus: "NOT_BUILT", n: 10 },
      ]);
      expect(events("PAYPAL")).toBe(postedEvents);
      expect(gl("PAYPAL")).toEqual(ledger);

      const edited = await importSourceFile("paypal", paypalCsv([{ ...target, JournalType: "PP_GENERAL_HOLD" }]), "edit.csv");
      expect(edited).toMatchObject({ InsertedRows: 0, ReplacedRows: 0, ErrorRows: 1 });
      expect(edited.errors[0].message).toContain(`Unpost + Unbuild PAYPAL ComCode ${Z} kỳ ${NOV}`);
      expect(statusOf("RawPaypal", sourceKey())).toMatchObject({ BuildStatus: "BUILT", JournalType: "PP_RESERVE_HOLD" });
    });
  });
});

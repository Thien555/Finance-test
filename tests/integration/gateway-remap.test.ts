/**
 * Đổi GatewayCompanyMapping của cổng đã post → Build không được tạo event NEW để Post ghi sổ lần 2.
 * Quy trình đúng: Unpost chứng từ cũ → Build → Post; tổng sổ cái không đổi, chỉ chuyển sang ComCode mới.
 *
 * Chạy trên tập con kịch bản cắt từ file thật (431 dòng, thuần kỳ 202511) — xem `scenarioRows` trong
 * tests/helpers/fixtures.ts. Cả file 55k dòng sẽ mất nhiều phút mỗi vòng build/post mà không kiểm thêm gì.
 */
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dbFile = path.join(os.tmpdir(), `finance-remap-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = dbFile;

const STRIPE = "ZeniroxPay - Stripe";
/** Số event của tập con: 403 đơn fulfilled × (PRODUCT + SHIPADD + SELLER_PROFIT), trừ dòng ShipAdd = 0 */
const EVENTS = 1_205;
/** Event của 41 đơn trả qua cổng Stripe — phần chuyển sang ONTARIO khi đổi mapping */
const STRIPE_EVENTS = 123;

describe("đổi mapping cổng thanh toán sau khi đã post", async () => {
  const { importOrders } = await import("@/lib/services/import-orders");
  const { runBuildOrders } = await import("@/lib/services/build");
  const { runPost } = await import("@/lib/services/post");
  const { unpost } = await import("@/lib/services/clear");
  const { upsertGatewayMapping } = await import("@/lib/services/master");
  const { getDb, closeDb } = await import("@/lib/db/client");
  const { loadOrderRecords, scenarioRecords, seedTestCompanies, toCsv } = await import("../helpers/fixtures");
  seedTestCompanies(getDb());

  const { headers, records } = await loadOrderRecords();
  const sample = toCsv(headers, scenarioRecords(records));

  afterAll(() => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(dbFile + suffix, { force: true });
  });

  const sql = <T>(query: string) => getDb().$client.prepare(query).all() as T[];
  const glByComCode = () =>
    Object.fromEntries(
      sql<{ ComCode: string; dr: number; cr: number; lines: number }>(
        "SELECT ComCode, round(sum(AccountedDr), 2) dr, round(sum(AccountedCr), 2) cr, count(*) lines FROM GLTrans GROUP BY ComCode",
      ).map((r) => [r.ComCode, { dr: r.dr, cr: r.cr, lines: r.lines }]),
    );
  const exceptionCount = (type: string) =>
    sql<{ n: number }>(`SELECT count(*) n FROM ExceptionLog WHERE ExceptionType = '${type}'`)[0].n;

  it("baseline: import + build + post", async () => {
    expect(await importOrders(sample, "subset.csv")).toMatchObject({ Status: "SUCCESS", TotalRows: 431, InsertedRows: 431, ErrorRows: 0 });
    expect(runBuildOrders()).toMatchObject({ Status: "SUCCESS", EventsCreated: EVENTS, EventsBlocked: 0 });
    expect(runPost("All")[1]).toMatchObject({ Status: "SUCCESS", PostedEvents: EVENTS, Documents: 50, InsertedRows: 100 });
    expect(glByComCode()).toEqual({ ZENIROXPAY: { dr: 43227.58, cr: 43227.58, lines: 100 } });
  });

  it("đổi mapping Stripe → ONTARIO rồi Build: event bị chặn ERROR, không event NEW", () => {
    const [m] = sql<{ ID: number }>(`SELECT ID FROM GatewayCompanyMapping WHERE PaymentGatewayName = '${STRIPE}'`);
    upsertGatewayMapping({ ID: m.ID, PaymentGatewayName: STRIPE, ComCode: "ONTARIO", IsActive: 1 });

    expect(runBuildOrders()).toMatchObject({
      Status: "SUCCESS",
      EventsCreated: STRIPE_EVENTS,
      EventsBlocked: STRIPE_EVENTS,
      EventsError: STRIPE_EVENTS,
      EventsUnchangedPosted: EVENTS - STRIPE_EVENTS,
      EventsRemoved: 0,
    });
    expect(sql("SELECT PostStatus, ErrorStage, count(*) n FROM AccountingEvent WHERE ComCode = 'ONTARIO' GROUP BY 1, 2")).toEqual([
      { PostStatus: "ERROR", ErrorStage: "BUILD", n: STRIPE_EVENTS },
    ]);
    expect(exceptionCount("POSTED_KEY_CHANGED")).toBe(STRIPE_EVENTS);
  });

  it("Post sau đó không ghi sổ trùng", () => {
    const [single, bulk] = runPost("All");
    expect(single.Status).toBe("NOTHING_TO_POST");
    expect(bulk.Status).toBe("NOTHING_TO_POST");
    expect(glByComCode()).toEqual({ ZENIROXPAY: { dr: 43227.58, cr: 43227.58, lines: 100 } });
  });

  it("Build lại lần nữa vẫn chặn, exception không nhân đôi", () => {
    expect(runBuildOrders()).toMatchObject({ EventsCreated: 0, EventsReplaced: STRIPE_EVENTS, EventsBlocked: STRIPE_EVENTS });
    expect(exceptionCount("POSTED_KEY_CHANGED")).toBe(STRIPE_EVENTS);
    expect(sql<{ n: number }>("SELECT count(*) n FROM AccountingEvent")[0].n).toBe(EVENTS + STRIPE_EVENTS);
  });

  it("làm theo message với phạm vi ComCode CŨ: Unpost + Build + Post theo ZENIROXPAY kỳ 202511 → dọn event cũ, mở chặn ONTARIO", () => {
    const scope = { comCode: "ZENIROXPAY", periodFrom: "202511", periodTo: "202511" };
    expect(unpost({ scope })).toMatchObject({ events: EVENTS, glLines: 100 });

    expect(runBuildOrders(scope)).toMatchObject({
      EventsBlocked: 0,
      EventsRemoved: STRIPE_EVENTS,
      EventsReplaced: EVENTS,
      EventsError: 0,
    });
    expect(exceptionCount("POSTED_KEY_CHANGED")).toBe(0);

    expect(runPost("All", scope)[1]).toMatchObject({ Status: "SUCCESS", PostedEvents: EVENTS - STRIPE_EVENTS });
    expect(glByComCode()).toEqual({ ZENIROXPAY: { dr: 39250.9, cr: 39250.9, lines: 100 } });

    expect(runPost("All", { comCode: "ONTARIO" })[1]).toMatchObject({ Status: "SUCCESS", PostedEvents: STRIPE_EVENTS });
    const gl = glByComCode();
    expect(gl).toEqual({
      ONTARIO: { dr: 3976.68, cr: 3976.68, lines: 22 },
      ZENIROXPAY: { dr: 39250.9, cr: 39250.9, lines: 100 },
    });
    // Tổng sổ cái không đổi sau khi chuyển công ty, chỉ tách ra 2 ComCode
    expect(gl.ONTARIO.dr + gl.ZENIROXPAY.dr).toBeCloseTo(43227.58, 2);
    expect(sql<{ n: number }>("SELECT count(*) n FROM AccountingEvent WHERE PostStatus = 'POSTED'")[0].n).toBe(EVENTS);
    expect(runBuildOrders()).toMatchObject({ EventsBlocked: 0, EventsUnchangedPosted: EVENTS, Exceptions: 435 });
  });
});

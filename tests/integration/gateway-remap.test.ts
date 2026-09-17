/**
 * Đổi GatewayCompanyMapping của cổng đã post → Build không được tạo event NEW để Post ghi sổ lần 2.
 * Quy trình đúng: Unpost chứng từ cũ → Build → Post; tổng sổ cái không đổi, chỉ chuyển sang ComCode mới.
 */
import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dbFile = path.join(os.tmpdir(), `finance-remap-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = dbFile;

const sample = readFileSync(path.join(process.cwd(), "data", "samples", "orders-sample.csv"));
const STRIPE = "ZeniroxPay - Stripe";

describe("đổi mapping cổng thanh toán sau khi đã post", async () => {
  const { importOrders } = await import("@/lib/services/import-orders");
  const { runBuildOrders } = await import("@/lib/services/build");
  const { runPost } = await import("@/lib/services/post");
  const { unpost } = await import("@/lib/services/clear");
  const { upsertGatewayMapping } = await import("@/lib/services/master");
  const { getDb, closeDb } = await import("@/lib/db/client");

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
    await importOrders(sample, "orders-sample.csv");
    expect(runBuildOrders()).toMatchObject({ Status: "SUCCESS", EventsCreated: 174, EventsBlocked: 0 });
    expect(runPost("All")[1]).toMatchObject({ Status: "SUCCESS", PostedEvents: 174, InsertedRows: 42 });
    expect(glByComCode()).toEqual({ ZENIROXPAY: { dr: 6339.7, cr: 6339.7, lines: 42 } });
  });

  it("đổi mapping Stripe → ONTARIO rồi Build: 12 event bị chặn ERROR, không event NEW", () => {
    const [m] = sql<{ ID: number }>(`SELECT ID FROM GatewayCompanyMapping WHERE PaymentGatewayName = '${STRIPE}'`);
    upsertGatewayMapping({ ID: m.ID, PaymentGatewayName: STRIPE, ComCode: "ONTARIO", IsActive: 1 });

    expect(runBuildOrders()).toMatchObject({
      Status: "SUCCESS",
      EventsCreated: 12,
      EventsBlocked: 12,
      EventsError: 12,
      EventsUnchangedPosted: 162,
      EventsRemoved: 0,
    });
    expect(sql("SELECT PostStatus, ErrorStage, count(*) n FROM AccountingEvent WHERE ComCode = 'ONTARIO' GROUP BY 1, 2")).toEqual([
      { PostStatus: "ERROR", ErrorStage: "BUILD", n: 12 },
    ]);
    expect(exceptionCount("POSTED_KEY_CHANGED")).toBe(12);
  });

  it("Post sau đó không ghi sổ trùng", () => {
    const [single, bulk] = runPost("All");
    expect(single.Status).toBe("NOTHING_TO_POST");
    expect(bulk.Status).toBe("NOTHING_TO_POST");
    expect(glByComCode()).toEqual({ ZENIROXPAY: { dr: 6339.7, cr: 6339.7, lines: 42 } });
  });

  it("Build lại lần nữa vẫn chặn, exception không nhân đôi", () => {
    expect(runBuildOrders()).toMatchObject({ EventsCreated: 0, EventsReplaced: 12, EventsBlocked: 12 });
    expect(exceptionCount("POSTED_KEY_CHANGED")).toBe(12);
    expect(sql<{ n: number }>("SELECT count(*) n FROM AccountingEvent")[0].n).toBe(186);
  });

  it("làm theo message với phạm vi ComCode CŨ: Unpost + Build + Post theo ZENIROXPAY kỳ 202511 → dọn event cũ, mở chặn ONTARIO", () => {
    const scope = { comCode: "ZENIROXPAY", periodFrom: "202511", periodTo: "202511" };
    expect(unpost({ scope })).toMatchObject({ events: 174, glLines: 42 });

    expect(runBuildOrders(scope)).toMatchObject({ EventsBlocked: 0, EventsRemoved: 12, EventsReplaced: 174, EventsError: 0 });
    expect(exceptionCount("POSTED_KEY_CHANGED")).toBe(0);

    expect(runPost("All", scope)[1]).toMatchObject({ Status: "SUCCESS", PostedEvents: 162 });
    expect(glByComCode()).toEqual({ ZENIROXPAY: { dr: 5838.3, cr: 5838.3, lines: 42 } });

    expect(runPost("All", { comCode: "ONTARIO" })[1]).toMatchObject({ Status: "SUCCESS", PostedEvents: 12 });
    expect(glByComCode()).toEqual({
      ONTARIO: { dr: 501.4, cr: 501.4, lines: 6 },
      ZENIROXPAY: { dr: 5838.3, cr: 5838.3, lines: 42 },
    });
    expect(sql<{ n: number }>("SELECT count(*) n FROM AccountingEvent WHERE PostStatus = 'POSTED'")[0].n).toBe(174);
    expect(runBuildOrders()).toMatchObject({ EventsBlocked: 0, EventsUnchangedPosted: 174, Exceptions: 70 });
  });
});

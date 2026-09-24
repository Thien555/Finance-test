import { describe, expect, it } from "vitest";
import type { AccountingEventRow } from "@/lib/db/schema";
import { buildOrderEvents, ORDERS_DATA_SOURCE } from "@/lib/engine/build-orders";
import { findDuplicateItems } from "@/lib/engine/post-guard";
import { loadIndex, loadSampleOrders, scenarioRows, toEventRows } from "../helpers/fixtures";

const STRIPE = "ZeniroxPay - Stripe";
// Logic này xét theo từng item nên chạy trên tập con kịch bản (431 dòng, thuần kỳ 202511)
// thay vì 156k event của cả file — cùng ý nghĩa, nhanh hơn hàng trăm lần.
const rows = scenarioRows(await loadSampleOrders());
const drafts = buildOrderEvents(rows, loadIndex()).events;
const stripeOrderIds = new Set(rows.filter((r) => r.PaymentGatewayName === STRIPE).map((r) => r.OrderId));

const fresh = () => toEventRows(drafts);
const posted = () => fresh().map((e) => ({ ...e, PostStatus: "POSTED", PostedDocNum: `ASB-TEST-${e.AccountingEventID}` }));
/** Bản sao event của các đơn Stripe dưới khóa khác (ComCode/ngày giao khác), id mới */
const copies = (events: AccountingEventRow[], change: Partial<AccountingEventRow>, startId = 5000) =>
  events
    .filter((e) => stripeOrderIds.has(e.OrderID!))
    .map((e, i) => ({ ...e, AccountingEventID: startId + i, PostStatus: "NEW", PostedDocNum: null, ErrorStage: null, ...change }));
const guard = (candidates: AccountingEventRow[], others: AccountingEventRow[]) => findDuplicateItems(candidates, others, [ORDERS_DATA_SOURCE]);

/** Số event của các đơn trả qua cổng Stripe trong tập con — mọi kỳ vọng "bị giữ" đều bằng con số này */
const stripeEvents = drafts.filter((e) => stripeOrderIds.has(e.OrderID!)).length;

describe("findDuplicateItems — chốt chặn ghi sổ trùng khi Post", () => {
  it("tập con kịch bản đúng kích thước mong đợi", () => {
    expect(rows).toHaveLength(431);
    expect(drafts).toHaveLength(1_205);
    expect(stripeOrderIds.size).toBe(41);
    expect(stripeEvents).toBe(123);
  });

  it("dữ liệu bình thường (nhiều nghiệp vụ cùng đơn, cùng ngày giao) → không giữ event nào", () => {
    const events = fresh();
    expect(guard(events, events).size).toBe(0);

    // Một phần đã POSTED, phần còn lại chờ post
    const mixed = events.map((e) => (e.JournalTypeCode === "ORD_REV_PRODUCT_FULFILLED" ? { ...e, PostStatus: "POSTED" } : e));
    expect(guard(mixed.filter((e) => e.PostStatus === "NEW"), mixed).size).toBe(0);
  });

  it("item đã POSTED ở công ty khác → giữ event chờ post", () => {
    const dup = copies(posted(), { ComCode: "ONTARIO" });
    const held = guard(dup, [...posted(), ...dup]);
    expect(dup).toHaveLength(stripeEvents);
    expect(held.size).toBe(stripeEvents);
    expect([...held.values()].every((m) => m.includes("đã ghi sổ ở event") && m.includes("ComCode ZENIROXPAY"))).toBe(true);
  });

  it("item đã POSTED ở ngày giao khác → giữ event chờ post", () => {
    const dup = copies(posted(), { SourceID: "X|20251122", TransactionID: "ORD-X-20251122" });
    expect(guard(dup, [...posted(), ...dup]).size).toBe(stripeEvents);
  });

  it("2 event cùng chờ post, trùng item, khác công ty → giữ cả hai (kể cả khi bản kia ngoài phạm vi post)", () => {
    const events = fresh();
    const dup = copies(events, { ComCode: "ONTARIO" });
    const held = guard([...events, ...dup], [...events, ...dup]);
    expect(held.size).toBe(2 * stripeEvents);
    expect([...held.values()].every((m) => m.includes("không post cả hai"))).toBe(true);

    // Chỉ post ONTARIO: bản ZENIROXPAY chưa post vẫn làm giữ ONTARIO
    expect(guard(dup, [...events, ...dup]).size).toBe(stripeEvents);
  });

  it("event bị chặn ở Build (ERROR/BUILD) hoặc SKIPPED không làm giữ event khác", () => {
    const events = fresh();
    const blocked = copies(events, { ComCode: "ONTARIO", PostStatus: "ERROR", ErrorStage: "BUILD" });
    const skipped = copies(events, { ComCode: "NEWCO", PostStatus: "SKIPPED", ErrorStage: "POST" }, 6000);
    expect(guard(events, [...events, ...blocked, ...skipped]).size).toBe(0);
  });

  it("event ERROR do lần Post trước vẫn được coi là chờ post", () => {
    const events = fresh();
    const dup = copies(events, { ComCode: "ONTARIO", PostStatus: "ERROR", ErrorStage: "POST" });
    expect(guard(events, [...events, ...dup]).size).toBe(stripeEvents);
  });

  it("event Orders chưa có ItemCodes (tạo trước khi có cột) → giữ, phải Build lại; nguồn khác không bắt buộc", () => {
    const legacy = fresh().map((e) => ({ ...e, ItemCodes: null }));
    const held = guard(legacy, legacy);
    expect(held.size).toBe(legacy.length);
    expect([...held.values()][0]).toContain("Build lại");

    const other = legacy.map((e) => ({ ...e, DataSource: "PAYPAL" }));
    expect(guard(other, other).size).toBe(0);
  });
});

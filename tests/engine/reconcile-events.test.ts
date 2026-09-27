import { describe, expect, it } from "vitest";
import type { AccountingEventRow, RawOrderRow, RawStripeRow } from "@/lib/db/schema";
import { buildBankEvents } from "@/lib/engine/build-bank";
import { buildOrderEvents, orderRowsInScope } from "@/lib/engine/build-orders";
import { orderSourceId } from "@/lib/engine/keys";
import type { MasterIndex } from "@/lib/engine/masters";
import { parseLockKey, PeriodLocks } from "@/lib/engine/period-lock";
import { reconcileEvents, type ReconcileInput } from "@/lib/engine/reconcile-events";
import { stripeSpec } from "@/lib/engine/sources/stripe";
import type { EventDraft } from "@/lib/engine/types";
import {
  loadIndex,
  loadMasters,
  loadSampleOrders,
  loadSampleStripe,
  SCENARIO_FREE_DAY,
  scenarioRows,
  TEST_COMPANIES,
  TEST_GATEWAY_MAPPINGS,
  toEventRows,
} from "../helpers/fixtures";

const STRIPE = "ZeniroxPay - Stripe";
const MAIN_ORDER = "QVAJV-191125-Q1Z3V";
const MAIN_TXN = "ORD-QVAJV-191125-Q1Z3V-20251121";

// File này gọi plan() ~55 lần; chạy trên tập con kịch bản (431 dòng, thuần kỳ 202511)
// thay vì 55k dòng — cùng ý nghĩa, mỗi lần ~40ms thay vì hàng chục giây.
const rows = scenarioRows(await loadSampleOrders());
const baseIndex = loadIndex();
const baseDrafts = buildOrderEvents(rows, baseIndex).events;
const main = rows.find((r) => r.OrderId === MAIN_ORDER)!;
const stripeOrderIds = new Set(rows.filter((r) => r.PaymentGatewayName === STRIPE).map((r) => r.OrderId));

/** Mọi kỳ vọng số lượng suy từ chính dữ liệu, không ghi cứng theo kích thước file */
const TOTAL = baseDrafts.length;
const jtcCount = (code: string) => baseDrafts.filter((e) => e.JournalTypeCode === code).length;
const STRIPE_EVENTS = baseDrafts.filter((e) => stripeOrderIds.has(e.OrderID ?? "")).length;
const PRODUCT_EVENTS = jtcCount("ORD_REV_PRODUCT_FULFILLED");
const PROFIT_EVENTS = jtcCount("ORD_SELLER_PROFIT_FULFILLED");
/** Đơn mốc luôn sinh đúng 3 event (PRODUCT + SHIPADD + SELLER_PROFIT) */
const MAIN_EVENTS = 3;

type Mapping = { PaymentGatewayName: string; ComCode: string; IsActive: number };

/** MasterIndex với GatewayCompanyMapping tùy biến (+ company NEWCO) */
function indexWith(change: (mappings: Mapping[]) => Mapping[]): MasterIndex {
  return loadIndex({
    gatewayMappings: change(TEST_GATEWAY_MAPPINGS.map((g) => ({ ...g }))).map((g, i) => ({ ID: i + 1, ...g })),
    companies: [...TEST_COMPANIES, { ComCode: "NEWCO", CompanyName: "NewCo", FunctionalCurrency: "USD", IsActive: 1 }],
  });
}
const remap = (name: string, comCode: string) => (ms: Mapping[]) => ms.map((m) => (m.PaymentGatewayName === name ? { ...m, ComCode: comCode } : m));
const stripeToOntario = () => indexWith(remap(STRIPE, "ONTARIO"));

const asPosted = (events: AccountingEventRow[]): AccountingEventRow[] =>
  events.map((e) => ({ ...e, PostStatus: "POSTED", PostedDocNum: `ASB-TEST-${e.AccountingEventID}` }));
const postedBase = () => asPosted(toEventRows(baseDrafts));
const rowsOf = (drafts: EventDraft[], startId: number, override: Partial<AccountingEventRow> = {}) =>
  toEventRows(drafts, startId).map((e) => ({ ...e, ...override }));

type IsLocked = NonNullable<ReconcileInput<EventDraft>["isLocked"]>;
/** isLocked từ danh sách kỳ khóa "COMCODE|YYYYMM" — đi qua PeriodLocks như services */
const lockedAt = (...keys: string[]): IsLocked => {
  const locks = new PeriodLocks(keys.map(parseLockKey));
  return (x) => locks.isLocked(x);
};
const byNumber = (a: number, b: number) => a - b;

/**
 * Mô phỏng runBuildOrders: phạm vi trọn đơn; load event theo OrderID (đơn đang build + đơn có event trong phạm vi):
 * SourceID đang build / đã chết → existing; SourceID còn dòng nguồn ngoài phạm vi → relatedPosted (POSTED, hoặc thuộc kỳ khóa).
 * `isLocked`: kỳ khóa sổ (không truyền = như trước khi có khóa sổ). Orders không truyền `oneEventSetPerSource`.
 */
function planInput(
  index: MasterIndex,
  allRows: RawOrderRow[],
  dbEvents: AccountingEventRow[],
  scopeComCode: string | null = null,
  isLocked?: IsLocked,
): ReconcileInput<EventDraft> {
  const scopeEvents = scopeComCode ? dbEvents.filter((e) => e.ComCode === scopeComCode) : dbEvents;
  const scoped = orderRowsInScope(allRows, index, scopeComCode, scopeComCode ? scopeEvents.map((e) => e.SourceID ?? "") : []);
  const sourceIds = new Set(scoped.filter((r) => r.FulfilledAt).map((r) => orderSourceId(r.OrderId, r.FulfilledAt!)));
  const live = new Set(allRows.filter((r) => r.FulfilledAt).map((r) => orderSourceId(r.OrderId, r.FulfilledAt!)));
  const orderIds = new Set([...scoped.map((r) => r.OrderId), ...scopeEvents.map((e) => e.OrderID ?? "")]);
  const orderEvents = dbEvents.filter((e) => orderIds.has(e.OrderID ?? ""));
  const sid = (e: AccountingEventRow) => e.SourceID ?? "";
  const deadSourceIds = new Set(orderEvents.map(sid).filter((s) => !sourceIds.has(s) && !live.has(s)));
  return {
    drafts: buildOrderEvents(scoped, index).events,
    existing: orderEvents.filter((e) => sourceIds.has(sid(e)) || deadSourceIds.has(sid(e))),
    relatedPosted: orderEvents.filter(
      (e) => (e.PostStatus === "POSTED" || !!isLocked?.(e)) && !sourceIds.has(sid(e)) && !deadSourceIds.has(sid(e)),
    ),
    deadSourceIds,
    isLocked,
  };
}
const plan = (...args: Parameters<typeof planInput>) => reconcileEvents(planInput(...args));
type Plan = ReturnType<typeof plan>;
const ofType = (p: Plan, type: string) => p.exceptions.filter((x) => x.ExceptionType === type);
const written = (p: Plan) => [...p.insert, ...p.replace.map((r) => r.draft)];

/** Đơn chính tách thành 2 item cùng OrderId + ngày giao: item gốc qua gateway `mainGateway`, item -B qua `secondGateway` */
function splitOrder(mainGateway: string, secondGateway: string): RawOrderRow[] {
  return [
    ...rows.map((r) => (r.OrderId === MAIN_ORDER ? { ...r, PaymentGatewayName: mainGateway } : r)),
    { ...main, RawOrderID: 9001, ItemCode: `${main.ItemCode}-B`, PaymentGatewayName: secondGateway },
  ];
}

describe("reconcileEvents — build lại bình thường", () => {
  it("không đổi gì sau khi post → giữ nguyên, không chặn, không cảnh báo", () => {
    expect(plan(baseIndex, rows, postedBase())).toMatchObject({
      unchangedPosted: TOTAL,
      blocked: 0,
      insert: [],
      replace: [],
      remove: [],
      exceptions: [],
    });
  });

  it("chưa post → thay thế toàn bộ, không xóa", () => {
    const p = plan(baseIndex, rows, toEventRows(baseDrafts));
    expect(p).toMatchObject({ unchangedPosted: 0, blocked: 0, insert: [], remove: [], exceptions: [] });
    expect(p.replace).toHaveLength(TOTAL);
  });

  it("event lưu ItemCodes của các dòng nguồn", () => {
    expect(baseDrafts.find((d) => d.TransactionID === MAIN_TXN)!.ItemCodes).toBe(JSON.stringify([main.ItemCode]));
  });

  it("thêm rule mới trong khi rule đã post vẫn còn → tạo NEW, không chặn", () => {
    const masters = loadMasters();
    const product = masters.lineRules.find((r) => r.JournalTypeCode === "ORD_REV_PRODUCT_FULFILLED")!;
    const index = loadIndex({ lineRules: [...masters.lineRules, { ...product, JournalLineRuleID: 9999, RuleSeq: 30 }] });
    const p = plan(index, rows, postedBase());

    expect(p).toMatchObject({ blocked: 0, unchangedPosted: TOTAL, exceptions: [] });
    expect(p.insert).toHaveLength(PRODUCT_EVENTS);
    expect(p.insert.every((e) => e.EventSeq === 30 && e.PostStatus === "NEW")).toBe(true);
  });
});

describe("chống ghi sổ trùng: cả đơn đổi công ty sau khi post", () => {
  it("đổi GatewayCompanyMapping → draft ComCode mới bị giữ ERROR, không có event NEW nào", () => {
    const p = plan(stripeToOntario(), rows, postedBase());

    expect(stripeOrderIds.size).toBe(41);
    expect(p).toMatchObject({ blocked: STRIPE_EVENTS, unchangedPosted: TOTAL - STRIPE_EVENTS, replace: [], remove: [] });
    expect(p.insert).toHaveLength(STRIPE_EVENTS);
    for (const e of p.insert) {
      expect(e).toMatchObject({ ComCode: "ONTARIO", PostStatus: "ERROR", ErrorStage: "BUILD" });
      expect(stripeOrderIds.has(e.OrderID!)).toBe(true);
      expect(e.ErrorMessage).toContain("ComCode ZENIROXPAY → ONTARIO");
      expect(e.ErrorMessage).toMatch(/Unpost ComCode ZENIROXPAY kỳ 202511 rồi Build \+ Post lại \(Post cả ComCode ONTARIO\)/);
    }
    const keyChanged = ofType(p, "POSTED_KEY_CHANGED");
    expect(keyChanged).toHaveLength(STRIPE_EVENTS);
    expect(keyChanged.every((x) => x.Severity === "ERROR" && x.ComCode === "ONTARIO")).toBe(true);
    expect(new Set(keyChanged.map((x) => x.SourceKey)).size).toBe(STRIPE_EVENTS);
    expect(ofType(p, "POSTED_SOURCE_CHANGED")).toHaveLength(0);
  });

  it("Build theo ComCode mới vẫn chặn", () => {
    const p = plan(stripeToOntario(), rows, postedBase(), "ONTARIO");
    expect(p.blocked).toBe(STRIPE_EVENTS);
    expect(written(p).every((e) => e.PostStatus === "ERROR")).toBe(true);
  });

  it("dữ liệu đã bị nhân đôi từ trước (event NEW dưới ComCode mới) → chuyển sang ERROR", () => {
    const index = stripeToOntario();
    const duplicates = rowsOf(
      buildOrderEvents(rows, index).events.filter((d) => d.ComCode === "ONTARIO"),
      5000,
    );
    const p = plan(index, rows, [...postedBase(), ...duplicates]);
    expect(p).toMatchObject({ blocked: STRIPE_EVENTS, insert: [] });
    expect(p.replace.every((r) => r.id >= 5000 && r.draft.PostStatus === "ERROR")).toBe(true);
  });

  it("event POSTED cũ chưa có ItemCodes (trước khi có cột) → vẫn chặn", () => {
    const legacy = postedBase().map((e) => ({ ...e, ItemCodes: null }));
    const p = plan(stripeToOntario(), rows, legacy);
    expect(p.blocked).toBe(STRIPE_EVENTS);
    expect(p.insert[0].ErrorMessage).toContain("tạo trước khi có cột ItemCodes");
    expect(plan(baseIndex, rows, legacy)).toMatchObject({ blocked: 0, exceptions: [] });
  });

  it("item đến muộn trên cổng cũ sau khi đã bị chặn → vẫn chặn, không bật lại NEW", () => {
    const index = stripeToOntario();
    const blocked = plan(index, rows, postedBase()).insert;
    const db = [...postedBase(), ...rowsOf(blocked, 5000, { PostStatus: "ERROR", ErrorStage: "BUILD" })];
    const stripeRow = rows.find((r) => r.PaymentGatewayName === STRIPE)!;
    const late = [...rows, { ...stripeRow, RawOrderID: 9100, ItemCode: `${stripeRow.ItemCode}-LATE`, PaymentGatewayName: "ZeniroxPay Inc." }];

    const p = plan(index, late, db);
    expect(p.blocked).toBe(STRIPE_EVENTS);
    expect(written(p).filter((e) => e.ComCode === "ONTARIO").every((e) => e.PostStatus === "ERROR")).toBe(true);
  });

  it("sau khi Unpost chứng từ cũ → event cũ bị xóa, event mới NEW, hết chặn", () => {
    const unposted = toEventRows(baseDrafts);
    const p = plan(stripeToOntario(), rows, unposted);
    const oldStripeIds = unposted.filter((e) => stripeOrderIds.has(e.OrderID!)).map((e) => e.AccountingEventID);

    expect(p).toMatchObject({ blocked: 0, exceptions: [] });
    expect(p.remove.sort()).toEqual(oldStripeIds.sort());
    expect(p.insert).toHaveLength(STRIPE_EVENTS);
    expect(p.insert.every((e) => e.ComCode === "ONTARIO" && e.PostStatus === "NEW")).toBe(true);
  });

  it("sau khi Unpost, Build theo ComCode CŨ cũng dọn được event cũ và mở chặn event mới", () => {
    const index = stripeToOntario();
    const blocked = plan(index, rows, postedBase()).insert;
    const db = [...toEventRows(baseDrafts), ...rowsOf(blocked, 5000, { PostStatus: "ERROR", ErrorStage: "BUILD" })];

    const p = plan(index, rows, db, "ZENIROXPAY");
    expect(p).toMatchObject({ blocked: 0, exceptions: [] });
    expect(p.remove).toHaveLength(STRIPE_EVENTS);
    const ontario = p.replace.filter((r) => r.draft.ComCode === "ONTARIO");
    expect(ontario).toHaveLength(STRIPE_EVENTS);
    expect(ontario.every((r) => r.id >= 5000 && r.draft.PostStatus === "NEW")).toBe(true);
  });
});

describe("chống ghi sổ trùng: khóa đổi vì cấu hình / ngày giao", () => {
  it("đổi RuleSeq của rule đã post → chặn", () => {
    const masters = loadMasters();
    const index = loadIndex({
      lineRules: masters.lineRules.map((r) => (r.JournalTypeCode === "ORD_SELLER_PROFIT_FULFILLED" ? { ...r, RuleSeq: 25 } : r)),
    });
    const p = plan(index, rows, postedBase());

    expect(p).toMatchObject({ blocked: PROFIT_EVENTS, unchangedPosted: TOTAL - PROFIT_EVENTS });
    expect(p.insert.every((e) => e.EventSeq === 25 && e.PostStatus === "ERROR")).toBe(true);
    expect(p.insert[0].ErrorMessage).toContain("EventSeq 20 → 25");
    expect(ofType(p, "POSTED_SOURCE_CHANGED")).toHaveLength(0);
  });

  it("JournalTypeCode đổi cách viết hoa/thường → chặn, SourceKey exception luôn viết hoa để build sau xóa được", () => {
    const masters = loadMasters();
    const index = loadIndex({
      journalTypes: masters.journalTypes.map((j) =>
        j.JournalTypeCode === "ORD_REV_PRODUCT_FULFILLED" ? { ...j, JournalTypeCode: "Ord_Rev_Product_Fulfilled" } : j,
      ),
    });
    const p = plan(index, rows, postedBase());
    expect(p.blocked).toBe(PRODUCT_EVENTS);
    expect(ofType(p, "POSTED_KEY_CHANGED").every((x) => x.SourceKey!.endsWith("|ORD_REV_PRODUCT_FULFILLED"))).toBe(true);
  });

  it("item đã POSTED được build lại ở ngày giao khác (TransactionID khác) → chặn", () => {
    const redated = rows.map((r) => (r.OrderId === MAIN_ORDER ? { ...r, FulfilledAt: SCENARIO_FREE_DAY } : r));
    const p = plan(baseIndex, redated, postedBase());

    const mainDrafts = written(p).filter((e) => e.OrderID === MAIN_ORDER);
    expect(mainDrafts).toHaveLength(3);
    expect(mainDrafts.every((e) => e.PostStatus === "ERROR")).toBe(true);
    expect(mainDrafts[0].ErrorMessage).toContain(`TransactionID ${MAIN_TXN} → ORD-QVAJV-191125-Q1Z3V-${SCENARIO_FREE_DAY.replaceAll("-", "")}`);
    expect(p.blocked).toBe(3);
  });
});

describe("chống ghi sổ trùng: đổi ngày giao", () => {
  // 2025-11-22 đã có dữ liệu thật trong tập con → dời sang ngày trống cùng kỳ 202511
  const MAIN_TXN_22 = `ORD-QVAJV-191125-Q1Z3V-${SCENARIO_FREE_DAY.replaceAll("-", "")}`;
  const redate = (list: RawOrderRow[], itemCode: string) => list.map((r) => (r.ItemCode === itemCode ? { ...r, FulfilledAt: SCENARIO_FREE_DAY } : r));

  it("1 item của đơn chuyển sang ngày khác, ngày cũ vẫn còn item → cả 2 ngày cùng build vẫn chặn item đã chuyển", () => {
    const twoItems = [...rows, { ...main, RawOrderID: 9001, ItemCode: `${main.ItemCode}-2` }];
    const db = asPosted(toEventRows(buildOrderEvents(twoItems, baseIndex).events));

    const p = plan(baseIndex, redate(twoItems, main.ItemCode), db);
    const moved = written(p).filter((e) => e.TransactionID === MAIN_TXN_22);
    expect(moved).toHaveLength(3);
    expect(moved.every((e) => e.PostStatus === "ERROR" && e.ItemCodes === JSON.stringify([main.ItemCode]))).toBe(true);
    expect(moved[0].ErrorMessage).toContain(`TransactionID ${MAIN_TXN} → ${MAIN_TXN_22}`);
    expect(p.blocked).toBe(3);
    // Ngày cũ: event POSTED giữ nguyên, báo nguồn đổi
    expect(ofType(p, "POSTED_SOURCE_CHANGED").filter((x) => x.SourceKey!.startsWith(MAIN_TXN))).toHaveLength(3);
  });

  it("đổi ngày giao khi event cũ chưa post → event ngày cũ (SourceID đã chết) bị xóa, không chặn", () => {
    const db = toEventRows(baseDrafts);
    const p = plan(baseIndex, redate(rows, main.ItemCode), db);
    const oldMain = db.filter((e) => e.TransactionID === MAIN_TXN).map((e) => e.AccountingEventID);

    expect(p).toMatchObject({ blocked: 0, exceptions: [] });
    expect(p.remove.sort()).toEqual(oldMain.sort());
    expect(p.insert.map((e) => [e.TransactionID, e.PostStatus])).toEqual([
      [MAIN_TXN_22, "NEW"],
      [MAIN_TXN_22, "NEW"],
      [MAIN_TXN_22, "NEW"],
    ]);
  });

  it("đã bị chặn rồi Unpost ngày cũ → Build xóa event ngày cũ và mở chặn ngày mới (build toàn bộ lẫn theo ComCode)", () => {
    const redated = redate(rows, main.ItemCode);
    const blocked = plan(baseIndex, redated, postedBase()).insert;
    const db = [...toEventRows(baseDrafts), ...rowsOf(blocked, 5000, { PostStatus: "ERROR", ErrorStage: "BUILD" })];

    for (const scope of [null, "ZENIROXPAY"]) {
      const p = plan(baseIndex, redated, db, scope);
      expect(p).toMatchObject({ blocked: 0, exceptions: [] });
      expect(p.remove.sort()).toEqual(db.filter((e) => e.TransactionID === MAIN_TXN).map((e) => e.AccountingEventID).sort());
      expect(p.replace.filter((r) => r.id >= 5000).every((r) => r.draft.PostStatus === "NEW")).toBe(true);
    }
  });

  it("event POSTED ngày cũ chưa có ItemCodes, ngày cũ không còn dòng nào → chặn thận trọng", () => {
    const legacy = postedBase().map((e) => ({ ...e, ItemCodes: null }));
    const p = plan(baseIndex, redate(rows, main.ItemCode), legacy);
    expect(p.blocked).toBe(3);
    expect(written(p).filter((e) => e.PostStatus === "ERROR").every((e) => e.TransactionID === MAIN_TXN_22)).toBe(true);
    expect(ofType(p, "POSTED_SOURCE_CHANGED")).toHaveLength(0);
  });
});

describe("event POSTED cũ chưa có ItemCodes được bổ sung khi nguồn không đổi", () => {
  const index = indexWith((ms) => [...ms, { PaymentGatewayName: "Ontario Pay", ComCode: "ONTARIO", IsActive: 1 }]);
  const split = splitOrder("ZeniroxPay Inc.", "Ontario Pay");
  // ZENIROXPAY đã post trước khi có cột ItemCodes; ONTARIO chưa post
  const db = toEventRows(buildOrderEvents(split, index).events).map((e) =>
    e.ComCode === "ZENIROXPAY" ? { ...e, PostStatus: "POSTED", PostedDocNum: `ASB-TEST-${e.AccountingEventID}`, ItemCodes: null } : e,
  );
  const healedDb = () => {
    const heal = new Map(plan(index, split, db).healItemCodes.map((h) => [h.id, h.ItemCodes]));
    return db.map((e) => ({ ...e, ItemCodes: heal.get(e.AccountingEventID) ?? e.ItemCodes }));
  };

  it("Build không đổi gì → ghi bổ sung ItemCodes cho mọi event POSTED cũ", () => {
    const p = plan(index, split, db);
    const zen = db.filter((e) => e.ComCode === "ZENIROXPAY");
    expect(p).toMatchObject({ blocked: 0, exceptions: [] });
    expect(p.healItemCodes).toHaveLength(zen.length);
    const mainZen = zen.find((e) => e.TransactionID === MAIN_TXN)!;
    expect(p.healItemCodes.find((h) => h.id === mainZen.AccountingEventID)!.ItemCodes).toBe(JSON.stringify([main.ItemCode]));
  });

  it("sau khi bổ sung, item mới cùng đơn không làm chặn nhầm phần ONTARIO chưa post; chưa bổ sung thì chặn thận trọng", () => {
    const withItemC = [...split, { ...main, RawOrderID: 9002, ItemCode: `${main.ItemCode}-C`, PaymentGatewayName: "ZeniroxPay Inc." }];

    const after = plan(index, withItemC, healedDb());
    expect(after.blocked).toBe(0);
    expect(written(after).filter((e) => e.OrderID === MAIN_ORDER && e.ComCode === "ONTARIO").every((e) => e.PostStatus === "NEW")).toBe(true);

    expect(plan(index, withItemC, db).blocked).toBe(3);
  });

  it("sau khi bổ sung, đổi mapping cổng đã post vẫn chặn", () => {
    const remapped = indexWith((ms) => [
      ...remap("ZeniroxPay Inc.", "NEWCO")(ms),
      { PaymentGatewayName: "Ontario Pay", ComCode: "ONTARIO", IsActive: 1 },
    ]);
    const p = plan(remapped, split, healedDb());
    const newco = written(p).filter((e) => e.ComCode === "NEWCO" && e.OrderID === MAIN_ORDER);
    expect(newco).toHaveLength(3);
    expect(newco.every((e) => e.PostStatus === "ERROR")).toBe(true);
  });
});

describe("event đã POSTED không còn được sinh ra", () => {
  it("số tiền về 0 → cảnh báo POSTED_SOURCE_CHANGED, không chặn, không xóa", () => {
    const changed = rows.map((r) => (r.OrderId === MAIN_ORDER ? { ...r, Profit: 0 } : r));
    const p = plan(baseIndex, changed, postedBase());

    expect(p).toMatchObject({ blocked: 0, insert: [], remove: [], unchangedPosted: TOTAL - 1 });
    expect(p.exceptions).toEqual([
      expect.objectContaining({
        Severity: "WARNING",
        ExceptionType: "POSTED_SOURCE_CHANGED",
        ComCode: "ZENIROXPAY",
        SourceKey: `${MAIN_TXN}|ORD_SELLER_PROFIT_FULFILLED`,
      }),
    ]);
  });

  it("gateway bị gỡ mapping → cảnh báo cho từng event đã post, không chặn", () => {
    const p = plan(indexWith((ms) => ms.filter((m) => m.PaymentGatewayName !== STRIPE)), rows, postedBase());
    expect(p).toMatchObject({ blocked: 0, insert: [] });
    expect(ofType(p, "POSTED_SOURCE_CHANGED")).toHaveLength(STRIPE_EVENTS);
  });
});

describe("đơn đi qua nhiều cổng thanh toán", () => {
  it("chỉ 1 cổng của đơn đã post đổi công ty → item chuyển đi bị chặn (full build và build theo ComCode mới)", () => {
    const split = splitOrder("ZeniroxPay Inc.", STRIPE); // cả 2 cổng đang map ZENIROXPAY
    const db = asPosted(toEventRows(buildOrderEvents(split, baseIndex).events));
    const index = stripeToOntario();

    for (const scope of [null, "ONTARIO"]) {
      const p = plan(index, split, db, scope);
      const mainOntario = written(p).filter((e) => e.OrderID === MAIN_ORDER && e.ComCode === "ONTARIO");
      expect(mainOntario).toHaveLength(3);
      expect(mainOntario.every((e) => e.PostStatus === "ERROR" && e.ItemCodes === JSON.stringify([`${main.ItemCode}-B`]))).toBe(true);
      expect(written(p).some((e) => e.PostStatus === "NEW")).toBe(false);
      expect(p.blocked).toBe(STRIPE_EVENTS + MAIN_EVENTS);
    }
  });

  it("đơn tách 2 công ty, chỉ 1 công ty đã post: công ty kia KHÔNG bị chặn khi cổng của công ty đã post bị gỡ mapping", () => {
    const index = indexWith((ms) => [...ms, { PaymentGatewayName: "Zen Alt", ComCode: "ZENIROXPAY", IsActive: 1 }, { PaymentGatewayName: "Ontario Pay", ComCode: "ONTARIO", IsActive: 1 }]);
    const split = splitOrder("Zen Alt", "Ontario Pay");
    const drafts = toEventRows(buildOrderEvents(split, index).events);
    const db = drafts.map((e) => (e.ComCode === "ZENIROXPAY" ? { ...e, PostStatus: "POSTED", PostedDocNum: `ASB-TEST-${e.AccountingEventID}` } : e));

    const deactivated = indexWith((ms) => [...ms, { PaymentGatewayName: "Zen Alt", ComCode: "ZENIROXPAY", IsActive: 0 }, { PaymentGatewayName: "Ontario Pay", ComCode: "ONTARIO", IsActive: 1 }]);
    const p1 = plan(deactivated, split, db);
    const ontario1 = p1.replace.filter((r) => r.draft.OrderID === MAIN_ORDER);
    expect(ontario1.every((r) => r.draft.ComCode === "ONTARIO" && r.draft.PostStatus === "NEW")).toBe(true);
    expect(p1.blocked).toBe(0);
    expect(ofType(p1, "POSTED_SOURCE_CHANGED").filter((x) => x.SourceKey!.startsWith(MAIN_TXN))).toHaveLength(3);

    const toNewco = indexWith((ms) => [...ms, { PaymentGatewayName: "Zen Alt", ComCode: "NEWCO", IsActive: 1 }, { PaymentGatewayName: "Ontario Pay", ComCode: "ONTARIO", IsActive: 1 }]);
    const p2 = plan(toNewco, split, db);
    const mainWritten = written(p2).filter((e) => e.OrderID === MAIN_ORDER);
    expect(mainWritten.filter((e) => e.ComCode === "NEWCO").every((e) => e.PostStatus === "ERROR")).toBe(true);
    expect(mainWritten.filter((e) => e.ComCode === "ONTARIO").every((e) => e.PostStatus === "NEW")).toBe(true);
    expect(p2.blocked).toBe(3);
  });

  it("đổi mapping khi CHƯA post, Build theo ComCode mới → event cũ của ComCode kia được build lại theo phần còn lại, không nhân đôi", () => {
    const split = splitOrder("ZeniroxPay Inc.", STRIPE);
    const db = toEventRows(buildOrderEvents(split, baseIndex).events);
    const oldZenProduct = db.find((e) => e.OrderID === MAIN_ORDER && e.JournalTypeCode === "ORD_REV_PRODUCT_FULFILLED")!;
    expect(oldZenProduct.Amount).toBe(69.98);

    const p = plan(stripeToOntario(), split, db, "ONTARIO");
    expect(p.blocked).toBe(0);
    // Chỉ xóa event chưa post của 4 đơn Stripe đã chuyển hẳn sang ONTARIO; event ZENIROXPAY của đơn tách được build lại
    const removed = db.filter((e) => p.remove.includes(e.AccountingEventID));
    expect(removed).toHaveLength(STRIPE_EVENTS);
    expect(removed.every((e) => stripeOrderIds.has(e.OrderID!) && e.ComCode === "ZENIROXPAY")).toBe(true);
    expect(p.replace.find((r) => r.id === oldZenProduct.AccountingEventID)!.draft).toMatchObject({ ComCode: "ZENIROXPAY", Amount: 34.99 });
    expect(p.insert.filter((e) => e.OrderID === MAIN_ORDER).map((e) => [e.ComCode, e.Amount])).toEqual([
      ["ONTARIO", 34.99],
      ["ONTARIO", 7.99],
      ["ONTARIO", 19.32],
    ]);
  });

  it("đơn tách 2 công ty đều đã post, Build theo 1 ComCode → không xóa, không cảnh báo, không chặn", () => {
    const index = indexWith((ms) => [...ms, { PaymentGatewayName: "Ontario Pay", ComCode: "ONTARIO", IsActive: 1 }]);
    const split = splitOrder("ZeniroxPay Inc.", "Ontario Pay");
    const db = asPosted(toEventRows(buildOrderEvents(split, index).events));
    for (const scope of ["ZENIROXPAY", "ONTARIO"]) {
      expect(plan(index, split, db, scope)).toMatchObject({ blocked: 0, insert: [], replace: [], remove: [], exceptions: [] });
    }
  });
});

describe("reconcileEvents — khóa sổ", () => {
  const ZEN_LOCKED = "ZENIROXPAY|202511";

  it("isLocked luôn false, hoặc chỉ khóa kỳ không liên quan → plan y hệt khi không truyền", () => {
    const scenarios: [MasterIndex, AccountingEventRow[]][] = [
      [baseIndex, postedBase()],
      [baseIndex, toEventRows(baseDrafts)],
      [stripeToOntario(), postedBase()],
      [stripeToOntario(), toEventRows(baseDrafts)],
    ];
    for (const [index, db] of scenarios) {
      const expected = plan(index, rows, db);
      expect(expected).toMatchObject({ locked: [], lockedConflicts: 0, lockedKept: 0 });
      expect(plan(index, rows, db, null, () => false)).toEqual(expected);
      expect(plan(index, rows, db, null, lockedAt("ZENIROXPAY|202510", "ONTARIO|202512", "NEWCO|202511"))).toEqual(expected);
    }
  });

  it("mọi draft thuộc kỳ khóa → không insert/replace/remove/cảnh báo, event cũ (POSTED lẫn chưa post) giữ nguyên", () => {
    for (const db of [postedBase(), toEventRows(baseDrafts)]) {
      for (const scope of [null, "ZENIROXPAY"]) {
        const p = plan(baseIndex, rows, db, scope, lockedAt(ZEN_LOCKED));
        expect(p).toMatchObject({
          insert: [],
          replace: [],
          remove: [],
          exceptions: [],
          healItemCodes: [],
          unchangedPosted: 0,
          blocked: 0,
          lockedConflicts: 0,
          lockedKept: 0,
        });
        expect(p.locked).toHaveLength(TOTAL);
        expect(p.locked.every((l) => l.reason === "DRAFT_LOCKED")).toBe(true);
        expect(p.locked.map((l) => l.eventId ?? -1).sort(byNumber)).toEqual(db.map((e) => e.AccountingEventID).sort(byNumber));
      }
    }
    // Khóa so khớp trim + uppercase như PeriodLocks
    expect(plan(baseIndex, rows, postedBase(), null, lockedAt(" zeniroxpay|202511")).locked).toHaveLength(TOTAL);
  });

  it("rule bị tắt (ít draft hơn) → event kỳ khóa không còn sinh ra vẫn giữ nguyên: không xóa, không cảnh báo (lockedKept)", () => {
    const masters = loadMasters();
    const index = loadIndex({
      lineRules: masters.lineRules.map((r) => (r.JournalTypeCode === "ORD_SELLER_PROFIT_FULFILLED" ? { ...r, IsActive: 0 } : r)),
    });
    const unposted = toEventRows(baseDrafts);
    const profitIds = unposted.filter((e) => e.JournalTypeCode === "ORD_SELLER_PROFIT_FULFILLED").map((e) => e.AccountingEventID);
    expect(profitIds).toHaveLength(PROFIT_EVENTS);
    // Đối chứng không khóa: event chưa post bị xóa, event POSTED bị cảnh báo
    expect(plan(index, rows, unposted).remove.sort(byNumber)).toEqual(profitIds);
    expect(ofType(plan(index, rows, postedBase()), "POSTED_SOURCE_CHANGED")).toHaveLength(PROFIT_EVENTS);

    for (const db of [unposted, postedBase()]) {
      const p = plan(index, rows, db, null, lockedAt(ZEN_LOCKED));
      expect(p).toMatchObject({ insert: [], replace: [], remove: [], exceptions: [], lockedKept: PROFIT_EVENTS, lockedConflicts: 0 });
      expect(p.locked).toHaveLength(TOTAL - PROFIT_EVENTS);
    }
  });

  it("đổi cổng Stripe → ONTARIO khi ZENIROXPAY 202511 đã khóa → draft ONTARIO ghi ERROR + PERIOD_LOCKED, event ZENIROXPAY giữ nguyên", () => {
    for (const [db, status] of [
      [postedBase(), "POSTED"],
      [toEventRows(baseDrafts), "NEW"],
    ] as const) {
      const p = plan(stripeToOntario(), rows, db, null, lockedAt(ZEN_LOCKED));
      expect(p).toMatchObject({
        replace: [],
        remove: [],
        healItemCodes: [],
        unchangedPosted: 0,
        blocked: STRIPE_EVENTS,
        lockedConflicts: STRIPE_EVENTS,
        lockedKept: STRIPE_EVENTS,
      });
      expect(p.insert).toHaveLength(STRIPE_EVENTS);
      for (const e of p.insert) {
        expect(e).toMatchObject({ ComCode: "ONTARIO", PostStatus: "ERROR", ErrorStage: "BUILD" });
        expect(stripeOrderIds.has(e.OrderID!)).toBe(true);
        expect(e.ErrorMessage).toContain(`, ${status}) thuộc ZENIROXPAY kỳ 202511 đã khóa sổ`);
        expect(e.ErrorMessage).toContain("mở khóa ZENIROXPAY kỳ 202511");
        expect(e.ErrorMessage!.includes("Unpost + Unbuild")).toBe(status === "POSTED");
      }
      const lockedErrors = ofType(p, "PERIOD_LOCKED");
      expect(lockedErrors).toHaveLength(STRIPE_EVENTS);
      expect(lockedErrors.every((x) => x.Severity === "ERROR" && x.ComCode === "ONTARIO" && x.Period === "202511")).toBe(true);
      expect(new Set(lockedErrors.map((x) => x.SourceKey)).size).toBe(STRIPE_EVENTS);
      expect(p.exceptions).toHaveLength(STRIPE_EVENTS); // không POSTED_KEY_CHANGED / POSTED_SOURCE_CHANGED
      expect(p.locked).toHaveLength(TOTAL - STRIPE_EVENTS);
      expect(p.locked.every((l) => l.reason === "DRAFT_LOCKED" && l.draft.ComCode === "ZENIROXPAY")).toBe(true);

      // Build theo ComCode mới cũng chặn
      const scoped = plan(stripeToOntario(), rows, db, "ONTARIO", lockedAt(ZEN_LOCKED));
      expect(scoped).toMatchObject({ remove: [], blocked: STRIPE_EVENTS, lockedConflicts: STRIPE_EVENTS, locked: [] });
      expect(written(scoped).every((e) => e.ComCode === "ONTARIO" && e.PostStatus === "ERROR")).toBe(true);

      // Build lần 2: thay đúng event ERROR đã ghi, vẫn chặn, không nhân đôi
      const again = plan(stripeToOntario(), rows, [...db, ...rowsOf(p.insert, 5000)], null, lockedAt(ZEN_LOCKED));
      expect(again).toMatchObject({ insert: [], remove: [], blocked: STRIPE_EVENTS, lockedConflicts: STRIPE_EVENTS });
      expect(again.replace).toHaveLength(STRIPE_EVENTS);
      expect(again.replace.every((r) => r.id >= 5000 && r.draft.PostStatus === "ERROR")).toBe(true);
    }
  });

  it("event kỳ khóa CHƯA post nằm ngoài phạm vi build (relatedPosted) cũng chặn draft trùng item", () => {
    const ontarioDrafts = buildOrderEvents(rows, stripeToOntario()).events.filter((d) => d.ComCode === "ONTARIO");
    const zenNew = toEventRows(baseDrafts).filter((e) => stripeOrderIds.has(e.OrderID!));
    expect(ontarioDrafts).toHaveLength(STRIPE_EVENTS);

    const p = reconcileEvents({ drafts: ontarioDrafts, existing: [], relatedPosted: zenNew, isLocked: lockedAt(ZEN_LOCKED) });
    expect(p).toMatchObject({ replace: [], remove: [], blocked: STRIPE_EVENTS, lockedConflicts: STRIPE_EVENTS, lockedKept: 0 });
    expect(p.insert.every((e) => e.PostStatus === "ERROR" && e.ErrorStage === "BUILD")).toBe(true);
    expect(ofType(p, "PERIOD_LOCKED")).toHaveLength(STRIPE_EVENTS);
    // Không khóa: event chưa post không chặn
    expect(reconcileEvents({ drafts: ontarioDrafts, existing: [], relatedPosted: zenNew })).toMatchObject({ blocked: 0, exceptions: [] });
  });

  it("đổi cổng Stripe sang ONTARIO mà ONTARIO 202511 đã khóa → draft ONTARIO bỏ qua; event ZENIROXPAY cũ xử lý như không còn sinh ra", () => {
    const lock = lockedAt("ONTARIO|202511");
    const unposted = toEventRows(baseDrafts);
    const oldStripeIds = unposted.filter((e) => stripeOrderIds.has(e.OrderID!)).map((e) => e.AccountingEventID);

    const p = plan(stripeToOntario(), rows, unposted, null, lock);
    expect(p).toMatchObject({ insert: [], exceptions: [], blocked: 0, lockedConflicts: 0, lockedKept: 0 });
    expect(p.locked).toHaveLength(STRIPE_EVENTS);
    expect(p.locked.every((l) => l.reason === "DRAFT_LOCKED" && l.eventId === null && l.draft.ComCode === "ONTARIO")).toBe(true);
    expect(p.remove.sort(byNumber)).toEqual(oldStripeIds.sort(byNumber));
    expect(p.replace).toHaveLength(TOTAL - STRIPE_EVENTS);
    expect(p.replace.every((r) => r.draft.ComCode === "ZENIROXPAY" && r.draft.PostStatus === "NEW")).toBe(true);

    const posted = plan(stripeToOntario(), rows, postedBase(), null, lock);
    expect(posted).toMatchObject({ insert: [], replace: [], remove: [], blocked: 0, unchangedPosted: TOTAL - STRIPE_EVENTS, lockedConflicts: 0 });
    expect(posted.locked).toHaveLength(STRIPE_EVENTS);
    const changed = ofType(posted, "POSTED_SOURCE_CHANGED");
    expect(changed).toHaveLength(STRIPE_EVENTS);
    expect(changed.every((x) => x.Severity === "WARNING" && x.ComCode === "ZENIROXPAY")).toBe(true);
    expect(posted.exceptions).toHaveLength(STRIPE_EVENTS); // không POSTED_KEY_CHANGED
  });

  describe("nguồn ngân hàng: khóa event không chứa ngày", () => {
    /** Vài dòng Stripe thật kỳ 202511 của ZENIROXPAY */
    const stripeDrafts = async () => {
      const sample = (await loadSampleStripe()).filter((r) => r.PostingDate?.startsWith("2025-11")).slice(0, 4);
      const drafts = buildBankEvents(sample, stripeSpec, loadIndex()).events;
      expect(drafts.length).toBeGreaterThanOrEqual(sample.length);
      expect(drafts.every((d) => d.ComCode === "ZENIROXPAY" && d.Period === "202511")).toBe(true);
      return drafts;
    };
    /** Event cũ cùng khóa, ghi ở kỳ 202510 (dòng nguồn sau đó đổi ngày sang 202511) */
    const inOctober = (drafts: EventDraft[], override: Partial<AccountingEventRow> = {}) =>
      rowsOf(drafts, 1000, { Period: "202510", PostingDate: "2025-10-31", ...override });

    it("dòng đổi ngày RA khỏi kỳ khóa → EVENT_LOCKED, 1 ERROR PERIOD_LOCKED mỗi draft, không insert/replace (không lỗi UNIQUE)", async () => {
      const drafts = await stripeDrafts();
      for (const status of ["NEW", "POSTED"]) {
        const existing = inOctober(drafts, { PostStatus: status, PostedDocNum: status === "POSTED" ? "ASI-TEST" : null });
        // Đối chứng không khóa: thay cùng id / giữ POSTED
        const open = reconcileEvents({ drafts, existing });
        expect(open.replace.length + open.unchangedPosted).toBe(drafts.length);

        const p = reconcileEvents({ drafts, existing, isLocked: lockedAt("ZENIROXPAY|202510") });
        expect(p).toMatchObject({
          insert: [],
          replace: [],
          remove: [],
          healItemCodes: [],
          unchangedPosted: 0,
          blocked: 0,
          lockedConflicts: drafts.length,
          lockedKept: 0,
        });
        expect(p.locked.map((l) => [l.reason, l.eventId])).toEqual(existing.map((e) => ["EVENT_LOCKED", e.AccountingEventID]));
        expect(p.exceptions).toHaveLength(drafts.length);
        expect(p.exceptions.map((x) => x.SourceKey)).toEqual(drafts.map((d) => `${d.TransactionID}|${d.JournalTypeCode}`));
        for (const x of p.exceptions) {
          expect(x).toMatchObject({ ExceptionType: "PERIOD_LOCKED", Severity: "ERROR", DataSource: "STRIPE", ComCode: "ZENIROXPAY", Period: "202511" });
          expect(x.Message).toContain(`(${status}) cùng khóa đang thuộc ZENIROXPAY kỳ 202510 đã khóa sổ, dòng nguồn nay thuộc kỳ 202511`);
          expect(x.Message.includes("Unpost + Unbuild")).toBe(status === "POSTED");
        }
      }
    });

    it("gương: dòng đổi ngày VÀO kỳ khóa → draft bỏ qua; event cũ ở kỳ mở chưa post bị xóa, đã POSTED thì cảnh báo", async () => {
      const drafts = await stripeDrafts();
      const lock = lockedAt(ZEN_LOCKED);

      const unposted = inOctober(drafts);
      const p = reconcileEvents({ drafts, existing: unposted, isLocked: lock });
      expect(p).toMatchObject({ insert: [], replace: [], exceptions: [], unchangedPosted: 0, lockedConflicts: 0, lockedKept: 0 });
      expect(p.remove).toEqual(unposted.map((e) => e.AccountingEventID));
      expect(p.locked.map((l) => [l.reason, l.eventId])).toEqual(unposted.map((e) => ["DRAFT_LOCKED", e.AccountingEventID]));

      const posted = asPosted(unposted);
      const q = reconcileEvents({ drafts, existing: posted, isLocked: lock });
      expect(q).toMatchObject({ insert: [], replace: [], remove: [], unchangedPosted: 0, lockedConflicts: 0 });
      expect(q.locked).toHaveLength(drafts.length);
      expect(q.exceptions).toHaveLength(drafts.length);
      for (const x of q.exceptions) {
        expect(x).toMatchObject({ ExceptionType: "POSTED_SOURCE_CHANGED", Severity: "WARNING", ComCode: "ZENIROXPAY", Period: "202510" });
      }
    });
  });

  it("event POSTED cũ chưa có ItemCodes thuộc kỳ khóa → không ghi bổ sung ItemCodes (phần kỳ mở vẫn bổ sung)", () => {
    const legacy = postedBase().map((e) => ({ ...e, ItemCodes: null }));
    expect(plan(baseIndex, rows, legacy).healItemCodes).toHaveLength(TOTAL);
    expect(plan(baseIndex, rows, legacy, null, lockedAt(ZEN_LOCKED))).toMatchObject({ healItemCodes: [], exceptions: [], remove: [] });

    // Đơn tách 2 công ty, cả 2 đã post trước khi có cột ItemCodes; chỉ ZENIROXPAY khóa
    const index = indexWith((ms) => [...ms, { PaymentGatewayName: "Ontario Pay", ComCode: "ONTARIO", IsActive: 1 }]);
    const split = splitOrder("ZeniroxPay Inc.", "Ontario Pay");
    const db = asPosted(toEventRows(buildOrderEvents(split, index).events)).map((e) => ({ ...e, ItemCodes: null }));
    const ontarioIds = db.filter((e) => e.ComCode === "ONTARIO").map((e) => e.AccountingEventID);
    expect(ontarioIds).toHaveLength(MAIN_EVENTS);

    const p = plan(index, split, db, null, lockedAt(ZEN_LOCKED));
    expect(p.healItemCodes.map((h) => h.id).sort(byNumber)).toEqual(ontarioIds.sort(byNumber));
    expect(p.healItemCodes.every((h) => h.ItemCodes === JSON.stringify([`${main.ItemCode}-B`]))).toBe(true);
    expect(p).toMatchObject({ blocked: 0, exceptions: [], unchangedPosted: MAIN_EVENTS, insert: [], replace: [], remove: [] });
  });
});

describe("reconcileEvents — nguồn 1 dòng ⇄ 1 bộ event (oneEventSetPerSource)", () => {
  /** Nghiệp vụ kế toán sửa tay vào cột JournalType sau khi dòng đã ghi sổ (file gốc: STRIPE_RECEIPT_CUSTOMER / STRIPE_ADJUSTMENT) */
  const RECLASSIFIED = "STRIPE_CHARGE";
  const ZEN_OCT = "ZENIROXPAY|202510";

  /** 3 dòng charge thật kỳ 202511 (có invoice → so theo OrderID) + dòng adjustment duy nhất của kỳ (không invoice → so theo TransactionID) */
  const stripeRows = async (): Promise<RawStripeRow[]> => {
    const nov = (await loadSampleStripe()).filter((r) => r.PostingDate?.startsWith("2025-11"));
    const picked = [...nov.filter((r) => r.Type === "charge").slice(0, 3), ...nov.filter((r) => r.Type === "adjustment")];
    expect(picked).toHaveLength(4);
    expect(picked.filter((r) => !r.MetaInvoiceId)).toHaveLength(1);
    return picked;
  };
  const draftsOf = (list: RawStripeRow[], index: MasterIndex = baseIndex) => {
    const { events } = buildBankEvents(list, stripeSpec, index);
    expect(events.length).toBeGreaterThanOrEqual(list.length);
    expect(events.every((d) => d.ComCode === "ZENIROXPAY" && d.Period === "202511")).toBe(true);
    return events;
  };
  /** Sửa tay cột JournalType — SourceKey (khóa dòng) không đổi vì không phụ thuộc cột điền tay */
  const reclassify = (list: RawStripeRow[], jtc: string) => list.map((r) => ({ ...r, JournalType: jtc }));
  /** Như runBuildSource: existing = event của các SourceID đang build; `flag = false` = như Orders / trước bản sửa §13.3 #21 */
  const bankPlan = (drafts: EventDraft[], existing: AccountingEventRow[], flag = true, isLocked?: IsLocked) =>
    reconcileEvents({ drafts, existing, isLocked, oneEventSetPerSource: flag });
  /** Event cũ cùng dòng, cùng EventSeq với draft */
  const pairOf = (old: AccountingEventRow[], d: EventDraft) => old.find((e) => e.SourceID === d.SourceID && e.EventSeq === d.EventSeq)!;

  it("dòng đã ghi sổ bị sửa tay JournalType → draft nghiệp vụ mới ghi ERROR/BUILD + POSTED_KEY_CHANGED; không bật cờ thì NEW (lỗ hổng cũ)", async () => {
    const list = await stripeRows();
    const posted = asPosted(toEventRows(draftsOf(list)));
    const drafts = draftsOf(reclassify(list, RECLASSIFIED));
    // Cùng dòng, cùng công ty, cùng TransactionID / OrderID / bộ RuleSeq — chỉ khác nghiệp vụ nên khác khóa event
    expect(drafts.map((d) => [d.SourceID, d.ComCode, d.TransactionID, d.OrderID, d.EventSeq])).toEqual(
      posted.map((e) => [e.SourceID, e.ComCode, e.TransactionID, e.OrderID, e.EventSeq]),
    );
    expect(new Set(posted.map((e) => e.JournalTypeCode))).toEqual(new Set(["STRIPE_RECEIPT_CUSTOMER", "STRIPE_ADJUSTMENT"]));
    expect(drafts.every((d) => d.JournalTypeCode === RECLASSIFIED)).toBe(true);

    // Không cờ (Orders, hay nguồn ngân hàng trước bản sửa): khác nghiệp vụ → không chặn → NEW → Post ghi sổ lần 2
    const gap = bankPlan(drafts, posted, false);
    expect(gap).toMatchObject({ blocked: 0, unchangedPosted: 0, replace: [], remove: [] });
    expect(gap.insert).toHaveLength(drafts.length);
    expect(gap.insert.every((e) => e.PostStatus === "NEW")).toBe(true);
    expect(ofType(gap, "POSTED_KEY_CHANGED")).toHaveLength(0);
    expect(ofType(gap, "POSTED_SOURCE_CHANGED")).toHaveLength(posted.length);

    const p = bankPlan(drafts, posted);
    expect(p).toMatchObject({ blocked: drafts.length, unchangedPosted: 0, replace: [], remove: [], healItemCodes: [], locked: [] });
    expect(p.insert).toHaveLength(drafts.length);
    for (const e of p.insert) {
      const old = pairOf(posted, e);
      expect(e).toMatchObject({ JournalTypeCode: RECLASSIFIED, PostStatus: "ERROR", ErrorStage: "BUILD" });
      // Nêu đúng event cũ cùng EventSeq, chỉ báo phần đã đổi; không nhắc ItemCodes (nguồn ngân hàng không dùng cột này)
      expect(e.ErrorMessage).toBe(
        `Dòng nguồn này đã ghi sổ ở event ${old.AccountingEventID} (ComCode ZENIROXPAY, ${old.JournalTypeCode}, chứng từ ${old.PostedDocNum}) ` +
          `dưới khóa khác (JournalTypeCode ${old.JournalTypeCode} → ${RECLASSIFIED}) → chặn để không ghi sổ trùng. ` +
          "Unpost ComCode ZENIROXPAY kỳ 202511 rồi Build + Post lại",
      );
    }
    const keyChanged = ofType(p, "POSTED_KEY_CHANGED");
    expect(keyChanged.map((x) => x.SourceKey)).toEqual(drafts.map((d) => `${d.TransactionID}|${RECLASSIFIED}`));
    for (const x of keyChanged) {
      expect(x).toMatchObject({ Severity: "ERROR", DataSource: "STRIPE", ComCode: "ZENIROXPAY", Period: "202511" });
    }
    // Event cũ bị thay đã được báo qua draft → không POSTED_SOURCE_CHANGED
    expect(ofType(p, "POSTED_SOURCE_CHANGED")).toHaveLength(0);
    expect(p.exceptions).toHaveLength(drafts.length);
  });

  it("Build lại khi chưa Unpost → thay đúng event ERROR, vẫn chặn; Unpost rồi Build → event cũ bị xóa, draft mới NEW", async () => {
    const list = await stripeRows();
    const original = toEventRows(draftsOf(list));
    const drafts = draftsOf(reclassify(list, RECLASSIFIED));
    const errors = rowsOf(bankPlan(drafts, asPosted(original)).insert, 5000);
    expect(errors.every((e) => e.PostStatus === "ERROR" && e.ErrorStage === "BUILD")).toBe(true);

    const again = bankPlan(drafts, [...asPosted(original), ...errors]);
    expect(again).toMatchObject({ insert: [], remove: [], blocked: drafts.length });
    expect(again.replace.map((r) => r.id)).toEqual(errors.map((e) => e.AccountingEventID));
    expect(again.replace.every((r) => r.draft.PostStatus === "ERROR")).toBe(true);
    expect(again.exceptions.map((x) => x.ExceptionType)).toEqual(drafts.map(() => "POSTED_KEY_CHANGED"));

    const unposted = bankPlan(drafts, [...original, ...errors]);
    expect(unposted).toMatchObject({ insert: [], blocked: 0, exceptions: [] });
    expect(unposted.remove).toEqual(original.map((e) => e.AccountingEventID));
    expect(unposted.replace.map((r) => r.id)).toEqual(errors.map((e) => e.AccountingEventID));
    expect(unposted.replace.every((r) => r.draft.PostStatus === "NEW")).toBe(true);
  });

  it("nghiệp vụ mới có bộ rule khác (khác EventSeq / ít rule hơn) → vẫn chặn mọi draft, không cảnh báo event cũ nào", async () => {
    const list = await stripeRows();
    const posted = asPosted(toEventRows(draftsOf(list)));
    expect(new Set(posted.map((e) => e.EventSeq))).toEqual(new Set([10, 30]));
    // STRIPE_FEE: rule 10 + 20; STRIPE_PAYOUT: chỉ rule 10
    for (const [jtc, seqs] of [
      ["STRIPE_FEE", [10, 20]],
      ["STRIPE_PAYOUT", [10]],
    ] as const) {
      const drafts = draftsOf(reclassify(list, jtc));
      expect(new Set(drafts.map((d) => d.EventSeq))).toEqual(new Set(seqs));
      const p = bankPlan(drafts, posted);
      expect(p).toMatchObject({ blocked: drafts.length, unchangedPosted: 0, replace: [], remove: [] });
      expect(p.insert.every((e) => e.JournalTypeCode === jtc && e.PostStatus === "ERROR")).toBe(true);
      expect(p.exceptions.map((x) => x.ExceptionType)).toEqual(drafts.map(() => "POSTED_KEY_CHANGED"));
      for (const e of p.insert.filter((d) => d.EventSeq === 10)) {
        expect(e.ErrorMessage).toContain(`ở event ${pairOf(posted, e).AccountingEventID} (`);
        expect(e.ErrorMessage).not.toContain("EventSeq");
      }
      for (const e of p.insert.filter((d) => d.EventSeq === 20)) expect(e.ErrorMessage).toContain("EventSeq 10 → 20");
    }
  });

  it("Build lại không đổi gì sau khi Post (hoặc chưa Post) → như khi không bật cờ: giữ POSTED / thay event cũ, không chặn", async () => {
    const drafts = draftsOf(await stripeRows());
    const posted = asPosted(toEventRows(drafts));
    const p = bankPlan(drafts, posted);
    expect(p).toMatchObject({ unchangedPosted: drafts.length, blocked: 0, insert: [], replace: [], remove: [], exceptions: [] });
    expect(p).toEqual(bankPlan(drafts, posted, false));

    const unposted = toEventRows(drafts);
    const q = bankPlan(drafts, unposted);
    expect(q).toMatchObject({ unchangedPosted: 0, blocked: 0, insert: [], remove: [], exceptions: [] });
    expect(q.replace.map((r) => r.id)).toEqual(unposted.map((e) => e.AccountingEventID));
    expect(q).toEqual(bankPlan(drafts, unposted, false));
  });

  it("thêm rule mới (EventSeq mới) cho nghiệp vụ đã ghi sổ, event cũ không đổi → draft mới NEW, không chặn", async () => {
    const list = await stripeRows();
    const posted = asPosted(toEventRows(draftsOf(list)));
    const masters = loadMasters();
    const rule10 = (jtc: string) => masters.lineRules.find((r) => r.JournalTypeCode === jtc && r.RuleSeq === 10)!;
    const index = loadIndex({
      lineRules: [
        ...masters.lineRules,
        { ...rule10("STRIPE_RECEIPT_CUSTOMER"), JournalLineRuleID: 9001, RuleSeq: 20 },
        { ...rule10("STRIPE_ADJUSTMENT"), JournalLineRuleID: 9002, RuleSeq: 20 },
      ],
    });
    const drafts = draftsOf(list, index);
    const added = drafts.filter((d) => d.EventSeq === 20);
    expect(added).toHaveLength(list.length);
    expect(drafts).toHaveLength(posted.length + list.length);

    const p = bankPlan(drafts, posted);
    expect(p).toMatchObject({ unchangedPosted: posted.length, blocked: 0, replace: [], remove: [], exceptions: [] });
    expect(p.insert).toEqual(added);
    expect(p.insert.every((e) => e.PostStatus === "NEW")).toBe(true);
  });

  it("dòng đổi cả OrderID (sửa invoiceId) lẫn nghiệp vụ → vẫn chặn nhờ so theo SourceID; không bật cờ thì NEW", async () => {
    const list = await stripeRows();
    const posted = asPosted(toEventRows(draftsOf(list)));
    const edited = reclassify(list, RECLASSIFIED).map((r) => ({ ...r, MetaInvoiceId: `${r.MetaInvoiceId ?? r.Id}-EDITED` }));
    const drafts = draftsOf(edited);
    // Không event POSTED nào còn cùng OrderID với draft (kể cả dòng adjustment trước đây không có invoice)
    expect(drafts.every((d) => d.OrderID?.endsWith("-EDITED"))).toBe(true);
    expect(posted.some((e) => drafts.some((d) => d.OrderID === e.OrderID))).toBe(false);

    const gap = bankPlan(drafts, posted, false);
    expect(gap).toMatchObject({ blocked: 0, replace: [], remove: [] });
    expect(gap.insert.every((e) => e.PostStatus === "NEW")).toBe(true);

    const p = bankPlan(drafts, posted);
    expect(p).toMatchObject({ blocked: drafts.length, unchangedPosted: 0, replace: [], remove: [] });
    for (const e of p.insert) {
      expect(e.PostStatus).toBe("ERROR");
      expect(e.ErrorMessage).toContain(`ở event ${pairOf(posted, e).AccountingEventID} (`);
    }
    expect(ofType(p, "POSTED_KEY_CHANGED")).toHaveLength(drafts.length);
    expect(ofType(p, "POSTED_SOURCE_CHANGED")).toHaveLength(0);
  });

  it("dòng đổi ngày ra khỏi kỳ khóa VÀ đổi nghiệp vụ (khác khóa event) → vẫn chặn: ERROR PERIOD_LOCKED, event kỳ khóa giữ nguyên", async () => {
    const list = await stripeRows();
    const october = rowsOf(draftsOf(list), 1000, { Period: "202510", PostingDate: "2025-10-31", PostStatus: "POSTED", PostedDocNum: "ASI-TEST" });
    const drafts = draftsOf(reclassify(list, RECLASSIFIED));
    const lock = lockedAt(ZEN_OCT);

    // Không cờ: khóa event khác (JTC) nên không vào nhánh EVENT_LOCKED, cũng không bị chặn → ghi sổ trùng ở kỳ mở
    const gap = bankPlan(drafts, october, false, lock);
    expect(gap).toMatchObject({ blocked: 0, lockedConflicts: 0, lockedKept: october.length, locked: [], exceptions: [] });
    expect(gap.insert.every((e) => e.PostStatus === "NEW")).toBe(true);

    const p = bankPlan(drafts, october, true, lock);
    expect(p).toMatchObject({
      blocked: drafts.length,
      lockedConflicts: drafts.length,
      lockedKept: october.length,
      locked: [],
      replace: [],
      remove: [],
      healItemCodes: [],
    });
    expect(p.insert.every((e) => e.PostStatus === "ERROR" && e.ErrorStage === "BUILD")).toBe(true);
    expect(p.exceptions.map((x) => x.ExceptionType)).toEqual(drafts.map(() => "PERIOD_LOCKED"));
    for (const e of p.insert) {
      const old = pairOf(october, e);
      expect(e.ErrorMessage).toContain(`event ${old.AccountingEventID} (${old.JournalTypeCode}, POSTED) thuộc ZENIROXPAY kỳ 202510 đã khóa sổ`);
    }
  });

  it("kịch bản khóa event không chứa ngày (dòng đổi ngày, cùng nghiệp vụ) → bật cờ cho kết quả y hệt không bật", async () => {
    const drafts = draftsOf(await stripeRows());
    for (const status of ["NEW", "POSTED"]) {
      const october = rowsOf(drafts, 1000, {
        Period: "202510",
        PostingDate: "2025-10-31",
        PostStatus: status,
        PostedDocNum: status === "POSTED" ? "ASI-TEST" : null,
      });
      for (const lock of [undefined, lockedAt(ZEN_OCT), lockedAt("ZENIROXPAY|202511")]) {
        expect(bankPlan(drafts, october, true, lock)).toEqual(bankPlan(drafts, october, false, lock));
      }
    }
  });

  it("Orders không bật cờ: truyền false y hệt không truyền; bật lên sẽ chặn nhầm nghiệp vụ hợp lệ khác của cùng đơn + ngày giao", () => {
    const masters = loadMasters();
    const reseq = loadIndex({
      lineRules: masters.lineRules.map((r) => (r.JournalTypeCode === "ORD_SELLER_PROFIT_FULFILLED" ? { ...r, RuleSeq: 25 } : r)),
    });
    const redated = rows.map((r) => (r.OrderId === MAIN_ORDER ? { ...r, FulfilledAt: SCENARIO_FREE_DAY } : r));
    const scenarios: Parameters<typeof planInput>[] = [
      [baseIndex, rows, postedBase()],
      [baseIndex, rows, toEventRows(baseDrafts)],
      [stripeToOntario(), rows, postedBase()],
      [stripeToOntario(), rows, postedBase(), "ONTARIO"],
      [reseq, rows, postedBase()],
      [baseIndex, redated, postedBase()],
      [stripeToOntario(), rows, postedBase(), null, lockedAt("ZENIROXPAY|202511")],
    ];
    for (const args of scenarios) {
      const input = planInput(...args);
      expect(reconcileEvents({ ...input, oneEventSetPerSource: false })).toEqual(reconcileEvents(input));
    }

    // Đơn mốc: Profit về 0 (event PROFIT đã POSTED không còn sinh ra) + thêm rule PRODUCT RuleSeq 30 — 2 thay đổi độc lập
    const product = masters.lineRules.find((r) => r.JournalTypeCode === "ORD_REV_PRODUCT_FULFILLED")!;
    const withRule = loadIndex({ lineRules: [...masters.lineRules, { ...product, JournalLineRuleID: 9999, RuleSeq: 30 }] });
    const input = planInput(withRule, rows.map((r) => (r.OrderId === MAIN_ORDER ? { ...r, Profit: 0 } : r)), postedBase());
    const orders = reconcileEvents(input);
    expect(orders.blocked).toBe(0);
    expect(orders.insert).toHaveLength(PRODUCT_EVENTS);
    expect(orders.insert.every((e) => e.PostStatus === "NEW")).toBe(true);
    const wrong = reconcileEvents({ ...input, oneEventSetPerSource: true });
    expect(wrong.blocked).toBe(1);
    expect(wrong.insert.find((e) => e.PostStatus === "ERROR")).toMatchObject({
      OrderID: MAIN_ORDER,
      JournalTypeCode: "ORD_REV_PRODUCT_FULFILLED",
      EventSeq: 30,
    });
  });
});

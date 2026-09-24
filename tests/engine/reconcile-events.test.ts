import { describe, expect, it } from "vitest";
import type { AccountingEventRow, RawOrderRow } from "@/lib/db/schema";
import { buildOrderEvents, orderRowsInScope } from "@/lib/engine/build-orders";
import { orderSourceId } from "@/lib/engine/keys";
import type { MasterIndex } from "@/lib/engine/masters";
import { reconcileEvents } from "@/lib/engine/reconcile-events";
import type { EventDraft } from "@/lib/engine/types";
import {
  loadIndex,
  loadMasters,
  loadSampleOrders,
  SCENARIO_FREE_DAY,
  scenarioRows,
  TEST_COMPANIES,
  TEST_GATEWAY_MAPPINGS,
  toEventRows,
} from "../helpers/fixtures";

const STRIPE = "ZeniroxPay - Stripe";
const MAIN_ORDER = "QVAJV-191125-Q1Z3V";
const MAIN_TXN = "ORD-QVAJV-191125-Q1Z3V-20251121";

// File này gọi plan() ~25 lần; chạy trên tập con kịch bản (431 dòng, thuần kỳ 202511)
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

/**
 * Mô phỏng runBuildOrders: phạm vi trọn đơn; load event theo OrderID (đơn đang build + đơn có event trong phạm vi):
 * SourceID đang build / đã chết → existing; SourceID còn dòng nguồn ngoài phạm vi → relatedPosted (chỉ POSTED)
 */
function plan(index: MasterIndex, allRows: RawOrderRow[], dbEvents: AccountingEventRow[], scopeComCode: string | null = null) {
  const scopeEvents = scopeComCode ? dbEvents.filter((e) => e.ComCode === scopeComCode) : dbEvents;
  const scoped = orderRowsInScope(allRows, index, scopeComCode, scopeComCode ? scopeEvents.map((e) => e.SourceID ?? "") : []);
  const sourceIds = new Set(scoped.filter((r) => r.FulfilledAt).map((r) => orderSourceId(r.OrderId, r.FulfilledAt!)));
  const live = new Set(allRows.filter((r) => r.FulfilledAt).map((r) => orderSourceId(r.OrderId, r.FulfilledAt!)));
  const orderIds = new Set([...scoped.map((r) => r.OrderId), ...scopeEvents.map((e) => e.OrderID ?? "")]);
  const orderEvents = dbEvents.filter((e) => orderIds.has(e.OrderID ?? ""));
  const sid = (e: AccountingEventRow) => e.SourceID ?? "";
  const deadSourceIds = new Set(orderEvents.map(sid).filter((s) => !sourceIds.has(s) && !live.has(s)));
  return reconcileEvents({
    drafts: buildOrderEvents(scoped, index).events,
    existing: orderEvents.filter((e) => sourceIds.has(sid(e)) || deadSourceIds.has(sid(e))),
    relatedPosted: orderEvents.filter((e) => e.PostStatus === "POSTED" && !sourceIds.has(sid(e)) && !deadSourceIds.has(sid(e))),
    deadSourceIds,
  });
}
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

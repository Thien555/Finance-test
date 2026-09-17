/**
 * Chốt chặn cuối khi POST: không để 1 item (dòng nguồn) lên sổ 2 lần — kể cả khi dữ liệu đi vào trạng thái lệch mà Build
 * chưa kịp đối chiếu (dữ liệu tạo từ phiên bản cũ, Post trước khi Build lại, sửa DB tay...).
 *
 * Một item chỉ thuộc 1 ngày giao (SourceID) và 1 công ty (ComCode). Hai event cùng DataSource + OrderID có item trùng mà
 * khác SourceID hoặc khác ComCode chắc chắn là 1 nghiệp vụ bị sinh 2 lần. Event chờ post bị giữ lại khi trùng như vậy với:
 *  - event đã POSTED; hoặc
 *  - event khác cũng đang chờ post (NEW, ERROR do POST) — giữ cả hai vì không biết bản nào đúng.
 * Event của nguồn theo dõi item (Orders) mà chưa có ItemCodes (tạo trước khi có cột) → giữ lại, phải Build lại trước khi Post.
 *
 * Cùng SourceID + ComCode (nhiều nghiệp vụ / nhiều rule của cùng đơn, cùng ngày giao) là bình thường nên không xét ở đây;
 * trường hợp đổi RuleSeq sau khi post do Build phát hiện (reconcile-events.ts).
 */
import type { AccountingEventRow } from "@/lib/db/schema";
import { parseItemCodes } from "./reconcile-events";

export type GuardEvent = Pick<
  AccountingEventRow,
  "AccountingEventID" | "DataSource" | "ComCode" | "TransactionID" | "SourceID" | "OrderID" | "ItemCodes" | "PostStatus" | "ErrorStage" | "PostedDocNum"
>;

const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();
const awaitingPost = (e: GuardEvent) => e.PostStatus === "NEW" || (e.PostStatus === "ERROR" && e.ErrorStage === "POST");

/**
 * @param candidates event sắp post
 * @param orderEvents mọi event (mọi PostStatus) cùng OrderID với candidates — được phép chứa lại chính candidates
 * @param itemTrackedDataSources DataSource bắt buộc có ItemCodes
 * @returns AccountingEventID → lý do giữ lại
 */
export function findDuplicateItems(
  candidates: GuardEvent[],
  orderEvents: GuardEvent[],
  itemTrackedDataSources: readonly string[],
): Map<number, string> {
  const tracked = new Set(itemTrackedDataSources.map(norm));
  const itemKey = (e: GuardEvent, item: string) => `${norm(e.DataSource)}|${e.OrderID}|${item}`;

  // item → các event đã POSTED / đang chờ post chứa item đó
  const itemsById = new Map<number, Set<string> | null>();
  const holders = new Map<string, GuardEvent[]>();
  for (const e of [...candidates, ...orderEvents]) {
    if (itemsById.has(e.AccountingEventID)) continue;
    const items = parseItemCodes(e.ItemCodes);
    itemsById.set(e.AccountingEventID, items);
    if (!e.OrderID || !(e.PostStatus === "POSTED" || awaitingPost(e))) continue;
    for (const item of items ?? []) {
      const list = holders.get(itemKey(e, item)) ?? [];
      list.push(e);
      holders.set(itemKey(e, item), list);
    }
  }

  const held = new Map<number, string>();
  for (const c of candidates) {
    const items = itemsById.get(c.AccountingEventID);
    if (!items) {
      if (tracked.has(norm(c.DataSource))) {
        held.set(c.AccountingEventID, "Event tạo trước khi có cột ItemCodes → Build lại rồi mới Post (để kiểm tra ghi sổ trùng)");
      }
      continue;
    }
    if (!c.OrderID) continue;

    let hit: { other: GuardEvent; item: string } | undefined;
    for (const item of items) {
      for (const o of holders.get(itemKey(c, item)) ?? []) {
        if (o.AccountingEventID === c.AccountingEventID) continue;
        if ((o.SourceID ?? "") === (c.SourceID ?? "") && norm(o.ComCode) === norm(c.ComCode)) continue;
        if (!hit || (hit.other.PostStatus !== "POSTED" && o.PostStatus === "POSTED")) hit = { other: o, item };
      }
    }
    if (!hit) continue;

    const o = hit.other;
    held.set(
      c.AccountingEventID,
      o.PostStatus === "POSTED"
        ? `Item ${hit.item} đã ghi sổ ở event ${o.AccountingEventID} (ComCode ${o.ComCode}, ${o.TransactionID}, chứng từ ${o.PostedDocNum}) ` +
            `→ không post để tránh ghi sổ trùng. Build lại để đối chiếu (event bị chặn POSTED_KEY_CHANGED hoặc được dọn)`
        : `Item ${hit.item} cũng nằm trong event ${o.AccountingEventID} chưa post (ComCode ${o.ComCode}, ${o.TransactionID}) ` +
            `khác ngày giao/công ty → không post cả hai. Build lại (phạm vi gồm cả 2 event) để dọn event cũ rồi Post`,
    );
  }
  return held;
}

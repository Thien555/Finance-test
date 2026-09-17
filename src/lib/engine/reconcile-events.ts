/**
 * Đối chiếu event Build vừa sinh (draft) với event đã có trong DB → kế hoạch ghi: insert / replace / giữ POSTED / xóa / chặn.
 *
 * Khóa event = ComCode | DataSource | JournalTypeCode | TransactionID | EventSeq. Khóa đổi SAU KHI đã post
 * (đổi GatewayCompanyMapping → ComCode khác, đổi RuleSeq, đổi ngày giao → TransactionID khác...) thì draft mới không trùng
 * khóa event POSTED cũ; tạo NEW là lần Post sau ghi sổ lần 2.
 *
 * Chống ghi sổ trùng theo ITEM (ItemCodes = các dòng nguồn tạo nên event): draft chưa POSTED bị chặn khi có event POSTED
 * cùng OrderID, khác khóa, cùng DataSource, có item trùng với draft, và:
 *  - khác SourceID (item đã ghi sổ ở ngày giao khác — kể cả khi cả 2 ngày giao cùng nằm trong lần build); hoặc
 *  - khác ComCode (item đã ghi sổ ở công ty khác — kể cả khi chỉ 1 phần đơn đổi công ty, kể cả khác nghiệp vụ); hoặc
 *  - cùng ComCode, cùng nghiệp vụ (JTC), và event POSTED đó không còn được sinh ra (đổi RuleSeq / cách viết JTC).
 * Draft bị chặn vẫn được ghi nhưng PostStatus ERROR / ErrorStage BUILD (Post không lấy) + exception POSTED_KEY_CHANGED.
 * Unpost event POSTED cũ rồi Build lại thì hết chặn (event cũ lúc đó chưa post, không còn sinh ra → bị xóa).
 *
 * Event POSTED cũ chưa có ItemCodes (tạo trước khi có cột):
 *  - draft cùng khóa, cùng SourceHash (hash đã gồm danh sách item) → biết chắc item → bổ sung ItemCodes (healItemCodes);
 *  - còn lại coi là trùng item khi cùng SourceID mà event đã đổi (không còn sinh ra / SourceHash khác), hoặc SourceID của
 *    nó đã chết (không còn dòng nguồn nào) — thận trọng, chấp nhận có thể chặn thừa.
 */
import type { AccountingEventRow } from "@/lib/db/schema";
import { eventKey } from "./keys";
import type { EventDraft, ExceptionDraft } from "./types";

type EventFields =
  | "ComCode"
  | "DataSource"
  | "JournalTypeCode"
  | "TransactionID"
  | "EventSeq"
  | "SourceID"
  | "OrderID"
  | "Period"
  | "Amount"
  | "SourceHash"
  | "ItemCodes";

export type ExistingEvent = Pick<AccountingEventRow, EventFields | "AccountingEventID" | "PostStatus" | "PostedDocNum">;

export type ReconcileDraft = Pick<EventDraft, EventFields | "PostStatus" | "ErrorStage" | "ErrorMessage">;

export interface ReconcileInput<D extends ReconcileDraft> {
  /** Draft của mọi dòng nguồn thuộc các SourceID đang build (mọi ComCode) */
  drafts: D[];
  /**
   * Event trong DB được thay thế / xóa / cảnh báo (mọi ComCode):
   *  - event của các SourceID đang build;
   *  - event có SourceID đã chết (không còn dòng nguồn nào, VD dòng đã đổi ngày giao) của các đơn đang build / trong phạm vi build.
   */
  existing: ExistingEvent[];
  /** Event POSTED cùng OrderID, SourceID khác còn dòng nguồn nhưng ngoài phạm vi build — chỉ để phát hiện item đã ghi sổ, không bị sửa/xóa */
  relatedPosted?: ExistingEvent[];
  /** SourceID không còn dòng nguồn nào (event của chúng nằm trong existing) */
  deadSourceIds?: ReadonlySet<string>;
}

export interface ReconcilePlan<D extends ReconcileDraft> {
  insert: D[];
  replace: { id: number; draft: D }[];
  /** Id event cũ chưa POSTED không còn được sinh ra → xóa */
  remove: number[];
  unchangedPosted: number;
  /** Số draft bị chặn (nằm trong insert/replace với PostStatus ERROR) */
  blocked: number;
  /** Event POSTED cũ chưa có ItemCodes, xác định được item nhờ draft cùng khóa + cùng SourceHash → ghi bổ sung */
  healItemCodes: { id: number; ItemCodes: string }[];
  exceptions: ExceptionDraft[];
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();

/** ItemCodes (JSON mảng) → Set; null nếu trống / không đọc được (event cũ) */
export function parseItemCodes(itemCodes: string | null | undefined): Set<string> | null {
  if (!itemCodes) return null;
  try {
    const list: unknown = JSON.parse(itemCodes);
    return Array.isArray(list) ? new Set(list.map(String)) : null;
  } catch {
    return null;
  }
}

export function reconcileEvents<D extends ReconcileDraft>(input: ReconcileInput<D>): ReconcilePlan<D> {
  const { drafts, existing, relatedPosted = [], deadSourceIds = new Set<string>() } = input;
  const plan: ReconcilePlan<D> = { insert: [], replace: [], remove: [], unchangedPosted: 0, blocked: 0, healItemCodes: [], exceptions: [] };

  const draftByKey = new Map(drafts.map((d) => [eventKey(d), d]));
  const existingByKey = new Map(existing.map((e) => [eventKey(e), e]));

  const itemsCache = new Map<object, Set<string> | null>();
  const items = (x: { ItemCodes?: string | null }) => {
    if (!itemsCache.has(x)) itemsCache.set(x, parseItemCodes(x.ItemCodes));
    return itemsCache.get(x)!;
  };

  // Event POSTED cũ chưa có ItemCodes mà nguồn không đổi: SourceHash gồm danh sách item (sort) → cùng hash = cùng item
  for (const e of existing) {
    if (e.PostStatus !== "POSTED" || items(e)) continue;
    const d = draftByKey.get(eventKey(e));
    if (d?.ItemCodes && d.SourceHash === e.SourceHash) {
      itemsCache.set(e, parseItemCodes(d.ItemCodes));
      plan.healItemCodes.push({ id: e.AccountingEventID, ItemCodes: d.ItemCodes });
    }
  }

  /** Event trong DB không còn được sinh ra cùng khóa */
  const orphaned = (e: ExistingEvent) => !draftByKey.has(eventKey(e));
  /** Event POSTED đã đổi: không còn sinh ra hoặc SourceHash khác */
  const changed = (e: ExistingEvent) => draftByKey.get(eventKey(e))?.SourceHash !== e.SourceHash;

  const overlaps = (d: D, p: ExistingEvent) => {
    const pItems = items(p);
    if (!pItems) {
      // Event cũ không rõ item: cùng SourceID mà đã đổi, hoặc SourceID đã chết (dòng nguồn đã chuyển đi hết)
      return (p.SourceID ?? "") === (d.SourceID ?? "") ? changed(p) : deadSourceIds.has(p.SourceID ?? "");
    }
    const dItems = items(d);
    if (!dItems) return true;
    for (const i of dItems) if (pItems.has(i)) return true;
    return false;
  };

  /** Event POSTED p (khác khóa) đã ghi sổ item của draft d */
  const conflicts = (d: D, p: ExistingEvent) => {
    if (eventKey(p) === eventKey(d) || norm(p.DataSource) !== norm(d.DataSource) || !overlaps(d, p)) return false;
    if ((p.SourceID ?? "") !== (d.SourceID ?? "")) return true;
    if (p.ComCode !== d.ComCode) return true;
    return norm(p.JournalTypeCode) === norm(d.JournalTypeCode) && orphaned(p);
  };

  const txKey = (e: { DataSource: string; TransactionID: string }) => `${norm(e.DataSource)}|${e.TransactionID}`;
  const orderKey = (e: { DataSource: string; OrderID?: string | null }) => `${norm(e.DataSource)}|${e.OrderID ?? ""}`;
  const group = (list: ExistingEvent[], keyOf: (e: ExistingEvent) => string) => {
    const map = new Map<string, ExistingEvent[]>();
    for (const e of list) {
      if (e.PostStatus !== "POSTED") continue;
      const bucket = map.get(keyOf(e)) ?? [];
      bucket.push(e);
      map.set(keyOf(e), bucket);
    }
    return map;
  };
  // So với mọi event POSTED cùng đơn (mọi ngày giao, mọi ComCode); event không có OrderID thì so cùng TransactionID
  const postedByOrder = group([...existing, ...relatedPosted], orderKey);
  const postedByTx = group(existing, txKey);

  const postedConflictOf = (d: D): ExistingEvent | undefined => {
    const candidates = d.OrderID ? (postedByOrder.get(orderKey(d)) ?? []) : (postedByTx.get(txKey(d)) ?? []);
    const hits = candidates.filter((p) => conflicts(d, p));
    return hits.find((p) => norm(p.JournalTypeCode) === norm(d.JournalTypeCode)) ?? hits[0];
  };

  const superseded = new Set<number>();
  for (const d of drafts) {
    const old = existingByKey.get(eventKey(d));

    if (old?.PostStatus === "POSTED") {
      plan.unchangedPosted++;
      if (old.SourceHash !== d.SourceHash) {
        plan.exceptions.push({
          DataSource: d.DataSource,
          ComCode: d.ComCode,
          Period: d.Period,
          Severity: "WARNING",
          ExceptionType: "POSTED_SOURCE_CHANGED",
          SourceKey: `${d.TransactionID}|${norm(d.JournalTypeCode)}`,
          Message: `Event ${old.AccountingEventID} đã POSTED nhưng dữ liệu nguồn/cấu hình đã đổi (Amount cũ ${old.Amount}, mới ${d.Amount}) → Unpost rồi Build lại`,
        });
      }
      continue;
    }

    let draft = d;
    const posted = postedConflictOf(d);
    if (posted) {
      superseded.add(posted.AccountingEventID);
      plan.blocked++;
      const changes = [
        (posted.SourceID ?? "") !== (d.SourceID ?? "") ? `TransactionID ${posted.TransactionID} → ${d.TransactionID}` : null,
        posted.ComCode !== d.ComCode ? `ComCode ${posted.ComCode} → ${d.ComCode}` : null,
        posted.JournalTypeCode !== d.JournalTypeCode ? `JournalTypeCode ${posted.JournalTypeCode} → ${d.JournalTypeCode}` : null,
        posted.EventSeq !== d.EventSeq ? `EventSeq ${posted.EventSeq} → ${d.EventSeq}` : null,
      ].filter(Boolean);
      const where = `event ${posted.AccountingEventID} (ComCode ${posted.ComCode}, ${posted.JournalTypeCode}, chứng từ ${posted.PostedDocNum})`;
      const alsoBuild = [
        posted.Period !== d.Period ? `Build cả kỳ ${d.Period}` : null,
        posted.ComCode !== d.ComCode ? `Post cả ComCode ${d.ComCode}` : null,
      ].filter(Boolean);
      const message =
        (items(posted)
          ? `Item của event này đã ghi sổ ở ${where} dưới khóa khác (${changes.join(", ")}) → chặn để không ghi sổ trùng. `
          : `Đơn này đã ghi sổ ở ${where} dưới khóa khác (${changes.join(", ")}); event đó tạo trước khi có cột ItemCodes nên ` +
            `không xác định được item → chặn thận trọng để không ghi sổ trùng. `) +
        `Unpost ComCode ${posted.ComCode} kỳ ${posted.Period} rồi Build + Post lại` +
        (alsoBuild.length ? ` (${alsoBuild.join(", ")})` : "");
      draft = { ...d, PostStatus: "ERROR", ErrorStage: "BUILD", ErrorMessage: message };
      plan.exceptions.push({
        DataSource: d.DataSource,
        ComCode: d.ComCode,
        Period: d.Period,
        Severity: "ERROR",
        ExceptionType: "POSTED_KEY_CHANGED",
        SourceKey: `${d.TransactionID}|${norm(d.JournalTypeCode)}`,
        Message: message,
      });
    }

    if (old) plan.replace.push({ id: old.AccountingEventID, draft });
    else plan.insert.push(draft);
  }

  for (const e of existing) {
    if (!orphaned(e)) continue;
    if (e.PostStatus !== "POSTED") {
      plan.remove.push(e.AccountingEventID);
    } else if (!superseded.has(e.AccountingEventID)) {
      plan.exceptions.push({
        DataSource: e.DataSource,
        ComCode: e.ComCode,
        Period: e.Period,
        Severity: "WARNING",
        ExceptionType: "POSTED_SOURCE_CHANGED",
        SourceKey: `${e.TransactionID}|${norm(e.JournalTypeCode)}`,
        Message: `Event ${e.AccountingEventID} đã POSTED (chứng từ ${e.PostedDocNum}) nhưng lần Build này không còn sinh ra (số tiền về 0, rule bị tắt, đổi ngày giao, không map được ComCode/Company, đổi RuleSeq...) → Unpost rồi Build lại`,
      });
    }
  }

  return plan;
}

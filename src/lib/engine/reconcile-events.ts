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
 *  - cùng ComCode, cùng nghiệp vụ (JTC), và event POSTED đó không còn được sinh ra (đổi RuleSeq / cách viết JTC); hoặc
 *  - nguồn 1 dòng ⇄ 1 bộ event (`oneEventSetPerSource`: PayPal, Stripe, PIPO): cùng SourceID, cùng ComCode, event POSTED đó không
 *    còn được sinh ra — bất kể nghiệp vụ (dòng sao kê bị phân loại lại sau khi ghi sổ). Thông báo nêu event cũ cùng EventSeq
 *    (thay vì event đầu tiên), mọi event cũ đang chặn không bị cảnh báo POSTED_SOURCE_CHANGED thêm.
 * Draft bị chặn vẫn được ghi nhưng PostStatus ERROR / ErrorStage BUILD (Post không lấy) + exception POSTED_KEY_CHANGED.
 * Unpost event POSTED cũ rồi Build lại thì hết chặn (event cũ lúc đó chưa post, không còn sinh ra → bị xóa).
 *
 * Kỳ đã khóa sổ (`isLocked`, guide §6.12) — không bao giờ insert / replace / remove / heal event thuộc kỳ khóa:
 *  - draft thuộc kỳ khóa → bỏ qua (`locked`, DRAFT_LOCKED); event cùng khóa ở kỳ mở (dòng nguồn ngân hàng đổi ngày vào kỳ khóa)
 *    coi như không còn sinh ra (chưa post → xóa, POSTED → cảnh báo);
 *  - draft ở kỳ mở nhưng event cùng khóa ở kỳ khóa (nguồn ngân hàng: khóa event không chứa ngày) → không ghi (EVENT_LOCKED)
 *    + ERROR PERIOD_LOCKED;
 *  - event kỳ khóa ở MỌI trạng thái đều chặn draft trùng item (không xóa được nên draft mới sẽ ghi sổ trùng) → draft ghi ERROR
 *    + ERROR PERIOD_LOCKED thay cho POSTED_KEY_CHANGED;
 *  - event kỳ khóa không còn sinh ra → giữ nguyên, không cảnh báo (`lockedKept`).
 * Không truyền `isLocked` → kết quả y hệt trước khi có khóa sổ.
 *
 * Event POSTED cũ chưa có ItemCodes (tạo trước khi có cột):
 *  - draft cùng khóa, cùng SourceHash (hash đã gồm danh sách item) → biết chắc item → bổ sung ItemCodes (healItemCodes);
 *  - còn lại coi là trùng item khi cùng SourceID mà event đã đổi (không còn sinh ra / SourceHash khác), hoặc SourceID của
 *    nó đã chết (không còn dòng nguồn nào) — thận trọng, chấp nhận có thể chặn thừa.
 */
import type { AccountingEventRow } from "@/lib/db/schema";
import { eventKey } from "./keys";
import { lockMsg } from "./period-lock";
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
  /** (ComCode, Period) đã khóa sổ. Không truyền = không kỳ nào khóa */
  isLocked?: (x: { ComCode: string; Period: string }) => boolean;
  /**
   * Nguồn "1 dòng raw ⇄ 1 bộ event" (PayPal, Stripe, PIPO): event POSTED (hoặc thuộc kỳ khóa) của cùng SourceID mà không còn
   * được sinh ra chặn draft mới của dòng đó **dù khác JournalTypeCode / OrderID** — dòng bị phân loại lại sau khi đã ghi sổ
   * (sửa tay cột JournalType, đổi danh mục) thì Post sẽ ghi sổ trùng. Orders không bật: 1 SourceID sinh nhiều nghiệp vụ hợp lệ.
   */
  oneEventSetPerSource?: boolean;
}

export interface LockedDraft<D> {
  draft: D;
  /** DRAFT_LOCKED: draft thuộc kỳ khóa. EVENT_LOCKED: draft ở kỳ mở nhưng event cùng khóa thuộc kỳ khóa */
  reason: "DRAFT_LOCKED" | "EVENT_LOCKED";
  /** Event cùng khóa trong DB (nếu có) */
  eventId: number | null;
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
  /** Draft không ghi vì kỳ khóa sổ */
  locked: LockedDraft<D>[];
  /** Draft ở kỳ mở bị chặn vì event thuộc kỳ khóa (EVENT_LOCKED, hoặc ghi ERROR do trùng item) */
  lockedConflicts: number;
  /** Event thuộc kỳ khóa không còn được sinh ra → giữ nguyên */
  lockedKept: number;
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
  const {
    drafts,
    existing,
    relatedPosted = [],
    deadSourceIds = new Set<string>(),
    isLocked = () => false,
    oneEventSetPerSource = false,
  } = input;
  const plan: ReconcilePlan<D> = {
    insert: [],
    replace: [],
    remove: [],
    unchangedPosted: 0,
    blocked: 0,
    healItemCodes: [],
    exceptions: [],
    locked: [],
    lockedConflicts: 0,
    lockedKept: 0,
  };

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
      // Kỳ khóa: vẫn dùng item để dò trùng, nhưng không ghi bổ sung vào event
      if (!isLocked(e)) plan.healItemCodes.push({ id: e.AccountingEventID, ItemCodes: d.ItemCodes });
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

  /** Event POSTED (hoặc thuộc kỳ khóa) p, khác khóa, đang giữ item của draft d */
  const conflicts = (d: D, p: ExistingEvent) => {
    if (eventKey(p) === eventKey(d) || norm(p.DataSource) !== norm(d.DataSource) || !overlaps(d, p)) return false;
    if ((p.SourceID ?? "") !== (d.SourceID ?? "")) return true;
    if (p.ComCode !== d.ComCode) return true;
    // Cùng dòng nguồn, cùng công ty: chặn khi event cũ không còn sinh ra — Orders chỉ khi cùng nghiệp vụ (đổi RuleSeq/cách viết
    // JTC), nguồn 1 dòng ⇄ 1 bộ event thì mọi nghiệp vụ (dòng bị phân loại lại)
    return (oneEventSetPerSource || norm(p.JournalTypeCode) === norm(d.JournalTypeCode)) && orphaned(p);
  };

  const txKey = (e: { DataSource: string; TransactionID: string }) => `${norm(e.DataSource)}|${e.TransactionID}`;
  const orderKey = (e: { DataSource: string; OrderID?: string | null }) => `${norm(e.DataSource)}|${e.OrderID ?? ""}`;
  const group = (list: ExistingEvent[], keyOf: (e: ExistingEvent) => string) => {
    const map = new Map<string, ExistingEvent[]>();
    for (const e of list) {
      // Event kỳ khóa ở mọi trạng thái cũng chặn: không xóa / thay được nên draft trùng item sẽ ghi sổ trùng
      if (e.PostStatus !== "POSTED" && !isLocked(e)) continue;
      const bucket = map.get(keyOf(e)) ?? [];
      bucket.push(e);
      map.set(keyOf(e), bucket);
    }
    return map;
  };
  // So với mọi event POSTED cùng đơn (mọi ngày giao, mọi ComCode); event không có OrderID thì so cùng TransactionID
  const postedByOrder = group([...existing, ...relatedPosted], orderKey);
  const postedByTx = group(existing, txKey);
  // 1 dòng ⇄ 1 bộ event: so thêm mọi event cùng SourceID (OrderID / TransactionID của dòng có thể đã đổi)
  const sourceKey = (e: { DataSource: string; SourceID?: string | null }) => `${norm(e.DataSource)}|${e.SourceID ?? ""}`;
  const postedBySource = oneEventSetPerSource ? group(existing, sourceKey) : new Map<string, ExistingEvent[]>();

  /** Mọi event POSTED (hoặc kỳ khóa) đang giữ item của draft d */
  const blockersOf = (d: D): ExistingEvent[] => {
    const grouped = d.OrderID ? (postedByOrder.get(orderKey(d)) ?? []) : (postedByTx.get(txKey(d)) ?? []);
    const sameSource = oneEventSetPerSource && d.SourceID ? (postedBySource.get(sourceKey(d)) ?? []) : [];
    const candidates = sameSource.length ? [...new Set([...grouped, ...sameSource])] : grouped;
    return candidates.filter((p) => conflicts(d, p));
  };
  /**
   * Event nêu trong thông báo chặn: ưu tiên cùng nghiệp vụ. Nguồn 1 dòng ⇄ 1 bộ event: dòng bị phân loại lại thì mọi event cũ
   * đều khác nghiệp vụ → ghép theo EventSeq (= RuleSeq) để thông báo không báo nhầm "EventSeq 10 → 30" cho rule phí
   */
  const primaryBlocker = (d: D, hits: ExistingEvent[]): ExistingEvent | undefined => {
    const sameJtc = (p: ExistingEvent) => norm(p.JournalTypeCode) === norm(d.JournalTypeCode);
    const sameSeq = oneEventSetPerSource
      ? (hits.find((p) => sameJtc(p) && p.EventSeq === d.EventSeq) ?? hits.find((p) => p.EventSeq === d.EventSeq))
      : undefined;
    return sameSeq ?? hits.find(sameJtc) ?? hits[0];
  };

  const superseded = new Set<number>();
  /** Event ở kỳ mở mà bản mới cùng khóa thuộc kỳ khóa (không ghi được) → xử lý như không còn sinh ra */
  const orphanedByLock = new Set<number>();
  for (const d of drafts) {
    const old = existingByKey.get(eventKey(d));

    if (isLocked(d)) {
      plan.locked.push({ draft: d, reason: "DRAFT_LOCKED", eventId: old?.AccountingEventID ?? null });
      if (old && !isLocked(old)) orphanedByLock.add(old.AccountingEventID);
      continue;
    }
    if (old && isLocked(old)) {
      plan.locked.push({ draft: d, reason: "EVENT_LOCKED", eventId: old.AccountingEventID });
      plan.lockedConflicts++;
      plan.exceptions.push({
        DataSource: d.DataSource,
        ComCode: d.ComCode,
        Period: d.Period,
        Severity: "ERROR",
        ExceptionType: "PERIOD_LOCKED",
        SourceKey: `${d.TransactionID}|${norm(d.JournalTypeCode)}`,
        Message: lockMsg.sameKeyLocked(old, d.Period),
      });
      continue;
    }

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
    const hits = blockersOf(d);
    const posted = primaryBlocker(d, hits);
    // Event bị draft chặn thay thế → không cảnh báo POSTED_SOURCE_CHANGED thêm (draft đã báo). Nguồn 1 dòng ⇄ 1 bộ event: mọi
    // event đang chặn (nguồn ngân hàng: event cũ cùng dòng, không còn sinh ra) — kể cả khi bộ rule mới khác EventSeq
    if (posted) for (const p of oneEventSetPerSource ? hits : [posted]) superseded.add(p.AccountingEventID);
    if (posted && isLocked(posted)) {
      plan.blocked++;
      plan.lockedConflicts++;
      const message = lockMsg.blockedByLocked(posted);
      draft = { ...d, PostStatus: "ERROR", ErrorStage: "BUILD", ErrorMessage: message };
      plan.exceptions.push({
        DataSource: d.DataSource,
        ComCode: d.ComCode,
        Period: d.Period,
        Severity: "ERROR",
        ExceptionType: "PERIOD_LOCKED",
        SourceKey: `${d.TransactionID}|${norm(d.JournalTypeCode)}`,
        Message: message,
      });
    } else if (posted) {
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
      // Nguồn 1 dòng ⇄ 1 bộ event không dùng ItemCodes (luôn trống) → không phải event cũ "trước khi có cột ItemCodes"
      const message =
        (oneEventSetPerSource
          ? `Dòng nguồn này đã ghi sổ ở ${where} dưới khóa khác (${changes.join(", ")}) → chặn để không ghi sổ trùng. `
          : items(posted)
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
    if (isLocked(e)) {
      if (orphaned(e)) plan.lockedKept++;
      continue;
    }
    if (!orphaned(e) && !orphanedByLock.has(e.AccountingEventID)) continue;
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

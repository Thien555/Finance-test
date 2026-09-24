/**
 * Resolve đối tượng (partner) cho event.
 *
 * Seller (JournalType.Partner = "From Source"), thứ tự ưu tiên:
 *  1. TaxID trên order  = Partners.PartnerTaxID
 *  2. SellerEmail       = Partners.PartnerCode; nếu 1 email có nhiều store → lọc PartnerName theo StoreName
 *     (PartnerName dạng "FFT-{StoreName}" hoặc "FFT-FFT {StoreName}")
 *  3. Không match       → lỗi MISSING_PARTNER
 */
import type { PartnerRow } from "@/lib/db/schema";
import type { MasterIndex } from "./masters";

export interface ResolvedPartner {
  PartnerCode: string | null;
  PartnerTaxID: string | null;
  PartnerName: string | null;
}

export type SellerResolveResult =
  | { ok: true; partner: ResolvedPartner; matchedBy: "TAX_ID" | "EMAIL" | "EMAIL_STORE" }
  | { ok: false; error: string };

const toResolved = (p: PartnerRow): ResolvedPartner => ({
  PartnerCode: p.PartnerCode,
  PartnerTaxID: p.PartnerTaxID,
  PartnerName: p.PartnerName,
});

/** Partner cố định (VD INDIVIDUALS, PAYPAL). Không có trong bảng vẫn dùng mã đó. */
export function resolveFixedPartner(index: MasterIndex, code: string): ResolvedPartner {
  const found = index.partnersByCodeOf(code)[0];
  return found ? toResolved(found) : { PartnerCode: code, PartnerTaxID: null, PartnerName: null };
}

export interface CodeResolveResult {
  partner: ResolvedPartner;
  /** Tìm thấy trong Partners (có PartnerTaxID để gắn công nợ) */
  matched: boolean;
  /** 1 mã ứng nhiều partner mà StoreName không tách được → đã chọn dòng đầu, cần cảnh báo */
  ambiguous: boolean;
}

/**
 * Partner lấy thẳng từ cột PartnerCode trên nguồn (tài liệu §7.2 bước 4 — PayPal/PIPO/Stripe).
 * Khác `resolveSeller`: nguồn ngân hàng/PSP đã ghi sẵn mã đối tượng (VD "RoyalBank", "Paypal ZeniroxPay",
 * hoặc email seller), không suy từ TaxID trên dòng. 1 email seller có nhiều store thì lọc tiếp bằng StoreName.
 * Không có trong Partners vẫn ghi sổ với mã đó nhưng `matched = false` → build ghi cảnh báo
 * (PartnerTaxID trống thì công nợ không gắn được đối tượng).
 */
export function resolvePartnerByCode(
  index: MasterIndex,
  code: string | null | undefined,
  storeName?: string | null,
): CodeResolveResult {
  const value = code?.trim();
  if (!value) {
    return { partner: { PartnerCode: null, PartnerTaxID: null, PartnerName: null }, matched: false, ambiguous: false };
  }
  const all = index.partnersByCodeOf(value);
  if (all.length === 0) {
    return { partner: { PartnerCode: value, PartnerTaxID: null, PartnerName: null }, matched: false, ambiguous: false };
  }
  if (all.length === 1) return { partner: toResolved(all[0]), matched: true, ambiguous: false };

  const byStore = storeName ? all.filter((p) => storeNameMatches(p.PartnerName, storeName)) : [];
  if (byStore.length === 1) return { partner: toResolved(byStore[0]), matched: true, ambiguous: false };
  return { partner: toResolved(all.find((p) => !!p.PartnerTaxID) ?? all[0]), matched: true, ambiguous: true };
}

function storeNameMatches(partnerName: string | null, storeName: string): boolean {
  if (!partnerName) return false;
  const name = partnerName.trim().toUpperCase();
  const store = storeName.trim().toUpperCase();
  return name === `FFT-${store}` || name === `FFT-FFT ${store}` || name === store || name.endsWith(` ${store}`);
}

export function resolveSeller(
  index: MasterIndex,
  input: { taxId: string | null; sellerEmail: string | null; storeName: string | null },
): SellerResolveResult {
  if (input.taxId) {
    const byTax = index.partnersByTaxIdOf(input.taxId);
    if (byTax.length >= 1) return { ok: true, partner: toResolved(byTax[0]), matchedBy: "TAX_ID" };
  }

  if (!input.sellerEmail) {
    return { ok: false, error: "Order không có SellerEmail/TaxID để map seller" };
  }

  const all = index.partnersByCodeOf(input.sellerEmail);
  const sellers = all.filter((p) => (p.PartnerType ?? "").toUpperCase() === "SELLER");
  const candidates = sellers.length > 0 ? sellers : all;

  if (candidates.length === 0) {
    return { ok: false, error: `Không tìm thấy seller ${input.sellerEmail} trong Partners` };
  }
  if (candidates.length === 1) {
    return { ok: true, partner: toResolved(candidates[0]), matchedBy: "EMAIL" };
  }

  const byStore = input.storeName ? candidates.filter((p) => storeNameMatches(p.PartnerName, input.storeName!)) : [];
  if (byStore.length === 1) {
    return { ok: true, partner: toResolved(byStore[0]), matchedBy: "EMAIL_STORE" };
  }
  return {
    ok: false,
    error: `Seller ${input.sellerEmail} có ${candidates.length} store trong Partners, không xác định được store "${input.storeName ?? ""}"`,
  };
}

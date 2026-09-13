/**
 * FX Resolve (tài liệu §11, áp dụng theo cấu trúc sheet Exrate hiện có):
 *  - InputCurr = FncCurr → XRate = 1, MUL
 *  - Khác tiền → tìm Exrate theo Period + ReportCurrency(=FncCurr) + TransCurrency(=InputCurr) + IsActive
 *  - MUL: Accounted = Input × Rate ; DIV: Accounted = Input ÷ Rate
 */
import Decimal from "decimal.js";
import type { ExrateRow } from "@/lib/db/schema";

export type FxResult =
  | { ok: true; XRate: number; RateType: "MUL" | "DIV"; ExrateID: number | null }
  | { ok: false; error: string };

export function resolveFx(
  exrates: ExrateRow[],
  input: { period: string; fncCurr: string; inputCurr: string },
): FxResult {
  const fnc = input.fncCurr.trim().toUpperCase();
  const cur = input.inputCurr.trim().toUpperCase();
  if (fnc === cur) return { ok: true, XRate: 1, RateType: "MUL", ExrateID: null };

  const matches = exrates
    .filter(
      (r) =>
        r.IsActive &&
        r.Period === input.period &&
        r.ReportCurrency.trim().toUpperCase() === fnc &&
        r.TransCurrency.trim().toUpperCase() === cur &&
        r.Exrate > 0,
    )
    .sort((a, b) => (b.ExrateDate ?? "").localeCompare(a.ExrateDate ?? ""));

  const rate = matches[0];
  if (!rate) {
    return { ok: false, error: `Thiếu tỷ giá ${cur}→${fnc} kỳ ${input.period}` };
  }
  const op = rate.RateType.trim().toUpperCase() === "DIV" ? "DIV" : "MUL";
  return { ok: true, XRate: rate.Exrate, RateType: op, ExrateID: rate.ExrateID };
}

export function applyFx(amount: Decimal, fx: { XRate: number; RateType: "MUL" | "DIV" }): Decimal {
  const result = fx.RateType === "DIV" ? amount.dividedBy(fx.XRate) : amount.times(fx.XRate);
  return result.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

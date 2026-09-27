import { bool, handle, jsonBody, ok, str } from "@/lib/api";
import { lockPeriods } from "@/lib/services/periods";

/**
 * Body: { targets?: [{ comCode, period }], comCodes?: string[], throughPeriod?, actor?, note?, preview? }
 * Chọn 1 trong 2: `targets` hoặc `comCodes` + `throughPeriod` (khóa mọi kỳ ≤ throughPeriod có dữ liệu).
 */
export const POST = handle(async (req: Request) => {
  const body = await jsonBody(req);
  const targets = Array.isArray(body.targets)
    ? body.targets.map((t: unknown) => {
        const o = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
        return { comCode: String(o.comCode ?? ""), period: String(o.period ?? "") };
      })
    : null;
  const comCodes = Array.isArray(body.comCodes) ? body.comCodes.map((c: unknown) => String(c ?? "")) : null;
  return ok(
    lockPeriods({
      targets,
      comCodes,
      throughPeriod: str(body, "throughPeriod"),
      actor: str(body, "actor"),
      note: str(body, "note"),
      preview: bool(body, "preview"),
    }),
  );
});

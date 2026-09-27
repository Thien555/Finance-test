import { bool, handle, jsonBody, ok, str } from "@/lib/api";
import { unlockPeriod } from "@/lib/services/periods";

/** Body: { comCode, period, actor?, reason?, preview? } — chạy thật bắt buộc actor + reason */
export const POST = handle(async (req: Request) => {
  const body = await jsonBody(req);
  return ok(
    unlockPeriod({
      comCode: str(body, "comCode"),
      period: str(body, "period"),
      actor: str(body, "actor"),
      reason: str(body, "reason"),
      preview: bool(body, "preview"),
    }),
  );
});

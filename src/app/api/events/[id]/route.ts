import type { NextRequest } from "next/server";
import { fail, handle, ok } from "@/lib/api";
import { eventDetail } from "@/lib/services/queries";

export const GET = handle(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const detail = eventDetail(Number(id));
  return detail ? ok(detail) : fail("Không tìm thấy event", 404);
});

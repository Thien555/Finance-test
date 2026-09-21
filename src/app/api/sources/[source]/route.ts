import type { NextRequest } from "next/server";
import { handle, int, ok, paging, str } from "@/lib/api";
import { listRawSource } from "@/lib/services/queries";
import { parseSourceKey } from "@/lib/sources/route-params";

export const GET = handle(async (req: NextRequest, ctx: { params: Promise<{ source: string }> }) => {
  const source = parseSourceKey((await ctx.params).source);
  const q = req.nextUrl.searchParams;
  return ok(
    listRawSource(source, {
      ...paging(q),
      search: str(q, "search"),
      comCode: str(q, "comCode"),
      buildStatus: str(q, "buildStatus"),
      journalType: str(q, "journalType"),
      importBatchId: int(q, "importBatchId"),
      periodFrom: str(q, "periodFrom"),
      periodTo: str(q, "periodTo"),
    }),
  );
});

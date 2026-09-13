import type { NextRequest } from "next/server";
import { handle, int, ok, paging, parseScope, str } from "@/lib/api";
import { listEvents } from "@/lib/services/queries";

export const GET = handle((req: NextRequest) => {
  const q = req.nextUrl.searchParams;
  return ok(
    listEvents({
      ...parseScope(q),
      ...paging(q),
      journalTypeCode: str(q, "journalTypeCode"),
      postStatus: str(q, "postStatus"),
      search: str(q, "search"),
      postBatchId: int(q, "postBatchId"),
    }),
  );
});

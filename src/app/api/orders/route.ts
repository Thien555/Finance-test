import type { NextRequest } from "next/server";
import { handle, int, ok, paging, str } from "@/lib/api";
import { listRawOrders } from "@/lib/services/queries";

export const GET = handle((req: NextRequest) => {
  const q = req.nextUrl.searchParams;
  return ok(
    listRawOrders({
      ...paging(q),
      search: str(q, "search"),
      comCode: str(q, "comCode"),
      itemStatus: str(q, "itemStatus"),
      buildStatus: str(q, "buildStatus"),
      importBatchId: int(q, "importBatchId"),
      periodFrom: str(q, "periodFrom"),
      periodTo: str(q, "periodTo"),
    }),
  );
});

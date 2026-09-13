import type { NextRequest } from "next/server";
import { handle, ok, paging, str } from "@/lib/api";
import { listExceptions } from "@/lib/services/queries";

export const GET = handle((req: NextRequest) => {
  const q = req.nextUrl.searchParams;
  return ok(
    listExceptions({
      ...paging(q),
      batchType: str(q, "batchType"),
      exceptionType: str(q, "exceptionType"),
      severity: str(q, "severity"),
      comCode: str(q, "comCode"),
      search: str(q, "search"),
    }),
  );
});

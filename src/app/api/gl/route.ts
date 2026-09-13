import type { NextRequest } from "next/server";
import { handle, ok, paging } from "@/lib/api";
import { glFilterFrom } from "@/lib/gl-filter";
import { listGl } from "@/lib/services/queries";

export const GET = handle((req: NextRequest) => {
  const q = req.nextUrl.searchParams;
  return ok(listGl({ ...glFilterFrom(q), ...paging(q) }));
});

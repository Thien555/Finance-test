import type { NextRequest } from "next/server";
import { handle, ok, parseScope } from "@/lib/api";
import { listPeriodGrid } from "@/lib/services/periods";

/** Lưới công ty × kỳ: ?comCode&periodFrom&periodTo (YYYYMM) */
export const GET = handle((req: NextRequest) => {
  const { comCode, periodFrom, periodTo } = parseScope(req.nextUrl.searchParams);
  return ok(listPeriodGrid({ comCode, periodFrom, periodTo }));
});

import type { NextRequest } from "next/server";
import { handle, ok, paging, parseScope, str } from "@/lib/api";
import { listPeriodLog } from "@/lib/services/periods";

/** Lịch sử khóa / mở khóa: ?comCode&period&periodFrom&periodTo&action&page&pageSize */
export const GET = handle((req: NextRequest) => {
  const q = req.nextUrl.searchParams;
  const { comCode, periodFrom, periodTo } = parseScope(q);
  return ok(listPeriodLog({ comCode, periodFrom, periodTo, period: str(q, "period"), action: str(q, "action"), ...paging(q) }));
});

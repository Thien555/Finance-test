import type { NextRequest } from "next/server";
import { handle, xlsxResponse } from "@/lib/api";
import { glFilterFrom } from "@/lib/gl-filter";
import { glWorkbook } from "@/lib/services/export";
import { allGl } from "@/lib/services/queries";

/** Export GLTrans theo filter hiện tại → .xlsx (cột đúng thứ tự sheet GlTrans) */
export const GET = handle(async (req: NextRequest) => {
  const rows = allGl(glFilterFrom(req.nextUrl.searchParams));
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  return xlsxResponse(await glWorkbook(rows), `GLTrans_${stamp}.xlsx`);
});

import type { NextRequest } from "next/server";
import { fail, handle, ok, str } from "@/lib/api";
import { glDocumentDetail } from "@/lib/services/queries";

/** Drill-down 1 chứng từ: ?docNum=ASB-... */
export const GET = handle((req: NextRequest) => {
  const docNum = str(req.nextUrl.searchParams, "docNum");
  return docNum ? ok(glDocumentDetail(docNum)) : fail("Thiếu docNum");
});

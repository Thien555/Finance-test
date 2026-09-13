import type { NextRequest } from "next/server";
import { handle, int, parseScope, str, xlsxResponse } from "@/lib/api";
import { eventsWorkbook } from "@/lib/services/export";
import { allEvents } from "@/lib/services/queries";

export const GET = handle(async (req: NextRequest) => {
  const q = req.nextUrl.searchParams;
  const rows = allEvents({
    ...parseScope(q),
    journalTypeCode: str(q, "journalTypeCode"),
    postStatus: str(q, "postStatus"),
    search: str(q, "search"),
    postBatchId: int(q, "postBatchId"),
  });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  return xlsxResponse(await eventsWorkbook(rows), `AccountingEvent_${stamp}.xlsx`);
});

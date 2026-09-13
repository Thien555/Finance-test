import type { NextRequest } from "next/server";
import { fail, handle, ok, paging, str } from "@/lib/api";
import { listMaster, MASTER_TABLES, type MasterTableKey } from "@/lib/services/queries";

export const GET = handle(async (req: NextRequest, ctx: { params: Promise<{ table: string }> }) => {
  const { table } = await ctx.params;
  if (!(table in MASTER_TABLES)) return fail(`Bảng ${table} không tồn tại`, 404);
  const q = req.nextUrl.searchParams;
  return ok(listMaster(table as MasterTableKey, { ...paging(q), search: str(q, "search") }));
});

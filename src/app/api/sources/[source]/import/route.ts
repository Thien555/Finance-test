import type { NextRequest } from "next/server";
import { fail, handle, ok } from "@/lib/api";
import { importSourceFile } from "@/lib/services/import-source";
import { parseSourceKey } from "@/lib/sources/route-params";

/** Upload 1 sheet nguồn (.xlsx nhiều sheet hoặc .csv). Form field: "file", "sheet" (tùy chọn) */
export const POST = handle(async (req: NextRequest, ctx: { params: Promise<{ source: string }> }) => {
  const source = parseSourceKey((await ctx.params).source);
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return fail("Chưa chọn file");
  const sheet = form.get("sheet");
  const buffer = Buffer.from(await file.arrayBuffer());
  return ok(await importSourceFile(source, buffer, file.name, typeof sheet === "string" ? sheet : null));
});

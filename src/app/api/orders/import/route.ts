import type { NextRequest } from "next/server";
import { fail, handle, ok } from "@/lib/api";
import { importOrders } from "@/lib/services/import-orders";

/** Upload file order (.csv/.xlsx), form field "file" */
export const POST = handle(async (req: NextRequest) => {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return fail("Chưa chọn file");
  const buffer = Buffer.from(await file.arrayBuffer());
  return ok(await importOrders(buffer, file.name));
});

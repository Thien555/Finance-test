import type { NextRequest } from "next/server";
import { fail, handle, int, jsonBody, ok, str } from "@/lib/api";
import { deleteGatewayMapping, upsertGatewayMapping } from "@/lib/services/master";

/** Thêm/sửa: { ID?, PaymentGatewayName, ComCode, IsActive? } */
export const POST = handle(async (req: Request) => {
  const body = await jsonBody(req);
  upsertGatewayMapping({
    ID: int(body, "ID") ?? undefined,
    PaymentGatewayName: str(body, "PaymentGatewayName") ?? "",
    ComCode: str(body, "ComCode") ?? "",
    IsActive: int(body, "IsActive") ?? 1,
  });
  return ok({ done: true });
});

export const DELETE = handle((req: NextRequest) => {
  const id = int(req.nextUrl.searchParams, "id");
  if (!id) return fail("Thiếu id");
  deleteGatewayMapping(id);
  return ok({ done: true });
});

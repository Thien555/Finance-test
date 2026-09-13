import { handle, int, jsonBody, ok, str } from "@/lib/api";
import { upsertCompany } from "@/lib/services/master";
import { listMaster } from "@/lib/services/queries";

/** Route tĩnh này che route động /api/master/[table] nên phải tự khai báo GET */
export const GET = handle(() => ok(listMaster("company", {})));

/** Thêm/sửa Company: { ComCode, CompanyName?, FunctionalCurrency, IsActive? } */
export const POST = handle(async (req: Request) => {
  const body = await jsonBody(req);
  upsertCompany({
    ComCode: str(body, "ComCode") ?? "",
    CompanyName: str(body, "CompanyName"),
    FunctionalCurrency: str(body, "FunctionalCurrency") ?? "USD",
    IsActive: int(body, "IsActive") ?? 1,
  });
  return ok({ done: true });
});

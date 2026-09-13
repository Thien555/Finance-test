import { fail, handle, jsonBody, ok, parseScope, str } from "@/lib/api";
import { runPost } from "@/lib/services/post";

/** Post event → GLTrans. Body: { classify: "Single" | "Bulk" | "All", comCode?, periodFrom?, periodTo? } */
export const POST = handle(async (req: Request) => {
  const body = await jsonBody(req);
  const classify = str(body, "classify") ?? "All";
  if (!["Single", "Bulk", "All"].includes(classify)) return fail("classify phải là Single | Bulk | All");
  return ok(runPost(classify as "Single" | "Bulk" | "All", parseScope(body)));
});

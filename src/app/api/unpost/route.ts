import { bool, handle, int, jsonBody, ok, parseScope } from "@/lib/api";
import { unpost } from "@/lib/services/clear";

/** Body: { preview?, postBatchId?, comCode?, periodFrom?, periodTo? } */
export const POST = handle(async (req: Request) => {
  const body = await jsonBody(req);
  return ok(unpost({ scope: parseScope(body), postBatchId: int(body, "postBatchId"), preview: bool(body, "preview") }));
});

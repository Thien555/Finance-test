import { bool, handle, jsonBody, ok, parseScope } from "@/lib/api";
import { unbuild } from "@/lib/services/clear";

/** Body: { preview?, includePosted? (= Unpost + Unbuild), comCode?, periodFrom?, periodTo? } */
export const POST = handle(async (req: Request) => {
  const body = await jsonBody(req);
  return ok(unbuild({ scope: parseScope(body), includePosted: bool(body, "includePosted"), preview: bool(body, "preview") }));
});

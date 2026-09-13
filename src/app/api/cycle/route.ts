import { handle, jsonBody, ok, parseScope } from "@/lib/api";
import { runBuildOrders } from "@/lib/services/build";
import { runPost } from "@/lib/services/post";

/** Run Accounting Cycle: Build Orders → Post Single → Post Bulk */
export const POST = handle(async (req: Request) => {
  const scope = parseScope(await jsonBody(req));
  const build = runBuildOrders(scope);
  const post = build.Status === "SUCCESS" ? runPost("All", scope) : [];
  return ok({ build, post });
});

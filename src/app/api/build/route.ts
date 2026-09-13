import { handle, jsonBody, ok, parseScope } from "@/lib/api";
import { runBuildOrders } from "@/lib/services/build";

/** Build AccountingEvent từ RawOrders. Body: { comCode?, periodFrom?, periodTo? } */
export const POST = handle(async (req: Request) => ok(runBuildOrders(parseScope(await jsonBody(req)))));

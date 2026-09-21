import { handle, jsonBody, ok, parseScope } from "@/lib/api";
import { BadRequestError } from "@/lib/errors";
import { runBuildOrders } from "@/lib/services/build";
import { runBuildSource, SOURCE_DATA_SOURCES } from "@/lib/services/build-source";
import type { SourceKey } from "@/lib/sources/columns";
import { ORDERS_DATA_SOURCE } from "@/lib/engine/build-orders";

/**
 * Build AccountingEvent. Body: { dataSource?, comCode?, periodFrom?, periodTo? }
 * `dataSource` trống → ORDERS (giữ nguyên hành vi cũ).
 */
export const POST = handle(async (req: Request) => {
  const scope = parseScope(await jsonBody(req));
  const dataSource = (scope.dataSource ?? ORDERS_DATA_SOURCE).toUpperCase();
  if (dataSource === ORDERS_DATA_SOURCE) return ok(runBuildOrders(scope));

  const source = (Object.keys(SOURCE_DATA_SOURCES) as SourceKey[]).find(
    (k) => SOURCE_DATA_SOURCES[k].toUpperCase() === dataSource,
  );
  if (!source) {
    const known = [ORDERS_DATA_SOURCE, ...Object.values(SOURCE_DATA_SOURCES)].join(", ");
    throw new BadRequestError(`dataSource "${scope.dataSource}" không hợp lệ. Chọn: ${known}`);
  }
  return ok(runBuildSource(source, { ...scope, dataSource: SOURCE_DATA_SOURCES[source] }));
});

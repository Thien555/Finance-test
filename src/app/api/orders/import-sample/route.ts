import fs from "node:fs";
import path from "node:path";
import { handle, ok } from "@/lib/api";
import { importOrders } from "@/lib/services/import-orders";

/** Import nhanh file order mẫu data/samples/orders-sample.csv */
export const POST = handle(async () => {
  const file = path.join(process.cwd(), "data", "samples", "orders-sample.csv");
  return ok(await importOrders(fs.readFileSync(file), "orders-sample.csv"));
});

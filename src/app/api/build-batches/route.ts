import { handle, ok } from "@/lib/api";
import { listBuildBatches } from "@/lib/services/queries";

export const GET = handle(() => ok(listBuildBatches()));

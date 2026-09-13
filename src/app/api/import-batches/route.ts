import { handle, ok } from "@/lib/api";
import { listImportBatches } from "@/lib/services/queries";

export const GET = handle(() => ok(listImportBatches()));

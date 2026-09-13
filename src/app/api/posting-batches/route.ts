import { handle, ok } from "@/lib/api";
import { listPostingBatches } from "@/lib/services/queries";

export const GET = handle(() => ok(listPostingBatches()));

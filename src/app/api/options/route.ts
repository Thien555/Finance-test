import { handle, ok } from "@/lib/api";
import { filterOptions } from "@/lib/services/queries";

export const GET = handle(() => ok(filterOptions()));

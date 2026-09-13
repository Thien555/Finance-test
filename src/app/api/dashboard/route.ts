import { handle, ok } from "@/lib/api";
import { dashboardStats } from "@/lib/services/queries";

export const GET = handle(() => ok(dashboardStats()));

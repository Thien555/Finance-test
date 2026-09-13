import type { NextRequest } from "next/server";
import { handle, ok } from "@/lib/api";
import { glFilterFrom } from "@/lib/gl-filter";
import { glAccountSummary } from "@/lib/services/queries";

export const GET = handle((req: NextRequest) => ok(glAccountSummary(glFilterFrom(req.nextUrl.searchParams))));

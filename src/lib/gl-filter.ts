import { int, parseScope, str } from "@/lib/api";
import type { GlFilter } from "@/lib/services/queries";

export function glFilterFrom(q: URLSearchParams): GlFilter {
  return {
    ...parseScope(q),
    journalTypeCode: str(q, "journalTypeCode"),
    accountCode: str(q, "accountCode"),
    docNum: str(q, "docNum"),
    postBatchId: int(q, "postBatchId"),
    partner: str(q, "partner"),
    balanceImpact: str(q, "balanceImpact"),
  };
}

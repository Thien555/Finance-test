import { handle, ok } from "@/lib/api";
import { resetTransactionalData } from "@/lib/services/clear";

/** Xóa raw/event/GL/batch/exception (giữ master data) */
export const POST = handle(() => {
  resetTransactionalData();
  return ok({ done: true });
});

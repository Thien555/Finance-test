import { handle, ok } from "@/lib/api";
import { syncMastersFromGoogleSheet } from "@/lib/services/master";

/** Tải lại 6 sheet master từ Google Sheet → thay dữ liệu DB + cập nhật snapshot data/seed */
export const POST = handle(async () => ok({ counts: await syncMastersFromGoogleSheet() }));

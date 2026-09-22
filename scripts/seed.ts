/**
 * npm run db:seed — nạp lại master data từ snapshot data/seed/*.csv:
 * thay toàn bộ 6 bảng sheet; Company & GatewayCompanyMapping thêm/cập nhật, không xóa dòng chỉ có trong DB.
 */
import { closeDb, getDb } from "@/lib/db/client";
import { readSnapshotTexts, replaceMasters, upsertCompanySnapshot } from "@/lib/db/seed";

const db = getDb();
const counts = { ...replaceMasters(db, readSnapshotTexts()), ...upsertCompanySnapshot(db) };
console.log("Seed master data:", counts);
closeDb();

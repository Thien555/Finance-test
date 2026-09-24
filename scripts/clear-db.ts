/**
 * npm run db:clear — xóa toàn bộ dữ liệu giao dịch (raw, event, GL, batch, exception), **giữ master data**.
 * Giống nút "Xóa dữ liệu test" trên Dashboard nhưng chạy được khi không mở web.
 *
 * Khác `db:reset` (xóa hẳn file DB): không cần tắt dev server, và không mất Company /
 * GatewayCompanyMapping đã sửa trên web mà chưa chạy `db:export-seed`.
 *
 * Chạy thêm VACUUM + checkpoint WAL để file DB co lại — xóa dòng thôi thì SQLite giữ nguyên dung lượng.
 */
import fs from "node:fs";
import { closeDb, DB_FILE, getDb } from "@/lib/db/client";
import { resetTransactionalData } from "@/lib/services/clear";

const sizeMb = () => {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) total += fs.statSync(DB_FILE + suffix, { throwIfNoEntry: false })?.size ?? 0;
  return Math.round(total / 1e6);
};

const before = sizeMb();
const sqlite = getDb().$client; // mở DB: tự migrate + seed master nếu rỗng
resetTransactionalData();
sqlite.pragma("wal_checkpoint(TRUNCATE)");
sqlite.exec("VACUUM");
closeDb();

console.log(`Đã xóa dữ liệu giao dịch (giữ master). Dung lượng DB: ${before} MB → ${sizeMb()} MB`);

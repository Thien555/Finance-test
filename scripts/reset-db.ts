/** npm run db:reset — xóa file SQLite; lần chạy app tiếp theo sẽ tự tạo lại schema + seed */
import fs from "node:fs";
import { DB_FILE } from "@/lib/db/client";

for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(DB_FILE + suffix, { force: true });
console.log(`Đã xóa ${DB_FILE}`);

/**
 * npm run db:export-seed — ghi Company & GatewayCompanyMapping đang có trong DB ra data/seed
 * (2 bảng sửa trên web, không có trong Google Sheet) để commit rồi `npm run db:seed` ở máy khác.
 */
import { closeDb, getDb } from "@/lib/db/client";
import { writeCompanySnapshot } from "@/lib/db/seed";

console.log("Export data/seed:", writeCompanySnapshot(getDb()));
closeDb();

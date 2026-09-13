/** npm run db:seed — nạp lại 6 bảng master từ snapshot data/seed/*.csv */
import { closeDb, getDb } from "@/lib/db/client";
import { readSnapshotTexts, replaceMasters, seedDefaults } from "@/lib/db/seed";

const db = getDb();
const counts = replaceMasters(db, readSnapshotTexts());
seedDefaults(db);
console.log("Seed master data:", counts);
closeDb();

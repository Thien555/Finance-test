/**
 * Kết nối SQLite (1 instance dùng chung). Lần đầu mở sẽ tự chạy migration + seed master từ data/seed.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";
import { seedMastersIfEmpty } from "./seed";

export type AppDb = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export const DB_FILE = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "finance.db");

function createDb(): AppDb {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const sqlite = new Database(DB_FILE);
  sqlite.pragma("journal_mode = WAL");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  seedMastersIfEmpty(db);
  return db;
}

const globalForDb = globalThis as unknown as { __financeDb?: AppDb };

export function getDb(): AppDb {
  if (!globalForDb.__financeDb) globalForDb.__financeDb = createDb();
  return globalForDb.__financeDb;
}

export function closeDb() {
  globalForDb.__financeDb?.$client.close();
  globalForDb.__financeDb = undefined;
}

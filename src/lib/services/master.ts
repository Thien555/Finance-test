/** Sync master data từ Google Sheet + CRUD Company / GatewayCompanyMapping. */
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { company, gatewayCompanyMapping } from "@/lib/db/schema";
import { BadRequestError } from "@/lib/errors";
import { type MasterCsvTexts, replaceMasters, SEED_DIR } from "@/lib/db/seed";
import { MASTER_SHEETS, type MasterSheetKey, sheetCsvUrl } from "@/lib/master/sources";

export async function syncMastersFromGoogleSheet() {
  const entries = await Promise.all(
    (Object.keys(MASTER_SHEETS) as MasterSheetKey[]).map(async (key) => {
      const res = await fetch(sheetCsvUrl(MASTER_SHEETS[key].gid), { cache: "no-store", redirect: "follow" });
      const text = await res.text();
      if (!res.ok || text.trimStart().startsWith("<")) {
        throw new Error(`Không tải được sheet ${MASTER_SHEETS[key].label} (HTTP ${res.status}). Kiểm tra quyền chia sẻ Google Sheet.`);
      }
      return [key, text] as const;
    }),
  );
  const texts = Object.fromEntries(entries) as MasterCsvTexts;
  const counts = replaceMasters(getDb(), texts); // parse lỗi sẽ throw trước khi ghi DB
  for (const [key, text] of entries) {
    fs.writeFileSync(path.join(SEED_DIR, MASTER_SHEETS[key].file), text, "utf8");
  }
  return counts;
}

export interface GatewayMappingInput {
  PaymentGatewayName: string;
  ComCode: string;
  IsActive?: number;
}

export function upsertGatewayMapping(input: GatewayMappingInput & { ID?: number }) {
  const db = getDb();
  const values = {
    PaymentGatewayName: input.PaymentGatewayName.trim(),
    ComCode: input.ComCode.trim().toUpperCase(),
    IsActive: input.IsActive ?? 1,
  };
  if (!values.PaymentGatewayName || !values.ComCode) throw new BadRequestError("PaymentGatewayName và ComCode là bắt buộc");
  const duplicate = db.select().from(gatewayCompanyMapping).where(eq(gatewayCompanyMapping.PaymentGatewayName, values.PaymentGatewayName)).get();
  if (duplicate && duplicate.ID !== input.ID) {
    throw new BadRequestError(`"${values.PaymentGatewayName}" đã được map sang ${duplicate.ComCode}`);
  }
  if (!db.select().from(company).where(eq(company.ComCode, values.ComCode)).get()) {
    db.insert(company).values({ ComCode: values.ComCode, CompanyName: values.PaymentGatewayName, FunctionalCurrency: "USD" }).run();
  }
  if (input.ID) {
    db.update(gatewayCompanyMapping).set(values).where(eq(gatewayCompanyMapping.ID, input.ID)).run();
  } else {
    db.insert(gatewayCompanyMapping).values(values).run();
  }
}

export function deleteGatewayMapping(id: number) {
  getDb().delete(gatewayCompanyMapping).where(eq(gatewayCompanyMapping.ID, id)).run();
}

export function upsertCompany(input: { ComCode: string; CompanyName?: string | null; FunctionalCurrency: string; IsActive?: number }) {
  const db = getDb();
  const values = {
    ComCode: input.ComCode.trim().toUpperCase(),
    CompanyName: input.CompanyName ?? null,
    FunctionalCurrency: input.FunctionalCurrency.trim().toUpperCase(),
    IsActive: input.IsActive ?? 1,
  };
  if (!values.ComCode || !values.FunctionalCurrency) throw new BadRequestError("ComCode và FunctionalCurrency là bắt buộc");
  db.insert(company).values(values).onConflictDoUpdate({ target: company.ComCode, set: values }).run();
}

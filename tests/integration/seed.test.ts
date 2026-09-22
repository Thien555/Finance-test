/**
 * Snapshot Company & GatewayCompanyMapping (data/seed) ⇄ DB: DB mới nạp đúng snapshot, mở lại DB không đè dữ liệu
 * sửa trên web, db:seed thêm/cập nhật nhưng không xóa dòng chỉ có trong DB, export ghi ra đọc lại y hệt.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CompanyRow, GatewayCompanyMappingRow } from "@/lib/db/schema";

const dbFile = path.join(os.tmpdir(), `finance-seed-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = dbFile;
const exportDir = mkdtempSync(path.join(os.tmpdir(), "finance-seed-export-"));

describe("snapshot Company & GatewayCompanyMapping", async () => {
  const { readCompanySnapshot, upsertCompanySnapshot, writeCompanySnapshot } = await import("@/lib/db/seed");
  const { upsertCompany, upsertGatewayMapping } = await import("@/lib/services/master");
  const { parseCompanies, parseGatewayMappings } = await import("@/lib/master/parse-master");
  const { LOCAL_MASTER_FILES } = await import("@/lib/master/sources");
  const { getDb, closeDb } = await import("@/lib/db/client");

  afterAll(() => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(dbFile + suffix, { force: true });
    rmSync(exportDir, { recursive: true, force: true });
  });

  const snapshot = readCompanySnapshot();
  const sql = <T>(query: string) => getDb().$client.prepare(query).all() as T[];
  const byComCode = (rows: CompanyRow[]) => [...rows].sort((a, b) => (a.ComCode < b.ComCode ? -1 : a.ComCode > b.ComCode ? 1 : 0));
  const companies = () => byComCode(sql<CompanyRow>("SELECT ComCode, CompanyName, FunctionalCurrency, IsActive FROM Company"));
  const mappings = () =>
    sql<Omit<GatewayCompanyMappingRow, "ID">>("SELECT PaymentGatewayName, ComCode, IsActive FROM GatewayCompanyMapping ORDER BY ID");
  const mappingId = (name: string) =>
    (getDb().$client.prepare("SELECT ID FROM GatewayCompanyMapping WHERE PaymentGatewayName = ?").get(name) as { ID: number }).ID;

  it("DB mới nạp đúng snapshot (mapping theo thứ tự file), mapping nào cũng trỏ tới Company có trong snapshot", () => {
    expect(companies()).toEqual(byComCode(snapshot.companies));
    expect(mappings()).toEqual(snapshot.gatewayMappings);
    const codes = new Set(snapshot.companies.map((c) => c.ComCode));
    expect(snapshot.gatewayMappings.filter((m) => !codes.has(m.ComCode))).toEqual([]);
  });

  it("mở lại DB không nạp đè dữ liệu đã sửa trên web", () => {
    const [first] = snapshot.companies;
    upsertCompany({ ...first, CompanyName: "Sửa trên web" });
    closeDb();
    expect(companies().find((c) => c.ComCode === first.ComCode)?.CompanyName).toBe("Sửa trên web");
  });

  it("db:seed trên DB đã có dữ liệu: dòng trùng khóa về giá trị snapshot, dòng chỉ có trong DB được giữ", () => {
    const [firstMapping] = snapshot.gatewayMappings;
    const local = { ComCode: "LOCALCO", CompanyName: "Chỉ có ở máy này", FunctionalCurrency: "EUR", IsActive: 1 };
    upsertCompany(local);
    upsertGatewayMapping({ ID: mappingId(firstMapping.PaymentGatewayName), PaymentGatewayName: firstMapping.PaymentGatewayName, ComCode: "LOCALCO", IsActive: 0 });
    upsertGatewayMapping({ PaymentGatewayName: "Local Gateway", ComCode: "LOCALCO" });

    expect(upsertCompanySnapshot(getDb())).toEqual({ company: snapshot.companies.length, gatewayCompanyMapping: snapshot.gatewayMappings.length });
    expect(companies()).toEqual(byComCode([...snapshot.companies, local]));
    expect(mappings()).toEqual([...snapshot.gatewayMappings, { PaymentGatewayName: "Local Gateway", ComCode: "LOCALCO", IsActive: 1 }]);
  });

  it("export: file ghi ra đọc lại y hệt DB, kể cả tên có dấu phẩy, ngoặc kép, ký tự ngoài ASCII", () => {
    upsertCompany({ ComCode: "QUOTED", CompanyName: 'Công ty "A", chi nhánh — 1', FunctionalCurrency: "vnd" });
    const read = (file: string) => readFileSync(path.join(exportDir, file), "utf8");

    expect(writeCompanySnapshot(getDb(), exportDir)).toEqual({ company: companies().length, gatewayCompanyMapping: mappings().length });
    expect(byComCode(parseCompanies(read(LOCAL_MASTER_FILES.company)))).toEqual(companies());
    expect(parseGatewayMappings(read(LOCAL_MASTER_FILES.gatewayCompanyMapping))).toEqual(mappings());
  });

  it("parse file sửa tay: ComCode/FunctionalCurrency viết hoa, tiền tệ trống → USD, bỏ dòng thiếu khóa", () => {
    expect(parseCompanies("ComCode,CompanyName,FunctionalCurrency,IsActive\n newco ,NULL,,\n,Không mã,USD,1\n")).toEqual([
      { ComCode: "NEWCO", CompanyName: null, FunctionalCurrency: "USD", IsActive: 1 },
    ]);
    expect(parseGatewayMappings("PaymentGatewayName,ComCode,IsActive\n Shop A ,newco,0\nShop B,,1\n")).toEqual([
      { PaymentGatewayName: "Shop A", ComCode: "NEWCO", IsActive: 0 },
    ]);
  });
});

/**
 * Các đường ghi sổ trùng ngoài "cả đơn đổi công ty" (xem gateway-remap.test.ts):
 *  1. Đơn trả qua 2 cổng, chỉ 1 cổng đổi công ty sau khi post.
 *  2. Gỡ mapping → Build (raw thành ERROR) → import lại với FulfilledAt khác → gắn lại mapping → Build + Post.
 *  3. Như 2 nhưng Unpost trước khi import lại (event cũ thành NEW, không còn POSTED).
 *  4. Dòng đã đổi ngày giao sẵn trong DB (dữ liệu từ phiên bản cũ) → Build chặn → làm theo hướng dẫn.
 *  5. Unbuild ComCode mới trong khi item còn nằm trong event chưa post của ComCode cũ.
 *  6. Chốt chặn lúc Post: event chưa có ItemCodes, event trùng tạo từ phiên bản cũ.
 *  7. Event POSTED chưa có ItemCodes: import dòng sửa cùng đơn → Build bổ sung ItemCodes → import được.
 */
import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Papa from "papaparse";
import { afterAll, describe, expect, it } from "vitest";

const dbFile = path.join(os.tmpdir(), `finance-guards-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = dbFile;

const STRIPE = "ZeniroxPay - Stripe";
const MAIN_ORDER = "QVAJV-191125-Q1Z3V";
const sampleText = readFileSync(path.join(process.cwd(), "data", "samples", "orders-sample.csv"), "utf8").replace(/^﻿/, "");
const sampleRecords = Papa.parse<Record<string, string>>(sampleText, { header: true, skipEmptyLines: "greedy" }).data;
const toCsv = (records: Record<string, string>[]) => Buffer.from(Papa.unparse(records), "utf8");

describe("chặn ghi sổ trùng qua các đường khác", async () => {
  const { importOrders } = await import("@/lib/services/import-orders");
  const { runBuildOrders } = await import("@/lib/services/build");
  const { runPost } = await import("@/lib/services/post");
  const { unpost, unbuild, resetTransactionalData } = await import("@/lib/services/clear");
  const { upsertGatewayMapping, deleteGatewayMapping } = await import("@/lib/services/master");
  const { getDb, closeDb } = await import("@/lib/db/client");
  const { seedTestCompanies } = await import("../helpers/fixtures");
  seedTestCompanies(getDb());

  afterAll(() => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(dbFile + suffix, { force: true });
  });

  const sql = <T>(query: string) => getDb().$client.prepare(query).all() as T[];
  const exec = (query: string) => getDb().$client.prepare(query).run();
  const count = (query: string) => sql<{ n: number }>(`SELECT count(*) n FROM (${query})`)[0].n;
  /** Item + nghiệp vụ bị ghi sổ nhiều hơn 1 lần */
  const duplicateItems = () =>
    count("SELECT j.value, e.JournalTypeCode FROM AccountingEvent e, json_each(e.ItemCodes) j WHERE e.PostStatus = 'POSTED' GROUP BY 1, 2 HAVING count(*) > 1");
  const exceptions = (type: string) => count(`SELECT 1 FROM ExceptionLog WHERE ExceptionType = '${type}'`);
  const posted = (summaries: { PostedEvents: number; ErrorEvents: number }[]) => ({
    PostedEvents: summaries.reduce((n, x) => n + x.PostedEvents, 0),
    ErrorEvents: summaries.reduce((n, x) => n + x.ErrorEvents, 0),
  });
  const gl = () =>
    Object.fromEntries(
      sql<{ ComCode: string; dr: number }>("SELECT ComCode, round(sum(AccountedDr), 2) dr FROM GLTrans GROUP BY ComCode").map((r) => [r.ComCode, r.dr]),
    );
  const glTotal = () => sql<{ dr: number | null }>("SELECT round(sum(AccountedDr), 2) dr FROM GLTrans")[0].dr ?? 0;
  const stripeMappingId = () => sql<{ ID: number }>(`SELECT ID FROM GatewayCompanyMapping WHERE PaymentGatewayName = '${STRIPE}'`)[0]?.ID;
  const setStripe = (comCode: string) => upsertGatewayMapping({ ID: stripeMappingId(), PaymentGatewayName: STRIPE, ComCode: comCode, IsActive: 1 });
  const STRIPE_ORDERS = `SELECT OrderId FROM RawOrders WHERE PaymentGatewayName = '${STRIPE}'`;
  const redatedCsv = () => toCsv(sampleRecords.map((r) => (r.PaymentGatewayName === STRIPE ? { ...r, FulfilledAt: "11/22/2025" } : r)));
  const NOV = { periodFrom: "202511", periodTo: "202511" };
  /** Dữ liệu mẫu, Stripe → ZENIROXPAY, import + build + post */
  const fresh = async () => {
    resetTransactionalData();
    setStripe("ZENIROXPAY");
    await importOrders(toCsv(sampleRecords), "orders-sample.csv");
    runBuildOrders();
    runPost("All");
    expect(glTotal()).toBe(6339.7);
  };

  describe("1. đơn trả qua 2 cổng, chỉ 1 cổng đổi công ty", () => {
    const main = sampleRecords.find((r) => r.OrderId === MAIN_ORDER)!;
    const splitCsv = toCsv([...sampleRecords, { ...main, ItemCode: `${main.ItemCode}-B`, PaymentGatewayName: STRIPE }]);

    it("post khi cả 2 cổng cùng ZENIROXPAY", async () => {
      expect(await importOrders(splitCsv, "split.csv")).toMatchObject({ InsertedRows: 65, ErrorRows: 0 });
      runBuildOrders();
      expect(runPost("All")[1]).toMatchObject({ Status: "SUCCESS", PostedEvents: 174 });
      expect(gl()).toEqual({ ZENIROXPAY: 6402 });
    });

    it("đổi cổng Stripe → ONTARIO: item chuyển đi bị chặn, Post không ghi thêm (full build và build theo ONTARIO)", () => {
      setStripe("ONTARIO");
      for (const scope of [{}, { comCode: "ONTARIO" }]) {
        expect(runBuildOrders(scope)).toMatchObject({ Status: "SUCCESS", EventsBlocked: 15 });
        expect(runPost("All")[1].Status).toBe("NOTHING_TO_POST");
        expect(gl()).toEqual({ ZENIROXPAY: 6402 });
      }
      expect(sql(`SELECT ComCode, PostStatus, count(*) n FROM AccountingEvent WHERE OrderID = '${MAIN_ORDER}' GROUP BY 1, 2 ORDER BY 1`)).toEqual([
        { ComCode: "ONTARIO", PostStatus: "ERROR", n: 3 },
        { ComCode: "ZENIROXPAY", PostStatus: "POSTED", n: 3 },
      ]);
    });

    it("Unpost ZENIROXPAY → Build → Post: đơn tách được chia đúng 2 công ty, tổng sổ không đổi", () => {
      unpost({ scope: { comCode: "ZENIROXPAY" } });
      expect(runBuildOrders()).toMatchObject({ EventsBlocked: 0 });
      runPost("All");
      expect(gl()).toEqual({ ONTARIO: 563.7, ZENIROXPAY: 5838.3 });
      expect(glTotal()).toBe(6402);
    });
  });

  describe("2. import lại đổi FulfilledAt sau khi dòng đã rời BUILT", () => {
    it("chuẩn bị: dữ liệu mẫu, Stripe → ZENIROXPAY, post", async () => {
      resetTransactionalData();
      setStripe("ZENIROXPAY");
      await importOrders(toCsv(sampleRecords), "orders-sample.csv");
      runBuildOrders();
      runPost("All");
      expect(glTotal()).toBe(6339.7);
    });

    it("gỡ mapping Stripe → Build: dòng Stripe thành ERROR nhưng import lại dòng đổi ngày giao vẫn bị từ chối", async () => {
      deleteGatewayMapping(stripeMappingId());
      runBuildOrders();
      expect(sql("SELECT BuildStatus, count(*) n FROM RawOrders WHERE PaymentGatewayName = 'ZeniroxPay - Stripe' GROUP BY 1")).toEqual([
        { BuildStatus: "ERROR", n: 4 },
      ]);

      const redated = sampleRecords.map((r) => (r.PaymentGatewayName === STRIPE ? { ...r, FulfilledAt: "11/22/2025" } : r));
      const result = await importOrders(toCsv(redated), "redated.csv");
      expect(result).toMatchObject({ ReplacedRows: 0, ErrorRows: 4 });
      expect(result.errors.every((e) => e.message.includes("đã ghi sổ"))).toBe(true);
    });

    it("gắn lại mapping → Build + Post: không ghi sổ trùng", () => {
      upsertGatewayMapping({ PaymentGatewayName: STRIPE, ComCode: "ZENIROXPAY", IsActive: 1 });
      expect(runBuildOrders()).toMatchObject({ EventsCreated: 0, EventsBlocked: 0, EventsUnchangedPosted: 174 });
      expect(runPost("All")[1].Status).toBe("NOTHING_TO_POST");
      expect(glTotal()).toBe(6339.7);
    });
  });

  describe("3. Unpost rồi mới import lại đổi ngày giao", () => {
    it("gỡ mapping → Build → Unpost: event cũ thành NEW nhưng import dòng đổi ngày giao vẫn bị từ chối", async () => {
      await fresh();
      deleteGatewayMapping(stripeMappingId());
      runBuildOrders();
      unpost({ scope: { comCode: "ZENIROXPAY" } });

      const result = await importOrders(redatedCsv(), "redated.csv");
      expect(result).toMatchObject({ ReplacedRows: 0, ErrorRows: 4 });
      expect(result.errors.every((e) => e.message.includes("chưa post") && e.message.includes("Unbuild ComCode ZENIROXPAY kỳ 202511"))).toBe(true);
    });

    it("Unbuild theo gợi ý → import được → gắn lại mapping, Build + Post: không ghi sổ trùng", async () => {
      expect(unbuild({ scope: { comCode: "ZENIROXPAY", ...NOV } })).toMatchObject({ deletedEvents: 174, rawRowsReset: 60 }) // 4 dòng UNFULFILLED không có ngày giao nằm ngoài phạm vi kỳ;
      expect(await importOrders(redatedCsv(), "redated.csv")).toMatchObject({ ReplacedRows: 4, ErrorRows: 0 });
      setStripe("ZENIROXPAY");
      expect(runBuildOrders()).toMatchObject({ EventsCreated: 174, EventsBlocked: 0 });
      runPost("All");
      expect(glTotal()).toBe(6339.7);
      expect(duplicateItems()).toBe(0);
      expect(count(`SELECT 1 FROM AccountingEvent WHERE OrderID IN (${STRIPE_ORDERS}) AND TransactionID NOT LIKE '%-20251122'`)).toBe(0);
    });
  });

  describe("4. dòng đã đổi ngày giao sẵn trong DB sau khi post (dữ liệu từ phiên bản cũ)", () => {
    let oldTxns = "";
    it("Build chặn event ngày mới, Post không ghi thêm", async () => {
      await fresh();
      oldTxns = sql<{ t: string }>(`SELECT DISTINCT TransactionID t FROM AccountingEvent WHERE OrderID IN (${STRIPE_ORDERS})`)
        .map((r) => `'${r.t}'`)
        .join(",");
      exec(`UPDATE RawOrders SET FulfilledAt = '2025-11-22' || substr(FulfilledAt, 11) WHERE PaymentGatewayName = '${STRIPE}'`);

      expect(runBuildOrders()).toMatchObject({ EventsCreated: 12, EventsBlocked: 12, EventsRemoved: 0, EventsUnchangedPosted: 162 });
      expect(posted(runPost("All")).PostedEvents).toBe(0);
      expect(glTotal()).toBe(6339.7);
      expect(exceptions("POSTED_KEY_CHANGED")).toBe(12);
      expect(exceptions("POSTED_SOURCE_CHANGED")).toBe(0);
    });

    it("làm theo hướng dẫn (Unpost ComCode + kỳ cũ → Build → Post): event ngày cũ bị dọn, không ghi sổ trùng, hết exception", () => {
      const blocked = sql<{ ErrorMessage: string }>("SELECT ErrorMessage FROM AccountingEvent WHERE PostStatus = 'ERROR'")[0];
      expect(blocked.ErrorMessage).toContain("Unpost ComCode ZENIROXPAY kỳ 202511 rồi Build + Post lại");

      unpost({ scope: { comCode: "ZENIROXPAY", ...NOV } });
      expect(runBuildOrders({ comCode: "ZENIROXPAY", ...NOV })).toMatchObject({ EventsRemoved: 12, EventsBlocked: 0 });
      runPost("All");
      expect(glTotal()).toBe(6339.7);
      expect(duplicateItems()).toBe(0);
      expect(count(`SELECT 1 FROM AccountingEvent WHERE TransactionID IN (${oldTxns})`)).toBe(0);
      expect(count("SELECT 1 FROM ExceptionLog WHERE ExceptionType LIKE 'POSTED_%'")).toBe(0);
      expect(runBuildOrders()).toMatchObject({ EventsCreated: 0, EventsRemoved: 0, EventsBlocked: 0, EventsUnchangedPosted: 174 });
    });
  });

  describe("5. Unbuild ComCode mới khi item còn nằm trong event của ComCode cũ", () => {
    it("đổi cổng → Build (chặn) → Unpost ComCode cũ → Unbuild ComCode mới: dòng vẫn BUILT, import đổi ngày giao bị từ chối", async () => {
      await fresh();
      setStripe("ONTARIO");
      expect(runBuildOrders().EventsBlocked).toBe(12);
      unpost({ scope: { comCode: "ZENIROXPAY", ...NOV } });

      expect(unbuild({ scope: { comCode: "ONTARIO" } })).toMatchObject({ deletedEvents: 12, rawRowsReset: 0 });
      expect(sql(`SELECT BuildStatus, count(*) n FROM RawOrders WHERE PaymentGatewayName = '${STRIPE}' GROUP BY 1`)).toEqual([{ BuildStatus: "BUILT", n: 4 }]);
      expect(await importOrders(redatedCsv(), "redated.csv")).toMatchObject({ ReplacedRows: 0, ErrorRows: 4 });
    });

    it("Build + Post: đơn chia đúng 2 công ty, tổng sổ không đổi", () => {
      runBuildOrders();
      runPost("All");
      expect(gl()).toEqual({ ONTARIO: 501.4, ZENIROXPAY: 5838.3 });
      expect(duplicateItems()).toBe(0);
    });
  });

  describe("6. chốt chặn lúc Post", () => {
    it("event chưa có ItemCodes (tạo trước khi có cột) → Post giữ lại; Build lại rồi Post bình thường", async () => {
      resetTransactionalData();
      setStripe("ZENIROXPAY");
      await importOrders(toCsv(sampleRecords), "orders-sample.csv");
      runBuildOrders();
      exec("UPDATE AccountingEvent SET ItemCodes = NULL");

      expect(posted(runPost("All"))).toEqual({ PostedEvents: 0, ErrorEvents: 174 });
      expect(glTotal()).toBe(0);
      expect(exceptions("DUPLICATE_ITEM")).toBe(174);

      expect(runBuildOrders()).toMatchObject({ EventsReplaced: 174, EventsBlocked: 0 });
      expect(posted(runPost("All"))).toEqual({ PostedEvents: 174, ErrorEvents: 0 });
      expect(glTotal()).toBe(6339.7);
      expect(exceptions("DUPLICATE_ITEM")).toBe(0);
    });

    it("event trùng do phiên bản cũ tạo (NEW dưới ComCode mới, cạnh event POSTED) → Post giữ lại, sổ không đổi", async () => {
      await fresh();
      setStripe("ONTARIO");
      const cols = sql<{ name: string }>("PRAGMA table_info(AccountingEvent)")
        .map((c) => c.name)
        .filter((c) => c !== "AccountingEventID");
      const override: Record<string, string> = { ComCode: "'ONTARIO'", PostStatus: "'NEW'", PostedDocNum: "NULL", PostingGroupKey: "NULL", PostBatchID: "NULL", PostedAt: "NULL" };
      exec(
        `INSERT INTO AccountingEvent (${cols.map((c) => `"${c}"`).join(", ")})
         SELECT ${cols.map((c) => override[c] ?? `"${c}"`).join(", ")} FROM AccountingEvent WHERE OrderID IN (${STRIPE_ORDERS})`,
      );

      expect(posted(runPost("All"))).toEqual({ PostedEvents: 0, ErrorEvents: 12 });
      expect(gl()).toEqual({ ZENIROXPAY: 6339.7 });
      expect(exceptions("DUPLICATE_ITEM")).toBe(12);

      expect(runBuildOrders()).toMatchObject({ EventsReplaced: 12, EventsBlocked: 12 });
      expect(posted(runPost("All")).PostedEvents).toBe(0);
      expect(gl()).toEqual({ ZENIROXPAY: 6339.7 });
    });
  });

  describe("7. event POSTED tạo trước khi có cột ItemCodes", () => {
    const main = sampleRecords.find((r) => r.OrderId === MAIN_ORDER)!;
    const withItemB = (gateway: string) => toCsv([...sampleRecords, { ...main, ItemCode: `${main.ItemCode}-B`, PaymentGatewayName: gateway }]);

    it("sửa dòng lỗi (chưa từng post) cùng đơn: import báo cần Build lại; Build bổ sung ItemCodes rồi import được, không ghi trùng", async () => {
      resetTransactionalData();
      setStripe("ZENIROXPAY");
      await importOrders(withItemB("Zeniroxpay Typo"), "typo.csv");
      runBuildOrders();
      runPost("All");
      expect(glTotal()).toBe(6339.7);
      exec("UPDATE AccountingEvent SET ItemCodes = NULL");

      const refused = await importOrders(withItemB("ZeniroxPay Inc."), "fixed.csv");
      expect(refused).toMatchObject({ ReplacedRows: 0, ErrorRows: 1 });
      expect(refused.errors[0].message).toContain("tạo trước khi có cột ItemCodes");

      expect(runBuildOrders()).toMatchObject({ EventsBlocked: 0, EventsUnchangedPosted: 174 });
      expect(count("SELECT 1 FROM AccountingEvent WHERE ItemCodes IS NULL")).toBe(0);
      expect(await importOrders(withItemB("ZeniroxPay Inc."), "fixed.csv")).toMatchObject({ ReplacedRows: 1, ErrorRows: 0 });

      expect(runBuildOrders()).toMatchObject({ EventsBlocked: 0, EventsCreated: 0 });
      expect(exceptions("POSTED_SOURCE_CHANGED")).toBe(3);
      expect(posted(runPost("All")).PostedEvents).toBe(0);
      expect(glTotal()).toBe(6339.7);
      expect(duplicateItems()).toBe(0);
    });
  });
});

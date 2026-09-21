# DEVELOPER GUIDE – Sky Finance Accounting Engine

> Tài liệu kỹ thuật cho người/AI tiếp tục phát triển hoặc fix bug. Viết tiếng Việt, giữ nguyên tên bảng/cột/hàm/file.
> **Quy tắc:** khi thay đổi hành vi code, cập nhật mục tương ứng trong file này cùng lúc.
> Tài liệu nghiệp vụ gốc (yêu cầu tổng thể, chưa làm hết): [`tai lieu du an.md`](../tai%20lieu%20du%20an.md).
> Đặc tả nghiệp vụ ngắn (BA) cho luồng Order → GLTrans, có sơ đồ tổng quan: [`BA_ORDERS_TO_GLTRANS.md`](BA_ORDERS_TO_GLTRANS.md).

## Mục lục

0. [Đọc nhanh cho từng loại việc](#0-đọc-nhanh-cho-từng-loại-việc)
1. [Tổng quan & phạm vi](#1-tổng-quan--phạm-vi)
2. [Kiến trúc & thư mục](#2-kiến-trúc--thư-mục)
3. [Luồng xử lý & máy trạng thái](#3-luồng-xử-lý--máy-trạng-thái)
4. [Database](#4-database)
5. [Master data](#5-master-data)
6. [Tính năng chi tiết](#6-tính-năng-chi-tiết)
7. [API reference](#7-api-reference)
8. [Frontend](#8-frontend)
9. [Quy ước code](#9-quy-ước-code)
10. [Testing & baseline](#10-testing--baseline)
11. [Hướng dẫn mở rộng](#11-hướng-dẫn-mở-rộng)
12. [Debug & lỗi thường gặp](#12-debug--lỗi-thường-gặp)
13. [Giả định, hạn chế, nợ kỹ thuật](#13-giả-định-hạn-chế-nợ-kỹ-thuật)
14. [Thuật ngữ](#14-thuật-ngữ)

---

## 0. Đọc nhanh cho từng loại việc

| Việc cần làm | Đọc mục | File chính |
|---|---|---|
| Sửa công thức/logic sinh event từ order | §6.2 | `src/lib/engine/build-orders.ts`, `src/lib/services/build.ts` |
| Sửa cách ra Nợ/Có, DocNum, gom Bulk, tỷ giá | §6.3 | `src/lib/engine/post.ts`, `src/lib/engine/resolve-fx.ts`, `src/lib/services/post.ts` |
| Chống ghi sổ trùng (Build / Post / Import / Unbuild) | §6.1, §6.2, §6.3, §6.4 | `src/lib/engine/reconcile-events.ts`, `src/lib/engine/post-guard.ts` |
| Lỗi import file / parse số / ngày | §6.1, §12 | `src/lib/services/import-orders.ts`, `src/lib/io/read-table.ts`, `src/lib/orders/normalize.ts`, `src/lib/engine/parse.ts` |
| Seller không map được | §6.2, §5 | `src/lib/engine/resolve-partner.ts` |
| Unpost / Unbuild sai | §6.4 | `src/lib/services/clear.ts` |
| Thêm cột / đổi schema | §4, §11.2 | `src/lib/db/schema.ts`, `drizzle/` |
| Thêm nguồn PayPal/Stripe/PIPO/AccountingSource | §11.1 | — |
| Sửa màn hình | §8 | `src/app/**/page.tsx`, `src/components/*` |
| Thêm API | §7, §11.4 | `src/app/api/**/route.ts`, `src/lib/api.ts` |

Sau mọi thay đổi: `npm test` + `npx tsc --noEmit` + `npm run lint` (xem baseline §10).

---

## 1. Tổng quan & phạm vi

Web kế toán cho công ty dropshipping: nhận **file order thô** → chuẩn hóa thành **AccountingEvent** → ghi sổ ra **GLTrans** (sổ cái), mỗi lần ghi sổ có **PostingBatch**. Không có đăng nhập.

### 1.1 Đã làm
- Luồng **Orders** end-to-end: Import (.csv/.xlsx) → Build → Post Single/Bulk → GL inquiry + Export Excel.
- Unpost, Unbuild, Unpost + Unbuild (có preview), Run cycle, Reset dữ liệu test.
- Exceptions log, Dashboard, Master data (xem 6 bảng, sync Google Sheet, CRUD Company & GatewayCompanyMapping).
- Engine Post đã tổng quát theo JournalType/JournalLineRule (SIGNED/REVERSE/ERROR, FIXED partner, FX MUL/DIV) → dùng lại được cho nguồn khác.
- **4 nguồn ngoài Orders** end-to-end (§6.11): PayPal, Stripe, PIPO, AccountingSource (2 sheet nhập tay Master Card + Bank_Royal) — Import theo sheet → Build → Post → Unpost/Unbuild theo nguồn.

### 1.2 Chưa làm (theo `tai lieu du an.md`)
Auth/phân quyền (§20), Company tree & Accounting Period lock (§4), Manual Entry (§6), ExchangeRateResolveRule dạng Daily (§11 – hiện chỉ theo kỳ), PartnerSourceMapping riêng, Operation Audit Log, dashboard nâng cao.

### 1.3 Tech stack

| Thành phần | Version | Ghi chú |
|---|---|---|
| Next.js | 16.3 (App Router, Turbopack) | FE page + BE Route Handlers. Đọc `node_modules/next/dist/docs/` khi dùng API mới (xem `AGENTS.md`) |
| React | 19.2 | |
| antd | 6.x + `@ant-design/icons` 6 + `@ant-design/nextjs-registry` | Prop mới của v6, xem §8.3 |
| SQLite | `better-sqlite3` 13 + `drizzle-orm` 0.45 + `drizzle-kit` | File `data/finance.db` |
| Tính toán | `decimal.js` | Không cộng tiền bằng float |
| Ngày | `dayjs` (+ customParseFormat) | |
| File | `papaparse` (CSV), `exceljs` (đọc/ghi .xlsx) | |
| Test | `vitest` 5 | |

### 1.4 Lệnh

| Lệnh | Tác dụng |
|---|---|
| `npm run dev` | Dev server `http://localhost:3000`; lần đầu tự migrate + seed DB |
| `npm run build` / `npm start` | Build/chạy production |
| `npm test` / `npm run test:watch` | Vitest (unit + integration) |
| `npm run lint` | ESLint |
| `npx tsc --noEmit` | Typecheck |
| `npm run db:generate` | Sinh migration SQL vào `drizzle/` sau khi sửa `schema.ts` |
| `npm run db:seed` | Nạp lại 6 bảng master từ `data/seed/*.csv` |
| `npm run db:reset` | Xóa `data/finance.db*` (phải tắt dev server trước trên Windows) |

**Cài dependency:** `npm ci` (hoặc `npm i`), Node ≥ 22. Không cần Python hay Visual C++ Build Tools. File `.npmrc` đặt `ignore-scripts=true` vì npm bỏ qua `"gypfile": false` của `better-sqlite3` 13 (lấy metadata từ lockfile) nên vẫn gọi `node-gyp rebuild`. Lệnh này lỗi trên máy không có toolchain, dù gói đã kèm sẵn binary `prebuilds/<platform>-<arch>.node`. Các install script khác trong cây phụ thuộc (esbuild, unrs-resolver, fsevents) chỉ để kiểm tra hoặc dự phòng, bỏ qua không ảnh hưởng. Nếu sau này thêm gói **thật sự cần** postinstall: `npm rebuild <gói> --ignore-scripts=false`. Script gốc (`npm run dev`, `npm test`...) vẫn chạy bình thường, chỉ hook `pre*`/`post*` bị bỏ qua.

---

## 2. Kiến trúc & thư mục

### 2.1 Các lớp và chiều phụ thuộc

```
src/app/**/page.tsx        (client, antd)  ── fetch ──►  src/app/api/**/route.ts   (Route Handlers, mỏng)
                                                              │
                                                              ▼
                                                     src/lib/services/*          (đọc/ghi DB, transaction, batch log)
                                                              │
                                                              ▼
                                                     src/lib/engine/*            (logic nghiệp vụ THUẦN, không DB, có test)
```

- **engine**: nhận dữ liệu + `MasterIndex`, trả kết quả (events, GL lines, exceptions). Không import DB. Mọi quy tắc kế toán nằm ở đây.
- **services**: load dữ liệu từ DB, gọi engine, ghi kết quả trong transaction, ghi BuildBatch/PostingBatch/ExceptionLog.
- **api**: parse query/body (`src/lib/api.ts`), gọi service, trả JSON. Không chứa nghiệp vụ.
- **pages**: client component, gọi API qua `src/components/client.ts`.

### 2.2 Cây thư mục

```
tai lieu du an.md                 Tài liệu yêu cầu nghiệp vụ gốc
README.md                         Hướng dẫn chạy nhanh
CLAUDE.md / AGENTS.md             Ngữ cảnh cho AI (AGENTS.md có block do `next dev` tự quản lý)
docs/DEVELOPER_GUIDE.md           File này
data/
  seed/*.csv                      Snapshot 6 sheet master (seed DB)
  samples/orders-sample.csv|.xlsx File order mẫu 64 dòng (dùng cho test + nút "Import file mẫu")
  samples/paypal|stripe|pipo|master-card|bank-royal-sample.csv
                                  Mẫu trích từ Data-khac-order.xlsx cho test 4 nguồn ngoài Orders
  samples/*-reference.csv         Mẫu GlTrans/AccountingEvent/PostingBatch từ hệ thống cũ để đối chiếu format
  finance.db                      SQLite (gitignore, tự tạo)
drizzle/                          Migration SQL (0000_init.sql) + meta
scripts/seed.ts, reset-db.ts      Script npm db:seed / db:reset
src/
  app/
    layout.tsx                    AntdRegistry + AppShell
    globals.css
    page.tsx                      Dashboard
    raw/orders/page.tsx           1. Raw Orders
    raw/[source]/page.tsx         1b-1e. Raw PayPal / Stripe / PIPO / AccountingSource (1 trang động)
    events/page.tsx               2. AccountingEvent
    posting/page.tsx              3. Posting
    gl/page.tsx                   4. GLTrans
    exceptions/page.tsx           Exceptions
    master/page.tsx               Master data
    api/**/route.ts               28 route handler (§7)
  components/
    AppShell.tsx                  Layout + menu + ConfigProvider vi_VN
    client.ts                     useApi, getJson/postJson/deleteJson, toQuery, useOptions, money
    ui.tsx                        columnsOf, FieldTitle, StatusTag, ScopeBar
  lib/
    api.ts                        handle(), ok/fail, parseScope, paging, str/int/bool, xlsxResponse
    errors.ts                     BadRequestError (→ HTTP 400)
    field-docs.ts                 Giải thích cột GLTrans/AccountingEvent/PostingBatch (tooltip) – client-safe
    gl-columns.ts                 Thứ tự cột GLTrans/AccountingEvent – client-safe
    gl-filter.ts                  URLSearchParams → GlFilter
    db/schema.ts                  Drizzle schema 19 bảng + type
    db/client.ts                  getDb() (migrate + seed lần đầu), closeDb, DB_FILE
    db/seed.ts                    replaceMasters, seedMastersIfEmpty, seedDefaults, readSnapshotTexts
    engine/
      parse.ts                    parseNumber, parseDate, parseDateTime, toText, toFlag, isBlank, nowIso
      keys.ts                     ymd, periodOf, orderTransactionId, orderSourceId, singleDocNum, bulkDocNum, postingGroupKey, eventKey, sha256
      masters.ts                  Masters, MasterIndex, parsePartnerRule, accountFromSource
      resolve-partner.ts          resolveFixedPartner, resolveSeller, resolvePartnerByCode
      resolve-fx.ts               resolveFx, applyFx
      build-orders.ts             buildOrderEvents, orderRowsInScope + hằng ORDER_JOURNAL_TYPE_CODES
      build-bank.ts               buildBankEvents, BankSourceSpec, amountFromSource — engine chung 4 nguồn ngoài Orders (§6.11)
      sources/*.ts                Khai báo từng nguồn paypal/stripe/pipo/accounting-source (đọc cột nào, lọc gì, tiền ở đâu)
      reconcile-events.ts         reconcileEvents (đối chiếu draft với event trong DB → insert/replace/xóa/chặn ghi sổ trùng)
      post.ts                     classifyOf, expandEvent, postEvents, assertBalanced
      post-guard.ts               findDuplicateItems (chốt chặn lúc Post: item đã/đang ghi sổ dưới khóa khác)
      types.ts                    ExceptionType, ExceptionDraft, EventDraft, GlLineDraft
    io/read-table.ts              readTable (CSV/XLSX → records)
    master/sources.ts             ID Google Sheet + gid, DEFAULT_COMPANIES, DEFAULT_GATEWAY_MAPPINGS
    master/parse-master.ts        Parse CSV 6 bảng master
    orders/columns.ts             46 cột file order – client-safe
    orders/normalize.ts           canonicalHeaders, normalizeOrderRow
    sources/columns.ts            Cột 5 sheet ngoài Orders, SOURCE_META, SHEET_COLUMNS, canonicalHeaderMap – client-safe
    sources/normalize.ts          normalize{Paypal,Stripe,Pipo,AccountingSource}Row, signedAmount
    sources/route-params.ts       parseSourceKey (tham số [source] sai → 400)
    services/
      common.ts                   Scope, loadMasterIndex, scopeWhere, chunk, insertExceptions, deleteExceptionsByKeys, deleteExceptionsByDataSource
      import-orders.ts            importOrders
      import-source.ts            importSourceFile (chung cho 4 nguồn, chọn sheet)
      build.ts                    runBuildOrders
      build-source.ts             runBuildSource, SOURCE_DATA_SOURCES, resetSourceRawStatus, countBuiltSourceRows
      post.ts                     runPost
      clear.ts                    unpost, unbuild, resetTransactionalData
      queries.ts                  list*/detail/dashboard/options/listMaster
      export.ts                   glWorkbook, eventsWorkbook
      master.ts                   syncMastersFromGoogleSheet, upsertGatewayMapping, deleteGatewayMapping, upsertCompany
tests/
  helpers/fixtures.ts             loadMasters, loadIndex, loadSampleOrders, loadSample{Paypal,Stripe,Pipo,AccountingSource}, toEventRows
  engine/parse.test.ts
  engine/build-orders.test.ts
  engine/post.test.ts
  engine/reconcile-events.test.ts Build lại: chống ghi sổ trùng theo item khi khóa event đổi, đổi ngày giao, đơn nhiều cổng, phạm vi ComCode
  engine/post-guard.test.ts       Chốt chặn ghi sổ trùng lúc Post
  integration/flow.test.ts        Cả luồng trên DB tạm
  integration/gateway-remap.test.ts Đổi GatewayCompanyMapping sau khi post → chặn → Unpost → Build → Post
  engine/build-bank.test.ts       4 nguồn ngoài Orders: map JournalType, resolve tài khoản 3 tầng, dấu tiền, FX CAD
  integration/bank-sources.test.ts Import 5 sheet → Build → Post → Unpost/Unbuild theo nguồn
  integration/posted-guards.test.ts Đơn 2 cổng đổi 1 cổng; import lại đổi ngày giao sau khi gỡ mapping
```

### 2.3 Quy tắc import (quan trọng)
- **Page client không được import** module kéo theo `node:crypto`, `node:fs`, `exceljs`, `better-sqlite3` (ví dụ `engine/keys.ts`, `orders/normalize.ts`, `sources/normalize.ts`, `services/*` trừ `import type`). Nếu cần hằng số dùng chung, đặt trong file client-safe: `src/lib/orders/columns.ts`, `src/lib/sources/columns.ts`, `src/lib/gl-columns.ts`, `src/lib/field-docs.ts`.
- Từ page chỉ `import type { ... } from "@/lib/services/..."` hoặc `@/lib/db/schema` (chỉ type).
- Engine không import `db/client` hay `services`.

---

## 3. Luồng xử lý & máy trạng thái

### 3.1 Luồng

```
File order ──(1) Import──► RawOrders ──(2) Build──► AccountingEvent ──(3) Post──► GLTrans
                              │                      (PostStatus=NEW)        │
                         ImportBatch             BuildBatch + ExceptionLog  PostingBatch + ExceptionLog
```

- **AccountingEvent** = 1 giao dịch nguồn × 1 JournalLineRule (1 cặp Nợ/Có tiềm năng). Có ngày, kỳ, số tiền signed, các TK (Bank/Contra/Trans/Fee), partner — **chưa tách Nợ/Có**.
- **GLTrans** = mỗi dòng 1 vế Nợ hoặc Có; mọi dòng cùng `DocNum` cân Nợ = Có.
- **PostingBatch** = 1 lần chạy Post cho 1 loại Classify.

### 3.2 `RawOrders.BuildStatus`

| Giá trị | Ý nghĩa | Chuyển sang |
|---|---|---|
| `NOT_BUILT` | Mới import / đã unbuild | Build → BUILT / SKIPPED / ERROR |
| `BUILT` | Dòng đã được dùng để sinh event (kể cả khi mọi amount = 0) | Unbuild → NOT_BUILT. Import lại dòng thay đổi bị chặn |
| `SKIPPED` | Không FULFILLED / thiếu FulfilledAt (`BuildMessage` ghi lý do) | Build lại, import lại |
| `ERROR` | Thiếu ComCode mapping / Company | Sửa master → Build lại |

### 3.3 `AccountingEvent.PostStatus` + `ErrorStage`

| PostStatus | ErrorStage | Nguồn gốc | Post có lấy? | Cách xử lý |
|---|---|---|---|---|
| `NEW` | null | Build thành công | Có | — |
| `ERROR` | `BUILD` | Build: không map được seller (`MISSING_PARTNER`); hoặc item của event đã POSTED dưới khóa khác (`POSTED_KEY_CHANGED`) | **Không** | Seller: sửa Partners → Build lại (event được replace). Khóa đổi: Unpost ComCode + kỳ cũ (nêu trong message) → Build → Post |
| `ERROR` | `POST` | Post: thiếu rule/TK/tỷ giá/CoA, amount âm với ERROR; item trùng event khác ngày giao/công ty hoặc event chưa có ItemCodes (`DUPLICATE_ITEM`) | **Có** (retry mỗi lần Post) | Sửa master → Post lại. `DUPLICATE_ITEM`: Build lại (§6.3) |
| `SKIPPED` | `POST` | Post: amount × factor = 0 hoặc TK null có cờ Skip | Không | Unbuild/Build nếu cần |
| `POSTED` | null | Post thành công, có `PostedDocNum`, `PostBatchID`, `PostedAt`, `PostingGroupKey` (Bulk) | Không | Unpost → NEW |

### 3.4 Batch

| Bảng | Status |
|---|---|
| `ImportBatch` | `SUCCESS` (không lỗi) · `PARTIAL` (có lỗi nhưng có dòng thành công/skip) · `FAILED` (thiếu cột bắt buộc hoặc toàn lỗi). Tạm `RUNNING` trong transaction |
| `BuildBatch` | `RUNNING` → `SUCCESS` / `FAILED` |
| `PostingBatch` | `RUNNING` → `SUCCESS` / `FAILED`; `UNPOSTED` khi Unpost xóa hết dòng GL của batch. Không tạo batch nếu không có event (`NOTHING_TO_POST` chỉ có trong response) |

---

## 4. Database

File `src/lib/db/schema.ts`. **Tên bảng/cột PascalCase giữ đúng như sheet** để đối chiếu; key trong Drizzle object trùng tên cột, nên JSON API trả về đúng tên cột.

### 4.1 Kiểu dữ liệu
- Ngày: `TEXT` dạng `YYYY-MM-DD` (`PostingDate`, `TransDate`, `DocDate`, `RawOrders.FulfilledAt`). Thời điểm: `YYYY-MM-DD HH:mm:ss` (`AddDate`, `StartedAt`...) theo giờ máy chủ (`nowIso()`).
- Kỳ: `TEXT` `YYYYMM`.
- Tiền: `REAL`, luôn được làm tròn 2 số lẻ trước khi ghi (tính bằng Decimal).
- Cờ: `INTEGER` 0/1.

### 4.2 Bảng

**Master / config**

| Bảng | Khóa | Ghi chú |
|---|---|---|
| `Partners` | `PartnerID` | Index `PartnerCode`, `PartnerTaxID`. Seller: `PartnerCode` = email, `PartnerName` = `FFT-{Store}`, `PartnerTaxID` = mã định danh |
| `JournalType` | `JournalTypeID` | `DataSource`, `JournalType` (tên/loại gốc), `JournalTypeCode`, `BankAccount`, `ContraAccount`, `TransAccount`, `FeeAccount`, `Partner` ("Fixed = X" / "From Source"), `Classify` (Single/Bulk), `GroupRule` (chỉ mô tả, code không dùng) |
| `JournalLineRule` | `JournalLineRuleID` | `JournalTypeCode`, `RuleSeq`, `PairCode`, `NormalDrAccountSource`, `NormalCrAccountSource`, `AmountSource`, `AmountFactor`, `ReverseIfNegative`, `SkipIfDrAccountNull`, `SkipIfCrAccountNull`, `SkipIfAmountZero`, `PartnerMode`, `FixedPartner`, `ApplyPartnerToDrLine`, `ApplyPartnerToCrLine`, `MemoTemplate`, `IsActive`, `NegativeMode` |
| `CoA` | `CoAID` | `AccountCode`, `AccountName`, `AccountType`, `BalanceSide`, `Status`, `ARAP`, `ARAPType` |
| `Exrate` | `ExrateID` | `Period`, `ExrateDate`, `ReportCurrency` (= FncCurr), `TransCurrency` (= InputCurr), `RateType` (MUL/DIV), `Exrate`, `IsActive` |
| `MappingBankAccount` | `ID` auto | `ComCode`, `BankAccountNumber`, `InputCurr`, `GLAccountCode`, `BankName`, `IsActive`. Orders không dùng; 4 nguồn còn lại dùng để resolve tài khoản ngân hàng/PSP (§6.11) |
| `Company` | `ComCode` | `CompanyName`, `FunctionalCurrency` (= FncCurr), `IsActive`. **Không có trong sheet** |
| `GatewayCompanyMapping` | `ID` auto, unique `PaymentGatewayName` | Map cột `PaymentGatewayName` của order → `ComCode`. **Không có trong sheet** |

**Raw**

| Bảng | Khóa | Ghi chú |
|---|---|---|
| `ImportBatch` | `ImportBatchID` | `DataSource`, `FileName`, `UploadedAt`, `Status`, `TotalRows`, `SuccessRows`, `ErrorRows`, `SkippedRows`, `ErrorMessage`, `ErrorDetails` (JSON `[{row,key,message}]`, tối đa 500) |
| `RawOrders` | `RawOrderID`, **unique `ItemCode`** | `ImportBatchID`, `ComCode` (resolve lúc import và build), `BuildStatus`, `BuildMessage`, `RowHash` + 46 cột file order (xem `src/lib/orders/columns.ts`). Index `OrderId`, `FulfilledAt` |
| `RawPaypal` | `RawPaypalID`, **unique `SourceKey`** | Cột quản trị chung (`ImportBatchID`, `SourceKey`, `ComCode`, `PostingDate`, `BuildStatus`, `BuildMessage`, `RowHash`) + 23 cột sheet `Bank_Paypal`. Index `PostingDate`, `Transaction ID` |
| `RawStripe` | `RawStripeID`, **unique `SourceKey`** | Cột quản trị chung + 30 cột sheet `Bank_Stripe`. Index `PostingDate`, `id` |
| `RawPipo` | `RawPipoID`, **unique `SourceKey`** | Cột quản trị chung + 17 cột sheet `Bank_Pipo`. Index `PostingDate`, `TransactionId` |
| `RawAccountingSource` | `RawAccountingSourceID`, **unique `SourceKey`** | Cột quản trị chung + `SheetName` + hợp các cột của 2 sheet `Master Card` và `Bank_Royal`. Index `PostingDate`, `SheetName` |

> Tên cột của 4 bảng raw mới giữ **đúng header sheet**, kể cả khoảng trắng (`Transaction ID`, `Time Zone`, `invoiceId (metadata)`) và typo `BankAccoutNumber`. Trong TypeScript chúng có tên thuộc tính gọn hơn (`TransactionID`, `TimeZone`, `MetaInvoiceId`) — xem `src/lib/db/schema.ts`.
> `ComCode` của các bảng này lấy **thẳng từ cột ComCode trên file** (khác Orders — Orders suy từ `PaymentGatewayName`).

**Engine**

| Bảng | Khóa | Ghi chú |
|---|---|---|
| `BuildBatch` | `BuildBatchID` | Scope + `SourceRows`, `EventsCreated`, `EventsReplaced`, `EventsError`, `SkippedRows` |
| `AccountingEvent` | `AccountingEventID`; **unique `UX_AccountingEvent_Key` (ComCode, DataSource, JournalTypeCode, TransactionID, EventSeq)** | Đủ cột sheet AccountingEvent + `ErrorStage`, `BuildBatchID`, `ItemCodes` (JSON mảng ItemCode tạo nên event, NULL với event tạo trước migration `0001`). Index `PostStatus`, `PostedDocNum`, (`DataSource`,`SourceID`), (`DataSource`,`OrderID`) |
| `PostingBatch` | `PostBatchID` | Cột sheet Postingbatch + `PostedEvents`, `ErrorEvents`, `SkippedEvents` |
| `GLTrans` | `ID` | Đúng 33 cột sheet GlTrans. Index `DocNum`, `PostBatchID`, (`ComCode`,`Period`) |
| `ExceptionLog` | `ID` | `BatchType` (IMPORT/BUILD/POST), `BatchID`, `DataSource`, `ComCode`, `Period`, `Severity` (INFO/WARNING/ERROR), `ExceptionType`, `SourceKey`, `Message`, `CreatedAt` |

Không có foreign key; liên kết qua giá trị:

| Từ | Sang | Ghi chú |
|---|---|---|
| `GLTrans.DocNum` | `AccountingEvent.PostedDocNum` | Liên kết chính GL ↔ event. Bulk: nhiều event 1 DocNum |
| `GLTrans.PostingGroupKey` | `AccountingEvent.PostingGroupKey` | Chỉ Bulk; Single để null |
| `GLTrans.ReferenceTxnID` | `AccountingEvent.TransactionID` | Chỉ Single; Bulk để null |
| `AccountingEvent.OrderID` + `PostingDate` | `RawOrders.OrderId` + `FulfilledAt` | Cách join thực tế ở `eventDetail`/`glDocumentDetail` |
| `AccountingEvent.ItemCodes` (JSON) | `RawOrders.ItemCode` (unique) | **n-n**, liên kết event → dòng raw duy nhất được vật chất hóa; truy vấn bằng `json_each`. Chỉ Orders dùng; 4 nguồn kia để null |
| `AccountingEvent.SourceID` = `{DataSource}\|{SourceKey}` | `RawPaypal/RawStripe/RawPipo/RawAccountingSource.SourceKey` | Liên kết event → dòng raw của các nguồn ngoài Orders (1 dòng raw ⇄ 1 bộ event) |
| `RawOrders.ImportBatchID` | `ImportBatch.ImportBatchID` | |
| `AccountingEvent.BuildBatchID` / `PostBatchID` | `BuildBatch` / `PostingBatch` | `PostBatchID` về null khi Unpost |
| `GLTrans.PostBatchID` | `PostingBatch.PostBatchID` | notNull |
| `ExceptionLog.BatchType` + `BatchID` | `BuildBatch` / `PostingBatch` | Polymorphic; `IMPORT` chưa có caller |

Sơ đồ toàn cảnh 15 bảng + ERD 5 bảng lõi: [`BA_ORDERS_TO_GLTRANS.md` § Sơ đồ quan hệ dữ liệu](BA_ORDERS_TO_GLTRANS.md#sơ-đồ-quan-hệ-dữ-liệu). Chuỗi tra cứu master: [`MAPPING_ORDERS_TO_GLTRANS.md` §12.1](MAPPING_ORDERS_TO_GLTRANS.md).

### 4.3 Kết nối, migrate, seed
- `getDb()` (`src/lib/db/client.ts`): mở `DATABASE_PATH` hoặc `data/finance.db`, bật WAL, chạy `migrate()` với `drizzle/`, gọi `seedMastersIfEmpty()` (nếu `JournalType` rỗng → nạp snapshot; nếu `Company`/`GatewayCompanyMapping` rỗng → nạp mặc định). Instance cache trên `globalThis.__financeDb` (sống qua HMR).
- **Đổi schema:** sửa `schema.ts` → `npm run db:generate` (tạo `drizzle/000X_*.sql`) → restart dev. Với dữ liệu test có thể `npm run db:reset`.
- Transaction better-sqlite3 là **đồng bộ**: `db.transaction((tx) => { tx.insert(...).run(); ... })`. Không `await` bên trong callback.

---

## 5. Master data

### 5.1 Nguồn
`src/lib/master/sources.ts`:
- Spreadsheet master: `1CEQn7o4tgli3InJtF5cU8ePoPY9VYmUK`, gid: partners `1322113275`, JournalType `334328394`, journalLineRule `914272083`, CoA `780643702`, Exrate `1288319457`, MappingBankAccount `2073779528`.
- (Tham khảo, không sync) mẫu output: GlTrans `1306730224`, AccountingEvent `958217952`, Postingbatch `739936264` → đã lưu `data/samples/*-reference.csv`.
- File order mẫu: spreadsheet `1olwyT7rw5sy7OyiDCv9sdg9cuZOjYiLUwn8y_W4urUM`, gid `1181612899`.
- URL export CSV: `sheetCsvUrl(gid)` = `https://docs.google.com/spreadsheets/d/{id}/export?format=csv&gid={gid}` (sheet phải share public "anyone with link").

### 5.2 Parser (`src/lib/master/parse-master.ts`)
- `"NULL"`/rỗng → `null` (`isBlank`, `toText`).
- Số dạng dấu phẩy thập phân (`"1,439"` → 1.439) qua `parseNumber`.
- **JournalType**: header cột 6 trong sheet ghi nhầm `11202052` → lấy theo vị trí (index 5) làm `ContraAccount`. Hàm `getter(header)(row, name, fallbackPos)` ưu tiên tên cột, không có thì dùng vị trí.
- Cột `AddDate/ModifiedDate` trong sheet bị lỗi định dạng (`58:49.8`) → bỏ qua.
- `parseMasterTexts` parse cả 6 bảng trước, bảng nào rỗng thì throw → không ghi DB.

### 5.3 Company & GatewayCompanyMapping
Mặc định (`DEFAULT_COMPANIES`, `DEFAULT_GATEWAY_MAPPINGS`):
- Company `ZENIROXPAY` (USD), `ONTARIO` (USD).
- `ZeniroxPay Inc.` → `ZENIROXPAY`, `ZeniroxPay - Stripe` → `ZENIROXPAY` (user đã chốt: company = cổng thanh toán; cả 2 gateway cùng 1 công ty).

### 5.4 `MasterIndex` (`src/lib/engine/masters.ts`)
Tạo từ `Masters` (8 mảng). So khớp **trim + UPPERCASE**.

| Method | Mô tả |
|---|---|
| `journalType(dataSource, journalTypeCode)` | Tra theo `DataSource|JournalTypeCode` |
| `activeRules(jtc)` | Rule `IsActive=1`, sort `RuleSeq` |
| `rule(jtc, ruleSeq)` | Rule active theo seq |
| `partnersByCodeOf(code)` / `partnersByTaxIdOf(taxId)` | Chỉ partner `IsActive=1` |
| `company(comCode)` | Company active |
| `comCodeOfGateway(name)` | Mapping active → ComCode (uppercase) |
| `hasAccount(code)` | Có trong CoA; **trả true nếu CoA rỗng** |

Hàm rời: `parsePartnerRule("Fixed = Individuals")` → `{mode:"FIXED", code:"INDIVIDUALS"}`, `"From Source"` → `FROM_SOURCE`, khác → `NONE`. `accountFromSource(source, accounts)` map `BANK_ACCOUNT/CONTRA_ACCOUNT/TRANS_ACCOUNT/FEE_ACCOUNT` → `BankGLAccount/ContraAccount/TransAccount/FeeAccount`.

`loadMasterIndex(db)` (`services/common.ts`) load lại toàn bộ master **mỗi lần gọi service** (không cache) → sửa master có hiệu lực ngay lần Build/Post sau.

### 5.5 Dữ liệu lạ trong sheet cần biết
- `JournalLineRule.FixedPartner = "BANk"` (6 rule BANK_*): code uppercase thành `BANK`, nhưng Partners không có `BANK` → dòng GL sẽ có PartnerCode `BANK`, PartnerTaxID null (chưa ảnh hưởng Orders).
- `JournalType.Partner` có `"Fixed = PayPal"` lẫn `"Fixed = PAYPAL"` → xử lý bằng uppercase.
- 1 email seller có thể có nhiều store (VD `bettamax001@gmail.com` có 8 partner).

---

## 6. Tính năng chi tiết

### 6.1 Import orders

- **Mục đích:** đưa file order thô vào `RawOrders`, truy vết theo `ImportBatch`.
- **UI:** `/raw/orders` – `Upload.Dragger` (customRequest gửi FormData), nút "Import file order mẫu", modal kết quả, tab Raw orders (lọc search/ComCode/ItemStatus/BuildStatus, phân trang server), tab Lịch sử import (mở rộng xem `ErrorDetails`).
- **API:** `POST /api/orders/import` (multipart field `file`), `POST /api/orders/import-sample` (đọc `data/samples/orders-sample.csv`).
- **Service:** `importOrders(buffer, fileName)` – `src/lib/services/import-orders.ts`.

**Xử lý:**
1. `readTable` (`src/lib/io/read-table.ts`): `.csv/.txt` → papaparse (header, bỏ dòng trống, bỏ BOM); `.xlsx` → exceljs, chọn sheet đầu tiên có header `OrderId` (không có thì sheet đầu), header ở dòng 1, bỏ dòng rỗng; giá trị ô: hyperlink → text, richText → nối text, formula → result, Date giữ nguyên. Đuôi khác → `BadRequestError`.
2. `canonicalHeaders` (`src/lib/orders/normalize.ts`): map header không phân biệt hoa thường/khoảng trắng về 46 tên chuẩn. Thiếu cột bắt buộc (`REQUIRED_ORDER_COLUMNS`: OrderId, ItemCode, ItemStatus, Quantity, UnitPrice, PaymentGatewayName) → tạo ImportBatch `FAILED`, không ghi dòng nào.
3. `normalizeOrderRow`: cột `number` → `parseNumber`; `date` → `parseDate` (không parse được thì giữ text); `datetime` → `parseDateTime`; `text` → `toText`. Lỗi dòng: thiếu OrderId/ItemCode; `FulfilledAt` có giá trị nhưng không parse được. `RowHash = sha256(dòng đã chuẩn hóa)`.
4. Trong 1 transaction, theo `ItemCode`:
   - Trùng trong cùng file → lỗi dòng.
   - Chưa có → insert, `ComCode = comCodeOfGateway(PaymentGatewayName)`, `BuildStatus = NOT_BUILT`.
   - Có rồi, `RowHash` giống → **bỏ qua** (SkippedRows).
   - Có rồi, khác, `BuildStatus = BUILT` → **lỗi** "Unbuild trước khi import lại".
   - Có rồi, khác, chưa BUILT nhưng **ItemCode còn nằm trong AccountingEvent bất kỳ** (VD gateway bị gỡ mapping rồi Build → raw thành ERROR nhưng event POSTED được giữ; sau đó Unpost thì event thành NEW) → **lỗi**, message nêu event, ComCode, kỳ:
     - event POSTED: "Dòng đã ghi sổ (event …, POSTED) … → Unpost + Unbuild ComCode X kỳ P trước khi import lại";
     - event chưa post: "Dòng còn nằm trong AccountingEvent chưa post (…) … → Unbuild ComCode X kỳ P trước khi import lại".
     Event cũ chưa có `ItemCodes` thì coi là chứa item nếu cùng OrderId + ngày giao; message gợi ý Build lại trước (Build bổ sung `ItemCodes` cho event POSTED không đổi, §6.2) rồi import lại. Chặn đường đổi FulfilledAt/gateway trong khi event cũ còn ở khóa cũ → Build lại + Post sẽ ghi sổ trùng. Dòng `ERROR`/`SKIPPED` bình thường không có event nên không bị ảnh hưởng.
   - Có rồi, khác, chưa BUILT, item không nằm trong event nào → **update** (gán ImportBatchID mới, reset NOT_BUILT).
5. Response `ImportOrdersResult` (errors tối đa 200); `ImportBatch.ErrorDetails` lưu tối đa 500.

**Parse số – `parseNumber` (`src/lib/engine/parse.ts`):** bỏ ký tự ngoài `0-9 , . -`; `(x)` = âm; có cả `,` và `.` → ký tự xuất hiện sau cùng là dấu thập phân; **chỉ 1 dấu phẩy → coi là thập phân** (`"8,35"`→8.35, `"1,439"`→1.439); nhiều dấu phẩy → phân cách nghìn; nhiều dấu chấm → phân cách nghìn.

**Parse ngày – `parseDate` / `parseDateTime`:**
- `Date` từ exceljs → đọc bằng UTC getters (exceljs lưu giờ "tường" dạng UTC). Số → serial Excel.
- Chuỗi → dayjs **strict** với danh sách `DATE_FORMATS` (`parse.ts`): `M/D/YYYY`, `M/D/YYYY H:mm:ss`, `M/D/YYYY H:mm`, `M-D-YYYY`, `M-D-YYYY H:mm:ss`, `M-D-YYYY H:mm`, `YYYY-MM-DD`, `YYYY-MM-DD HH:mm:ss`, `YYYY-MM-DDTHH:mm:ss`, `YYYY/MM/DD`. **Không có format ngày-trước-tháng** → `"20/11/2025"` trả null (với `FulfilledAt` là lỗi dòng; cột ngày khác giữ nguyên text).
- Không khớp strict nhưng chuỗi có 4 chữ số liền → fallback `dayjs(s)` lỏng (nhận `"Nov 20 2025"`, ISO có `Z`...). ISO có `Z` bị đổi sang **giờ máy chủ** → có thể lệch sang ngày khác.
- Ô chỉ có giờ trong xlsx (Date năm 1899): cột kiểu `text` (`LastUpdatedTimeAt`, `PaidTimeAt`) qua `toText`/`formatDateTime` → `HH:mm:ss`; nếu rơi vào cột kiểu `date` thì `parseDate` cho `1899-12-30`.

**Test:** `tests/engine/parse.test.ts` (CSV và XLSX mẫu cho kết quả giống nhau), `tests/integration/flow.test.ts`.

### 6.2 Build Orders

- **Mục đích:** RawOrders → AccountingEvent (tài liệu gốc §7.3).
- **UI:** `/events` – `ScopeBar` (ComCode + khoảng kỳ), nút Build Orders (modal `BuildSummary`), Unbuild, Unpost + Unbuild, Export Excel, bảng tổng hợp theo JTC × PostStatus, bảng event + Drawer chi tiết (rule áp dụng, raw order nguồn, dòng GL).
- **API:** `POST /api/build` body `{comCode?, periodFrom?, periodTo?}`.
- **Service:** `runBuildOrders(scope)` – `src/lib/services/build.ts`.
- **Engine:** `buildOrderEvents(rows, index)` – `src/lib/engine/build-orders.ts`.

**Engine – từng bước:**
1. `ComCode = index.comCodeOfGateway(PaymentGatewayName)`.
2. Nếu `ItemStatus` (uppercase) ≠ `FULFILLED` hoặc thiếu `FulfilledAt` → raw `SKIPPED`, exception `NOT_FULFILLED` (INFO, SourceKey = ItemCode).
3. Không có ComCode → raw `ERROR`, `MISSING_COMCODE`. Không có Company → raw `ERROR`, `MISSING_COMPANY`.
4. `PostingDate = FulfilledAt`, `Period = YYYYMM`. Gom theo **`ComCode|OrderId|PostingDate`**, cộng bằng Decimal:

   | AmountSource | Công thức |
   |---|---|
   | `PRODUCT` | Σ Quantity × UnitPrice |
   | `SHIPADD` | Σ ShippingFee + AdditionalCost |
   | `TAX` | Σ TaxFee |
   | `SELLER_PROFIT` (hoặc `PROFIT`) | Σ Profit |

   Seller (`SellerEmail`, `TaxID`, `StoreName`) lấy từ dòng đầu tiên của group.
5. Với từng `JournalTypeCode` trong `ORDER_JOURNAL_TYPE_CODES` = [`ORD_REV_PRODUCT_FULFILLED`, `ORD_REV_SHIPADD_FULFILLED`, `ORD_REV_TAX_FULFILLED`, `ORD_SELLER_PROFIT_FULFILLED`]:
   - Không có JournalType (DataSource `ORDERS`) → `MISSING_JOURNAL_TYPE`. Không có rule active → `MISSING_RULE`. Hai lỗi cấu hình này và `UNKNOWN_AMOUNT_SOURCE` chỉ ghi **1 lần/build**, với `ComCode`/`Period` = null (nên filter ComCode ở trang Exceptions sẽ ẩn chúng).
   - Mỗi rule active → amount theo `rule.AmountSource` (không nhận ra → `UNKNOWN_AMOUNT_SOURCE`), làm tròn 2.
   - `amount = 0` & `SkipIfAmountZero` → không tạo event, exception `AMOUNT_ZERO` (INFO, SourceKey `{TransactionID}|{JTC}`).
   - TK Nợ/Có theo rule trỏ vào TK null trên JournalType mà rule có cờ SkipIf...Null → bỏ rule, `MISSING_ACCOUNT` (WARNING). **Không có cờ Skip** → event vẫn được tạo và sẽ lỗi `MISSING_ACCOUNT` (ERROR) khi Post.
   - Partner theo `JournalType.Partner`: `Fixed = X` → `resolveFixedPartner`; `From Source` → `resolveSeller` (§6.2.1). Seller lỗi → event vẫn tạo với `PostStatus=ERROR`, `ErrorStage=BUILD`, `PartnerCode = SellerEmail`, exception `MISSING_PARTNER`.
   - Sinh `EventDraft`:

   | Cột | Giá trị |
   |---|---|
   | `DataSource` | `ORDERS` |
   | `TransactionID` | `ORD-{OrderId}-{yyyyMMdd}` (`orderTransactionId`) |
   | `SourceID` | `{OrderId}|{yyyyMMdd}` (`orderSourceId`) |
   | `EventSeq` / `LineSeq` | `rule.RuleSeq` / 1 |
   | `PairCode`, `AmountSource` | từ rule |
   | `OrderID`, `RefNum` | OrderId |
   | `InputCurr` / `FncCurr` | `USD` (hằng `ORDER_INPUT_CURRENCY`) / `Company.FunctionalCurrency` |
   | `Amount` | amount signed, **chưa nhân AmountFactor** |
   | `BankGLAccount/ContraAccount/TransAccount/FeeAccount` | **copy từ JournalType tại thời điểm build** |
   | `BankAccountNumber` | null |
   | `Description` | `JournalType.JournalType` (VD "Orders Fulfilled Seller Profit") |
   | `SourceHash` | sha256 {comCode, orderId, postingDate, jtc, ruleSeq, amount toFixed(2), partner, itemCodes sort} |

**Cấu hình với dữ liệu hiện tại** (RuleSeq 20, PairCode `CONTRA_TRANS`, NegativeMode `SIGNED`, tất cả Bulk):

| JournalTypeCode | Nợ | Có | Partner |
|---|---|---|---|
| ORD_REV_PRODUCT_FULFILLED | CONTRA 13122001 | TRANS 51112001 | INDIVIDUALS |
| ORD_REV_SHIPADD_FULFILLED | CONTRA 13122001 | TRANS 51131001 | INDIVIDUALS |
| ORD_REV_TAX_FULFILLED | CONTRA 13122001 | TRANS 33302001 | INDIVIDUALS |
| ORD_SELLER_PROFIT_FULFILLED | TRANS 63202001 | CONTRA 33102001 | Seller |

#### 6.2.1 Resolve seller (`src/lib/engine/resolve-partner.ts`)
1. `TaxID` của order khớp `PartnerTaxID` → lấy partner đầu tiên (`matchedBy: TAX_ID`).
2. Không có `SellerEmail` → lỗi.
3. Ứng viên = partner có `PartnerCode` = email, ưu tiên `PartnerType = Seller` (không có Seller thì lấy tất cả).
4. 0 ứng viên → lỗi "Không tìm thấy seller". 1 → `EMAIL`.
5. Nhiều → lọc `PartnerName` ∈ {`FFT-{Store}`, `FFT-FFT {Store}`, `{Store}`, kết thúc bằng ` {Store}`} (không phân biệt hoa thường). Đúng 1 → `EMAIL_STORE`; còn lại → lỗi "có N store, không xác định được store".

`resolveFixedPartner(index, code)`: có trong Partners → lấy `PartnerCode/TaxID/Name` của bảng; không có → `{PartnerCode: code, TaxID: null, Name: null}`.

**Service – ghi DB (`runBuildOrders`):**
1. Tạo `BuildBatch` RUNNING (ngoài transaction để giữ lại khi lỗi).
2. Load raw theo kỳ bằng SQL trên `FulfilledAt` (`periodRows`; lọc kỳ **bỏ qua dòng không có FulfilledAt**). Có ComCode → engine `orderRowsInScope` chọn **trọn đơn** (OrderId + ngày giao = SourceID): mọi dòng đang map vào ComCode đó + mọi dòng khác của SourceID có dòng map vào ComCode đó hoặc đang có event của ComCode đó trong kỳ (mapping đã đổi đi). Vì vậy Build theo ComCode cũng xử lý phần của ComCode khác trong đơn nhiều cổng, và Build theo ComCode cũ vẫn dọn được event của đơn đã chuyển công ty. Không chọn ComCode → mọi dòng trong kỳ.
3. Gọi engine `buildOrderEvents(rows)`. Draft có `ItemCodes` = JSON các ItemCode của nhóm.
4. Transaction:
   - Load mọi event (mọi ComCode, mọi PostStatus) của các `OrderID` đang build **và** các đơn có event trong phạm vi build mà không còn dòng nào được build (dòng đã đổi ngày giao sang kỳ khác / đổi OrderId). Chia theo `SourceID`:
     - thuộc các dòng đang build → `existing` (thay thế / xóa / cảnh báo);
     - **SourceID đã chết** – không còn dòng raw nào (mọi kỳ, mọi ComCode) có SourceID đó → cũng vào `existing`: chưa post thì bị xóa, POSTED thì cảnh báo và dùng để chặn draft trùng item; thêm `{TransactionID}|{JTC}` của chúng vào tập khóa exception cần làm mới;
     - còn dòng raw nhưng ngoài phạm vi build → chỉ lấy event **POSTED** (`relatedPosted`, để đối chiếu).
   - Engine `reconcileEvents` (`src/lib/engine/reconcile-events.ts`) lập kế hoạch, service chỉ thực thi:
     - Draft chưa có khóa → insert (`EventsCreated`).
     - Đã có & `POSTED` → giữ nguyên (`EventsUnchangedPosted`); nếu `SourceHash` khác → `POSTED_SOURCE_CHANGED` (WARNING).
     - Đã có & chưa POSTED → update toàn bộ, xóa thông tin post (`EventsReplaced`; **build lại luôn replace kể cả không đổi**).
     - **Chống ghi sổ trùng theo item:** khóa event (`ComCode|DataSource|JTC|TransactionID|EventSeq`) đổi sau khi post (đổi `GatewayCompanyMapping`, đổi `RuleSeq`/cách viết JTC, đổi ngày giao) thì draft mới không trùng khóa event POSTED cũ. Draft chưa POSTED bị **chặn** khi có event POSTED **cùng OrderID** (mọi ngày giao, kể cả khi cả 2 ngày giao cùng nằm trong lần build), khác khóa, cùng DataSource, **có ItemCode trùng** với draft, và: khác SourceID (item đã ghi sổ ở ngày giao khác); hoặc khác ComCode (item đã ghi sổ ở công ty khác — kể cả chỉ 1 phần đơn đổi công ty, kể cả khác JTC); hoặc cùng ComCode + cùng JTC và event POSTED đó không còn được sinh ra (đổi RuleSeq). Draft bị chặn vẫn được ghi nhưng `PostStatus = ERROR`, `ErrorStage = BUILD` (Post không lấy) + exception `POSTED_KEY_CHANGED` (ERROR) nêu event/DocNum cũ, phần khóa đổi, ComCode + kỳ cần Unpost, kỳ/ComCode mới cần Build/Post thêm (`EventsBlocked`). Sau khi Unpost, event cũ thành NEW và không còn sinh ra (khóa cũ không còn dòng nguồn) nên Build xóa nó → hết chặn, không ghi sổ trùng. Event NEW trùng lỡ tạo từ trước cũng chuyển ERROR. Không chặn: thêm rule mới khi rule đã post vẫn sinh ra; item mới của công ty khác trong đơn nhiều cổng (ItemCode không trùng). Event POSTED cũ chưa có `ItemCodes` (tạo trước migration `0001`): nếu có draft cùng khóa và cùng `SourceHash` (hash đã gồm danh sách item) → ghi bổ sung `ItemCodes` (`healItemCodes`, không đổi `ModifiedDate`), từ đó xử lý như event mới; còn lại coi là trùng item khi cùng SourceID mà đã đổi (không còn sinh ra hoặc SourceHash khác), hoặc SourceID của nó đã chết — thận trọng, có thể chặn thừa, message ghi rõ "tạo trước khi có cột ItemCodes".
     - Event POSTED không còn được sinh ra và không bị draft nào thay chỗ (số tiền về 0, rule tắt, gateway/Company mất mapping, dòng đổi ngày giao sang kỳ ngoài phạm vi build) → giữ nguyên + `POSTED_SOURCE_CHANGED` (WARNING).
     - Event cũ chưa POSTED không còn được sinh ra (kể cả của SourceID đã chết) → **xóa** (`EventsRemoved`).
   - Cập nhật `RawOrders.BuildStatus/BuildMessage/ComCode` cho mọi dòng đã xử lý.
   - Xóa exception BUILD cũ theo tập SourceKey có thể sinh ra từ các dòng đã xử lý (ItemCode, `{TransactionID}|{JTC}` — JTC luôn viết hoa, các JTC, `{JTC}|{RuleSeq}`), rồi insert exception mới. Vì build trọn đơn nên exception của mọi ComCode trong đơn được làm mới cùng lúc.
5. Transaction commit xong mới gán bộ đếm (`EventsCreated/Replaced/Removed/Blocked`; `EventsError` = số event ghi vào DB với PostStatus ERROR) → BuildBatch SUCCESS. Lỗi giữa chừng → rollback, BuildBatch FAILED + ErrorMessage, bộ đếm event giữ 0.

**Test:** `tests/engine/build-orders.test.ts`, `tests/engine/reconcile-events.test.ts`, `tests/integration/gateway-remap.test.ts`, `tests/integration/posted-guards.test.ts`.

### 6.3 Post Single / Bulk

- **Mục đích:** AccountingEvent → GLTrans (tài liệu gốc §9).
- **UI:** `/posting` – Post tất cả (Single rồi Bulk), Post Single, Post Bulk, Unpost theo phạm vi; bảng PostingBatch với "Xem GL" (`/gl?postBatchId=`) và "Unpost batch".
- **API:** `POST /api/post` body `{classify: "Single"|"Bulk"|"All" (mặc định All), comCode?, periodFrom?, periodTo?, dataSource?}` → `PostSummary[]`.
- **Service:** `runPost(classify, scope)` – `src/lib/services/post.ts`.
- **Engine:** `src/lib/engine/post.ts`.

**Service:**
1. Candidate = event trong scope có `PostStatus = NEW` **hoặc** (`ERROR` và `ErrorStage = POST`), rồi lọc `classifyOf(index, e) === classify` (Classify lấy từ JournalType theo DataSource+JTC; **JournalType không có Classify thì event không bao giờ được post**).
2. Không có candidate → trả `Status: NOTHING_TO_POST`, không tạo batch.
3. Tạo `PostingBatch` RUNNING (`ComCodeList` = scope hoặc danh sách ComCode của event; `PeriodFrom/To` = scope hoặc min/max).
4. **Chốt chặn ghi sổ trùng** – engine `findDuplicateItems` (`src/lib/engine/post-guard.ts`), so candidate với mọi event cùng `OrderID` (mọi PostStatus, kể cả ngoài scope). Một item chỉ thuộc 1 ngày giao và 1 công ty, nên candidate bị giữ lại (thành `ERROR`/`POST` + exception `DUPLICATE_ITEM`, tính vào `ErrorEvents`) khi:
   - có item trùng với event **POSTED** khác SourceID hoặc khác ComCode;
   - có item trùng với event khác **cũng đang chờ post** (NEW, ERROR/POST) khác SourceID hoặc khác ComCode → giữ cả hai;
   - là event Orders chưa có `ItemCodes` (tạo trước migration `0001`) → phải Build lại trước.
   Cùng SourceID + ComCode (nhiều JTC/rule của cùng đơn) là bình thường; event `ERROR/BUILD` (đã bị chặn) và `SKIPPED` không tính. Bình thường Build đã chặn/dọn hết nên bước này không giữ event nào; nó bảo vệ khi dữ liệu lệch mà chưa Build lại (dữ liệu từ phiên bản cũ, Post trước khi Build, sửa DB tay). Xử lý: Build lại phạm vi gồm cả event kia rồi Post.
5. `postEvents(candidates còn lại, classify, index)`.
6. Transaction: insert GLTrans (chunk 200, gán `PostBatchID`, `AddDate`); update event POSTED theo từng DocNum; event lỗi → `ERROR`/`POST` + ErrorMessage; event bỏ qua → `SKIPPED`/`POST`; xóa exception POST cũ theo key `EventID {id} | {TransactionID}` của mọi candidate rồi insert mới; batch → SUCCESS (+ InsertedRows, PostedEvents, ErrorEvents, SkippedEvents).
7. Exception bất ngờ (VD chứng từ không cân) → rollback, batch FAILED.

**Engine – `expandEvent(event, index)`** (1 event → [dòng Nợ, dòng Có]), theo thứ tự kiểm tra:
1. `rule = index.rule(JTC, EventSeq)`; không có → lỗi `MISSING_RULE`.
2. `dr = accountFromSource(rule.NormalDrAccountSource, event)`, `cr` tương tự (**dùng cột TK trên event**, tức giá trị copy lúc build). Null → bỏ qua nếu có cờ `SkipIfDr/CrAccountNull`, ngược lại lỗi `MISSING_ACCOUNT`.
3. TK không có trong CoA → lỗi `ACCOUNT_NOT_IN_COA`.
4. `amount = Event.Amount × rule.AmountFactor` (round 2). `0` & `SkipIfAmountZero` → bỏ qua `AMOUNT_ZERO`.
5. `NegativeMode = rule.NegativeMode ?? (ReverseIfNegative ? "REVERSE" : "SIGNED")` (giá trị lạ ngoài REVERSE/ERROR được xử lý như SIGNED). Amount âm:
   - `SIGNED`: giữ dấu âm ở cả 2 vế.
   - `REVERSE`: đổi chỗ TK Nợ/Có, lấy trị tuyệt đối.
   - `ERROR`: lỗi `NEGATIVE_AMOUNT`.
6. Partner dòng: `PartnerMode = FIXED` & có `FixedPartner` → `resolveFixedPartner(UPPER(FixedPartner))`; ngược lại partner header của event. Gắn vào dòng Nợ/Có nếu `ApplyPartnerToDrLine/CrLine = 1`, không thì null.
7. `resolveFx(exrates, {period, fncCurr, inputCurr})` (`src/lib/engine/resolve-fx.ts`): cùng tiền → `XRate=1, MUL`; khác → Exrate `IsActive`, `Period` = kỳ event, `ReportCurrency` = FncCurr, `TransCurrency` = InputCurr, `Exrate > 0`, lấy `ExrateDate` mới nhất; không có → lỗi `MISSING_FX`. `RateType` = `DIV` thì chia, **mọi giá trị khác coi là MUL**. `applyFx` round 2.
8. `memo = rule.MemoTemplate ?? event.Description ?? JTC`.

**Single** – mỗi event 1 chứng từ:
- `DocNum = ASI-{yyyyMMdd PostingDate}-{AccountingEventID}` (`singleDocNum`), `PostingGroupKey = null`.
- `ReferenceTxnID = TransactionID`, `OrderID`, `RefNum` từ event, `BankAccountNumber` từ event.
- `Description = {memo} | {TransactionID}`.

**Bulk** – gom nhiều event:
- `PostingGroupKey = ComCode|JournalTypeCode|yyyyMMdd|InputCurr|FncCurr|UPPER(PartnerCode)|PartnerTaxID|BankAccountNumber` (`postingGroupKey`; phần null thành rỗng, VD `ZENIROXPAY|ORD_SELLER_PROFIT_FULFILLED|20251120|USD|USD|CONG2672000@GMAIL.COM|VA4ZH4IIFMUTCFCXF1GY|`). Partner ở đây là **partner header của event**.
- Trong group, cộng dòng theo khóa `PairCode|BalanceImpact|AccountCode|PartnerCode|PartnerTaxID|XRate|RateType` (Input cộng Input; Accounted cộng các Accounted đã round từng event).
- `DocNum = ASB-{yyyyMMdd}-{AccountingEventID nhỏ nhất trong group}` (`bulkDocNum`).
- Header dòng lấy từ event đầu tiên của group; `ReferenceTxnID/OrderID/RefNum = null`; `Description = {memo} | {số event} events`.
- Chỉ gom **các candidate của lần post hiện tại**: event được post bổ sung sau (VD retry lỗi) sẽ ra chứng từ `ASB-…` **mới** dù trùng `PostingGroupKey` với chứng từ đã có.

**Chung:** dòng Nợ có `InputCr = AccountedCr = 0`, `BalanceImpact = Debit`; dòng Có ngược lại. `IsReversal/ReverseID/IsReval/Segment = null`. `assertBalanced` kiểm tra Σ AccountedDr = Σ AccountedCr theo từng DocNum, sai thì throw.

**Test:** `tests/engine/post-guard.test.ts`, `tests/integration/posted-guards.test.ts` (mục 6); `tests/engine/post.test.ts` (Bulk trên dữ liệu mẫu; Single/REVERSE/SIGNED/ERROR/FX DIV/MISSING_FX/FIXED partner với JournalType giả `TEST_JT`).

### 6.4 Unpost / Unbuild / Unpost + Unbuild / Reset

`src/lib/services/clear.ts`. `unpost` và `unbuild` nhận `preview` → chỉ đếm, không sửa. `resetTransactionalData` không có preview (xóa ngay).

**`unpost({scope, postBatchId, preview})`** – `POST /api/unpost`
1. Tìm event `POSTED` trong scope (và `PostBatchID` nếu có) → tập `PostedDocNum`.
2. Mở rộng ra **toàn bộ chứng từ**: đếm mọi event POSTED có DocNum đó, dòng GL có DocNum đó, danh sách PostBatchID liên quan → `UnpostResult {events, glLines, documents, batches}`.
3. Chạy thật (transaction): xóa GLTrans theo DocNum; event → `NEW`, xóa `PostedDocNum/PostingGroupKey/PostBatchID/PostedAt/ErrorStage/ErrorMessage`; batch nào không còn dòng GL → `UNPOSTED`.
- Event `SKIPPED` hoặc `ERROR/POST` **không bị reset** bởi unpost.

**`unbuild({scope, includePosted, preview})`** – `POST /api/unbuild`
1. `includePosted = true` → chạy `unpost(scope)` trước (preview thì chỉ mô phỏng). Chạy thật: Unpost và các bước dưới nằm trong **1 transaction** (transaction con thành savepoint) → lỗi giữa chừng rollback cả phần Unpost, không để sổ bị gỡ mà event chưa xóa. Điều kiện lọc raw dùng subquery trên `AccountingEvent` (không truyền danh sách OrderId làm tham số) nên không vướng giới hạn 32,766 biến SQL của SQLite ở dữ liệu lớn.
2. Xóa event trong scope có `PostStatus ≠ POSTED` (`deletedEvents`); `postedEventsKept` = số event POSTED còn lại.
3. Raw về `NOT_BUILT` (BuildMessage null) nếu:
   - `BuildStatus ≠ NOT_BUILT`;
   - có scope ComCode: `RawOrders.ComCode` (giá trị đã lưu, không phải mapping hiện tại) = scope **hoặc null**, **hoặc** ItemCode nằm trong event bị xóa ở lần này (ComCode event khác raw khi mapping đã đổi);
   - kỳ `FulfilledAt` trong scope;
   - ItemCode **không** còn nằm trong event nào không bị xóa ở lần này (event POSTED, event của ComCode/kỳ khác). Event cũ chưa có `ItemCodes` → giữ BUILT cả đơn.
   Nhờ vậy dòng có item còn trong event (VD Unbuild ComCode mới sau khi đổi mapping, event chưa post của ComCode cũ vẫn còn) vẫn `BUILT`, import không thay được dòng đó.
4. Xóa `ExceptionLog` BatchType BUILD khớp `ComCode = scope` / `Period` trong scope (không scope → xóa hết BUILD). Có scope thì exception có ComCode/Period null (VD `MISSING_COMCODE`, lỗi cấu hình) **không bị xóa**; exception POST của event bị xóa **không bị dọn** (mồ côi).

**Unbuild nguồn ngoài Orders:** khi `scope.dataSource` là `PAYPAL`/`STRIPE`/`PIPO`/`ACCOUNTINGSOURCE`, `unbuild` đi nhánh riêng (`unbuildBankSource`) vì các nguồn này không dùng `ItemCodes`: xóa event chưa POSTED trong scope → reset `BuildStatus` của đúng bảng raw đó theo cùng phạm vi → xóa exception BUILD theo `DataSource` (+ ComCode). Không đụng tới Orders hay các nguồn khác.

**`resetTransactionalData()`** – `POST /api/reset`: xóa `GLTrans, AccountingEvent, PostingBatch, BuildBatch, ExceptionLog, RawOrders, RawPaypal, RawStripe, RawPipo, RawAccountingSource, ImportBatch` + reset `sqlite_sequence` (ID bắt đầu lại từ 1). Master giữ nguyên.

**UI:** trang `/events` và `/posting` gọi API với `preview: true` trước, hiển thị `modal.confirm` kèm số lượng, bấm OK mới chạy thật.

**Test:** `tests/integration/flow.test.ts`.

### 6.5 Run Accounting Cycle
`POST /api/cycle` (body scope) → `runBuildOrders(scope)`; nếu build SUCCESS → `runPost("All", scope)`. Response `{build, post}`. Nút "Chạy full cycle" trên Dashboard.

### 6.6 GLTrans inquiry & Export

- **UI:** `/gl` (`src/app/gl/page.tsx`, bọc `Suspense` vì dùng `useSearchParams`; hỗ trợ `?postBatchId=`). Filter: ScopeBar, JournalTypeCode, PostBatchID, Nợ/Có, AccountCode (bắt đầu bằng), DocNum (chứa), Partner/TaxID (chứa). 6 thẻ thống kê (dòng, chứng từ, Σ InputDr/Cr, Σ AccountedDr/Cr + tag Cân/Lệch). Tab "Chi tiết GLTrans" (33 cột, tooltip từ `GL_FIELD_DOCS`, click dòng → Drawer chứng từ: dòng GL, event tạo nên, raw order gốc). Tab "Tổng hợp theo tài khoản". Collapse "Giải nghĩa các cột GLTrans". Nút Export Excel là link `href` tới API (tải trực tiếp).
- **API:** `GET /api/gl`, `GET /api/gl/summary`, `GET /api/gl/doc?docNum=`, `GET /api/gl/export`. Filter chung parse bởi `glFilterFrom` (`src/lib/gl-filter.ts`).
- **Service:** `listGl` (rows phân trang + totals), `allGl`, `glAccountSummary` (group AccountCode, join CoA), `glDocumentDetail` (lines + events theo `PostedDocNum` + raw theo OrderID, tối đa 500 order) – `src/lib/services/queries.ts`. Sắp xếp `TransDate, ID`.
- **Export:** `glWorkbook(rows)` – `src/lib/services/export.ts`: sheet `GlTrans`, cột theo `GL_EXPORT_COLUMNS` (`src/lib/gl-columns.ts`, đúng thứ tự sheet mẫu), tiền `#,##0.00`, ngày dạng date, freeze header, autofilter, dòng cuối "TỔNG". Tên file `GLTrans_{yyyyMMddHHmmss}.xlsx` (thời điểm theo giờ UTC).

### 6.7 AccountingEvent review & Export
- **API:** `GET /api/events` (rows + total + summary theo JTC × PostStatus), `GET /api/events/[id]` (`{event, orders, rule, journalType, glLines}`), `GET /api/events/export` (sheet `AccountingEvent`, cột `EVENT_EXPORT_COLUMNS`).
- **Service:** `listEvents`, `allEvents`, `eventDetail`. Search khớp `TransactionID/OrderID/PartnerCode/PartnerName/PostedDocNum`.
- Drawer hiện rule sẽ áp dụng khi Post (Nợ/Có = source → TK), raw order (`OrderId` + `FulfilledAt = PostingDate`), chứng từ GL nếu đã post.

### 6.8 Exceptions

- **UI:** `/exceptions` – bảng tổng hợp (click để lọc), filter Bước/Mức/Type/ComCode/search, bảng chi tiết. Mô tả cách xử lý nằm trong hằng `TYPE_DOCS` của `src/app/exceptions/page.tsx` (**đang thiếu `UNKNOWN_AMOUNT_SOURCE`**).
- **API:** `GET /api/exceptions` → `{rows, total, byType}`; `byType` luôn tổng hợp **toàn bảng**, không theo filter.
- **Kiểu:** `ExceptionType` trong `src/lib/engine/types.ts`.
- SourceKey của **mọi exception bước POST** có dạng `EventID {AccountingEventID} | {TransactionID}` (ghi tắt "EventID" trong bảng dưới).

| ExceptionType | Bước | Severity | SourceKey | Ý nghĩa / xử lý |
|---|---|---|---|---|
| `NOT_FULFILLED` | BUILD | INFO | ItemCode | Chưa fulfill → bình thường |
| `MISSING_COMCODE` | BUILD | ERROR | ItemCode | Gateway chưa map → thêm GatewayCompanyMapping, build lại |
| `MISSING_COMPANY` | BUILD | ERROR | ItemCode | ComCode chưa có trong Company |
| `MISSING_JOURNAL_TYPE` | BUILD | ERROR | JTC | Thiếu JournalType ORDERS (1 lần/build, ComCode null) |
| `MISSING_RULE` | BUILD / POST | ERROR | JTC / EventID | Thiếu JournalLineRule active |
| `UNKNOWN_AMOUNT_SOURCE` | BUILD | ERROR | `{JTC}\|{RuleSeq}` | AmountSource không áp dụng cho Orders (1 lần/build) |
| `AMOUNT_ZERO` | BUILD / POST | INFO | `{TxnID}\|{JTC}` / EventID | Số tiền 0 → bỏ qua, bình thường |
| `MISSING_PARTNER` | BUILD | ERROR | `{TxnID}\|{JTC}` | Seller không map được (§6.2.1) |
| `MISSING_ACCOUNT` | BUILD (WARNING, bỏ rule) / POST (INFO nếu có cờ Skip, ngược lại ERROR) | | `{TxnID}\|{JTC}` / EventID | Rule trỏ tới TK null |
| `ACCOUNT_NOT_IN_COA` | POST | ERROR | EventID | TK không có trong CoA |
| `NEGATIVE_AMOUNT` | POST | ERROR | EventID | Âm với NegativeMode ERROR |
| `MISSING_FX` | POST | ERROR | EventID | Thiếu tỷ giá kỳ/đồng tiền |
| `POSTED_SOURCE_CHANGED` | BUILD | WARNING | `{TxnID}\|{JTC}` | Event đã post nhưng nguồn/cấu hình đổi (`SourceHash` khác), hoặc lần Build này không còn sinh ra event đó (số tiền về 0, rule tắt, gateway bị gỡ mapping, đổi ngày giao) → Unpost, Build, Post lại |
| `POSTED_KEY_CHANGED` | BUILD | ERROR | `{TxnID}\|{JTC}` | Item của event đã POSTED dưới khóa khác (đổi GatewayCompanyMapping sang ComCode khác — cả khi chỉ 1 cổng của đơn nhiều cổng đổi, đổi RuleSeq, đổi ngày giao) → event mới bị ghi ERROR/BUILD để không ghi sổ trùng (§6.2). Unpost theo ComCode + kỳ cũ nêu trong message → Build (toàn bộ, hoặc phạm vi gồm cả kỳ/ComCode mới nếu message ghi) → Post cả ComCode cũ và mới. Build xóa event cũ đã Unpost vì khóa cũ không còn sinh ra |
| `DUPLICATE_ITEM` | POST | ERROR | EventID | Chốt chặn lúc Post (§6.3): item của event đã POSTED hoặc đang chờ post ở event khác ngày giao / khác ComCode, hoặc event Orders chưa có `ItemCodes` → không post. Build lại (phạm vi gồm cả event kia) rồi Post |
| `INVALID_FULFILLED_DATE` | — | — | — | **Khai báo nhưng chưa dùng** (import đang từ chối dòng thay vì ghi exception) |

- Chống nhân đôi: Build xóa exception BUILD cũ theo tập SourceKey mà lần build đó có thể sinh ra (gồm `{TxnID}|{JTC}` của event có SourceID đã chết); Post xóa exception POST cũ của **các candidate lần post đó**. Exception POST của event đã bị xóa (rebuild bỏ event stale, Unbuild) có thể còn sót lại.
- Với dữ liệu mẫu, build sinh 70 exception INFO (4 NOT_FULFILLED + 66 AMOUNT_ZERO).

### 6.9 Master data page

- **UI:** `/master` – nút "Sync từ Google Sheet" (Popconfirm); Tabs (`destroyOnHidden`): GatewayCompanyMapping (thêm/sửa/xóa, Modal + Form `initialValues`, `preserve={false}`, ComCode dùng `AutoComplete`), Company (thêm/sửa), và 6 tab chỉ xem (Partners phân trang server + search; các bảng khác API trả toàn bộ, phân trang ở client). Sau sync, tab xem được remount bằng `key` có `version`.
- **API:** `GET /api/master/[table]`, `POST /api/master/sync`, `POST|DELETE /api/master/gateway-mapping`, `GET|POST /api/master/company`.
- **Service:** `src/lib/services/master.ts`
  - `syncMastersFromGoogleSheet()`: tải 6 CSV song song (`fetch`, no-store); response lỗi hoặc bắt đầu bằng `<` (trang HTML đăng nhập) → throw; `replaceMasters` (parse hết rồi mới xóa & insert trong 1 transaction); thành công mới ghi đè `data/seed/*.csv`. Không đụng Company/GatewayCompanyMapping.
  - `upsertGatewayMapping`: bắt buộc tên + ComCode (uppercase); trùng `PaymentGatewayName` với bản ghi khác → `BadRequestError`; ComCode chưa có trong Company → tự tạo Company (FunctionalCurrency USD).
  - `upsertCompany`: insert hoặc update theo ComCode.
- **Đổi `GatewayCompanyMapping` của cổng đã post:** Build lần sau không tạo event NEW cho item đã ghi sổ mà ghi ERROR + `POSTED_KEY_CHANGED` (§6.2), kể cả khi chỉ 1 cổng của đơn nhiều cổng đổi. Quy trình: sửa mapping → Unpost phạm vi ComCode **cũ** + kỳ liên quan (nêu trong message) → Build (không chọn ComCode, hoặc chọn ComCode cũ/mới) → Post cả ComCode cũ và mới. Hoặc Unpost + Unbuild trước rồi mới sửa mapping.
- Sửa master **không tự build lại**; phải bấm Build (thay đổi JournalType TK/Partner/gateway) hoặc Post (thay đổi rule/tỷ giá/CoA) — xem §13.

### 6.10 Dashboard
- **UI:** `/` – Steps 1→4 kèm số liệu, nút Import file order mẫu / Chạy full cycle / Xóa dữ liệu test, 4 thẻ thống kê, Collapse giải thích luồng + công thức + lần chạy gần đây.
- **API:** `GET /api/dashboard` → `dashboardStats()` (raw theo BuildStatus, event theo PostStatus, GL lines/docs/Σ Dr/Σ Cr, exception theo Severity, 5 import/build/post gần nhất).
- `GET /api/options` → `filterOptions()` (`comCodes` từ Company, `journalTypeCodes` + dataSource, `periods` từ event + raw, `postBatches`) – dùng cho Select trên các trang qua `useOptions()`.

---

### 6.11 Build các nguồn ngoài Orders (PayPal / Stripe / PIPO / AccountingSource)

Tài liệu gốc: §7.2 AccountingSource, §7.4 PayPal, §7.5 PIPO, §7.6 Stripe. Dữ liệu thật: `docs/tai-lieu-goc-and-data/Data-khac-order.xlsx` (5 sheet).

**Post không phải sửa gì** — 4 nguồn này chỉ thêm tầng Import + Build.

#### 6.11.1 Bản đồ nguồn → sheet → bảng

| `source` (URL/API) | `DataSource` (trên event) | Sheet | Bảng raw | Dòng thật |
|---|---|---|---|---|
| `paypal` | `PAYPAL` | `Bank_Paypal` | `RawPaypal` | 142.659 |
| `stripe` | `STRIPE` | `Bank_Stripe` | `RawStripe` | 1.413 |
| `pipo` | `PIPO` | `Bank_Pipo` | `RawPipo` | 952 |
| `accounting-source` | `ACCOUNTINGSOURCE` | `Master Card` + `Bank_Royal` | `RawAccountingSource` | 39 + 31 |

`ACCOUNTINGSOURCE` viết liền và viết HOA để khớp `norm("AccountingSource")` khi tra `JournalType`, và để khớp `scopeWhere` (hàm này uppercase `dataSource`).

#### 6.11.2 Khác Orders ở đâu

| | Orders | 4 nguồn này |
|---|---|---|
| Khóa dòng raw | `ItemCode` | `SourceKey` (§6.11.3) |
| ComCode | suy từ `PaymentGatewayName` | lấy thẳng cột `ComCode` trên file |
| JournalType | cố định 4 mã | **cột `JournalType` người dùng điền tay**; trống thì suy từ loại giao dịch gốc |
| Gom nhóm | nhiều dòng raw → 1 event | **1 dòng raw → 1 event cho mỗi rule active** |
| `ItemCodes` / post-guard | có | không (xem §6.11.6) |
| Exception | ghi từng dòng | **gom nhóm + đếm** (§6.11.7) |

#### 6.11.3 SourceKey — khóa định danh dòng

Quy tắc bắt buộc: **không được phụ thuộc các cột người dùng điền tay** (`JournalType`, `PartnerCode`, `StoreName`, các cột tài khoản). Nhờ vậy sửa tay rồi import lại sẽ đổi `RowHash` nhưng giữ nguyên `SourceKey`, nên tầng Import nhận ra đúng dòng cũ và chặn được.

| Nguồn | `SourceKey` | Vì sao |
|---|---|---|
| PayPal | `{Transaction ID}` + `{Date}` + `{Time}` | `Transaction ID` đơn lẻ **có 37 mã trùng** (tối đa 3 lần, kiểu Hold → Cancel Hold dùng chung mã). Bộ 3 là duy nhất trên cả 142.659 dòng |
| Stripe | `id` | duy nhất tuyệt đối |
| PIPO | `TransactionId` | duy nhất tuyệt đối |
| Master Card | `MC` + `{ID Transaction}` | duy nhất tuyệt đối |
| Bank_Royal | `RB` + `{sha256(nhận dạng dòng)}#{lần xuất hiện}` | **`RefNum` trống 31/31 dòng**, và có 1 cặp dòng trùng y hệt (2 lần trả lương 266.25 cùng ngày). Hash chỉ gồm `SheetName, Comcode, BankAccountNumber, Date, Amount, InputCurr, PartnerCode` |

`AccountingEvent.TransactionID` vẫn là **mã giao dịch gốc** (để `ReferenceTxnID` và đuôi `Description` khớp sheet mẫu GLTrans); Bank_Royal không có mã nên dùng luôn `SourceKey`. `SourceID` = `{DataSource}` + `{SourceKey}`.

#### 6.11.4 Engine

- `src/lib/engine/build-bank.ts` — engine chung, chứa toàn bộ quy tắc kế toán.
- `src/lib/engine/sources/{paypal,stripe,pipo,accounting-source}.ts` — `BankSourceSpec`, thuần khai báo: đọc cột nào, lọc dòng nào, số tiền lấy ở đâu.

Trình tự mỗi dòng:

1. **`accept`** — lọc theo điều kiện nguồn. PayPal/Stripe chỉ `Currency = USD`; PIPO chỉ `Status = Success`. Dòng bị loại → `SKIPPED` + exception INFO `SOURCE_ROW_SKIPPED`.
2. **ComCode → Company** — thiếu → `MISSING_COMCODE` / `MISSING_COMPANY`.
3. **PostingDate** — đọc không ra → `INVALID_SOURCE_ROW`.
4. **JournalType** — cột điền tay thắng (`index.journalType(dataSource, code)`); trống thì `index.journalTypeByNativeType(dataSource, nativeType)` so với cột `JournalType.JournalType` của master. Không ra → `MISSING_JOURNAL_TYPE`.
5. **Tài khoản**, đúng thứ tự §7.2 bước 3: **giá trị trên dòng nguồn → MappingBankAccount (`ComCode` + số tài khoản) → mặc định của JournalType**.
6. **Partner** theo `JournalType.Partner`: `Fixed = X` → `resolveFixedPartner`; `From Source` → `resolvePartnerByCode` (tra `Partners.PartnerCode`, 1 email nhiều store thì lọc tiếp bằng `StoreName`). Không tìm thấy → vẫn ghi sổ với mã đó, `PartnerTaxID` trống + cảnh báo `MISSING_PARTNER`.
7. **Mỗi JournalLineRule active → 1 event**, `EventSeq = RuleSeq`, `Amount` theo `AmountSource` (`AMOUNT` / `GROSS` / `FEE` / `NET`) — **giữ nguyên dấu, chưa nhân `AmountFactor`** (Post mới nhân).

`MasterIndex` được bổ sung 2 lookup: `journalTypeByNativeType(dataSource, nativeType)` và `bankMapping(comCode, bankAccountNumber)`. Hàm sau chuẩn hóa **bỏ số 0 đứng đầu** vì `Bank_Royal` ghi `076621019512` còn master ghi `76621019512`.

#### 6.11.5 Riêng từng nguồn

**PayPal (§7.4)**
- `Description` ↔ `JournalType` trong file là **1:1 tuyệt đối** (22 loại) nên fallback luôn ra đúng.
- `Fee` mang dấu **âm**; rule pair 3 (`FEE_BANK`) có `AmountFactor = -1` nên đảo lại thành dương.
- `BankAccoutNumber` trống 100% → mặc định `PAYPAL1` (MappingBankAccount → `11202051`).
- `OrderID` = `Invoice ID`, `RefNum` = `Reference Txn ID`.

**Stripe (§7.6)**
- `Currency` trong file là `usd` **chữ thường** → normalizer uppercase; nếu không, bộ lọc USD sẽ loại sạch 100% dòng.
- `Fee` mang dấu **dương** (ngược PayPal), `AmountFactor = 1`.
- Mặc định `Stripe1` → `11202081`.
- Master được bổ sung 2 JournalType: `STRIPE_RECEIPT_CUSTOMER` (khớp mã người dùng điền cho `charge`) và `STRIPE_RESERVE` (`JournalType = reserved_funds`, Contra `11202082`) để 70 dòng `reserved_funds` bỏ trống cột JournalType tự map được.

**PIPO (§7.5)**
- `Amount`, `Fee`, `Net` là **text có đuôi tiền tệ** (`"1.01USD"`, `"100.00USD"`) → `parseNumber` bóc phần số. 868/952 dòng có phí.
- §7.5 bước 5: với `BANK_PAYMENT_%` và `BANK_INTERNAL_TRANSFER_TO`, **số tiền chính = Amount đã trừ phí**. Dữ liệu thật khớp quy ước này: một dòng Send ghi `Amount -101.01 / Fee 1.01USD / Net 100.00USD` — `Amount` đã gồm cả phí, người nhận thực nhận 100.00. Hai bút toán (gốc 100.00 + phí 1.01) cộng lại đúng 101.01 rút khỏi tài khoản.
- Master được bổ sung **10 dòng `DataSource = PIPO`** dùng lại đúng các mã `BANK_*` nhưng `BankAccount = 11202061` (PingPong) thay vì `11202001` (Bank CA). Không có bước này thì `classifyOf` không tìm thấy JournalType và **event sẽ không bao giờ post được**.
- Mặc định `PINGPONG1` → `11202061`. Không dùng `CardNo` (số thẻ/ví, không có trong MappingBankAccount).

**AccountingSource (§7.2)** — 2 sheet nhập tay
- `Bank_Royal` mang sẵn `BankAccount / ContraAccount / TransAccount` **riêng từng dòng** và khác mặc định của master: `BANK_PAYMENT_SUPPLIER` dùng `33402001/64202001` cho lương và `33102002/64202002` cho phí kế toán, trong khi master mặc định `33111002`. Đây chính là tầng "account nhập trên source".
- `Amount` trên cả 2 sheet luôn **dương**; chiều tiền nằm ở `BalanceImpact` và được đổi thành dấu ngay ở bước Import: `Debit` = tiền **ra** → số âm; `Credit` = tiền **vào** → số dương. Rule `NegativeMode = REVERSE` tự đảo Nợ/Có khi post.
- `Master Card` không có cột `ContraAccount`/`BalanceImpact` → Import gán mặc định `ContraAccount = 11202061` (PingPong) và `BalanceImpact = Credit`; giá trị trên dòng (nếu sheet có thêm cột) luôn thắng.
- `Bank_Royal` là **nguồn duy nhất dùng CAD** → đây là chỗ tỷ giá thực sự được dùng.
- Cột `Description` của `Bank_Royal` phần lớn là lỗi công thức `#REF!` → `readTable` trả null.

#### 6.11.6 Chống ghi sổ trùng

1 dòng raw ⇄ 1 bộ event, khóa `SourceKey` ổn định → **không cần `ItemCodes` và post-guard theo item**. Chốt chặn nằm ở tầng Import: `RowHash` đổi + `BuildStatus = BUILT` → báo lỗi *"Unbuild {DataSource} trước khi import lại"*. Vì vậy sửa tay cột `JournalType`/`PartnerCode` sau khi đã Build/Post đều bị chặn ngay khi import.

`runBuildSource` **không truyền `deadSourceIds`** cho `reconcileEvents`: dòng biến mất khỏi file chỉ sinh cảnh báo `POSTED_SOURCE_CHANGED`, không chặn các dòng khác cùng `Invoice ID`.

#### 6.11.7 Exception được gom nhóm

Riêng PayPal, rule pair 2 bị bỏ vì JournalType không khai `TransAccount` đã là ~86.000 dòng. Ghi từng dòng thì màn Exceptions vô dụng và DB phình. Nên `build-bank.ts` gom theo `(ExceptionType, Severity, ComCode, SourceKey)` và thêm `— N dòng (VD: …)` vào message. Chạy toàn bộ workbook thật chỉ ra **95 dòng exception** cho 198k event.

Chi tiết từng dòng vẫn nằm ở `RawXxx.BuildMessage`, xem được trên trang raw của nguồn.

Hệ quả: exception của các nguồn này có `Period = null` → `runBuildSource` xóa exception cũ bằng `deleteExceptionsByDataSource` (theo `DataSource` + ComCode) chứ không theo khóa/kỳ như Orders.

#### 6.11.8 Master data đã bổ sung cho các nguồn này

Phải thêm **cùng nội dung vào Google Sheet**, nếu không lần Sync sau sẽ xóa mất (§13.1).

| File | Thêm |
|---|---|
| `coa.csv` | `11202091 MasterCard - Available (USD)` |
| `journal-type.csv` | `STRIPE_RECEIPT_CUSTOMER`, `STRIPE_RESERVE`, và 10 dòng `DataSource = PIPO` cho các mã `BANK_*` (BankAccount `11202061`) |
| `journal-line-rule.csv` | 2 rule cho `STRIPE_RECEIPT_CUSTOMER` (seq 10 `BANK_CONTRA` AMOUNT, seq 30 `FEE_BANK` FEE), 1 rule cho `STRIPE_RESERVE` |
| `mapping-bank-account.csv` | 2 số thẻ MasterCard → `11202091`; `PINGPONG1` cho ONTARIO và ZENIROXPAY → `11202061` |
| `partners.csv` | 9 mã đối tượng file đang dùng mà Partners chưa có: `Paypal ZeniroxPay`, `Stripe ZeniroxPay`, `Pingpong ZeniroxPay`, `MasterCard ZENIROXPAY`, `ZENIROXPAY`, `RoyalBank`, `Royal Bank`, `OneAccounting`, `BANK` |

`BANK` là để khớp `JournalLineRule.FixedPartner = "BANk"` của 6 rule `BANK_*` (code uppercase thành `BANK`) — trước đây thiếu, xem §5.5.

---

## 7. API reference

Tất cả handler bọc bởi `handle()` (`src/lib/api.ts`): `BadRequestError` → 400 `{error}`; lỗi khác → log + 500 `{error}`.
- **Scope (`parseScope`)** – dùng ở build, post, unpost, unbuild, cycle, events (+export), gl (+summary, export): `comCode` (tự uppercase), `periodFrom`, `periodTo` (**bắt buộc YYYYMM**, sai → 400), `dataSource`.
- `/api/orders` và `/api/exceptions` đọc `comCode/periodFrom/periodTo` bằng `str()` → **không validate, không uppercase** (so khớp chính xác).
- **Phân trang (`paging`)**: `page` (mặc định 1), `pageSize` (mặc định 50; service giới hạn tối đa 5000).
- **Body lỏng:** `jsonBody` biến JSON hỏng thành `{}`; `bool()` chỉ nhận `"1"`/`"true"`/`true`; `int()` giá trị không phải số → null. Hệ quả: body sai gửi tới `/api/unpost` hoặc `/api/unbuild` sẽ chạy thật **trên toàn bộ dữ liệu** (không preview, không lọc batch) – UI luôn gửi đúng nhưng cần cẩn thận khi gọi tay.

| Method | Path | Tham số | Response | Service |
|---|---|---|---|---|
| POST | `/api/orders/import` | multipart `file` | `ImportOrdersResult` | `importOrders` |
| POST | `/api/orders/import-sample` | – | `ImportOrdersResult` | `importOrders` |
| GET | `/api/orders` | page, pageSize, search, comCode, itemStatus, buildStatus, importBatchId, periodFrom, periodTo | `{rows, total}` | `listRawOrders` |
| GET | `/api/import-batches` | – | `ImportBatchRow[]` | `listImportBatches` |
| POST | `/api/sources/[source]/import` | multipart `file`, `sheet?`; `source` ∈ `paypal, stripe, pipo, accounting-source` (khác → 400) | `ImportSourceResult` | `importSourceFile` |
| GET | `/api/sources/[source]` | page, pageSize, search, comCode, buildStatus, journalType, importBatchId, periodFrom, periodTo | `{rows, total, byStatus, journalTypes}` | `listRawSource` |
| POST | `/api/build` | body scope; `dataSource` chọn nguồn (trống = `ORDERS`, sai → 400) | `BuildSummary` | `runBuildOrders` / `runBuildSource` |
| GET | `/api/build-batches` | – | `BuildBatchRow[]` | `listBuildBatches` |
| POST | `/api/post` | body `classify` + scope | `PostSummary[]` | `runPost` |
| POST | `/api/unpost` | body `preview?`, `postBatchId?` + scope | `UnpostResult` | `unpost` |
| POST | `/api/unbuild` | body `preview?`, `includePosted?` + scope | `UnbuildResult` | `unbuild` |
| POST | `/api/cycle` | body scope | `{build, post}` | build + post |
| POST | `/api/reset` | – | `{done}` | `resetTransactionalData` |
| GET | `/api/events` | scope, page, pageSize, journalTypeCode, postStatus, search, postBatchId | `{rows, total, summary}` | `listEvents` |
| GET | `/api/events/[id]` | – | `{event, orders, rule, journalType, glLines}` / 404 | `eventDetail` |
| GET | `/api/events/export` | như `/api/events` (không phân trang) | file .xlsx | `allEvents`, `eventsWorkbook` |
| GET | `/api/posting-batches` | – | `PostingBatchRow[]` | `listPostingBatches` |
| GET | `/api/gl` | scope, journalTypeCode, accountCode, docNum, postBatchId, partner, balanceImpact, page, pageSize | `{rows, total, totals}` | `listGl` |
| GET | `/api/gl/summary` | như `/api/gl` | `AccountSummary[]` | `glAccountSummary` |
| GET | `/api/gl/doc` | `docNum` | `{docNum, lines, events, orders}` | `glDocumentDetail` |
| GET | `/api/gl/export` | như `/api/gl` | file .xlsx | `allGl`, `glWorkbook` |
| GET | `/api/exceptions` | page, pageSize, batchType, exceptionType, severity, comCode, search | `{rows, total, byType}` | `listExceptions` |
| GET | `/api/dashboard` | – | stats | `dashboardStats` |
| GET | `/api/options` | – | `FilterOptions` | `filterOptions` |
| GET | `/api/master/[table]` | table ∈ `gatewayCompanyMapping, partners, journalType, journalLineRule, coa, exrate, mappingBankAccount` (khác → 404); search; page/pageSize **chỉ áp dụng cho partners**, bảng khác trả toàn bộ | `{rows, total}` | `listMaster` |
| GET | `/api/master/company` | – | `{rows, total}` | `listMaster("company")` |
| POST | `/api/master/company` | `{ComCode, CompanyName?, FunctionalCurrency, IsActive?}` | `{done}` | `upsertCompany` |
| POST | `/api/master/gateway-mapping` | `{ID?, PaymentGatewayName, ComCode, IsActive?}` | `{done}` / 400 | `upsertGatewayMapping` |
| DELETE | `/api/master/gateway-mapping?id=` | – | `{done}` | `deleteGatewayMapping` |
| POST | `/api/master/sync` | – | `{counts}` | `syncMastersFromGoogleSheet` |

> **Bẫy routing:** thư mục tĩnh `src/app/api/master/company/` **che** route động `[table]` cho path `/api/master/company` → file đó phải tự khai báo cả GET. Khi tạo route tĩnh cùng cấp với `[table]` nhớ điều này.

Dynamic params trong Next 16 là Promise: `(req, ctx: { params: Promise<{ id: string }> })` rồi `await ctx.params`.

---

## 8. Frontend

### 8.1 Khung
- `src/app/layout.tsx`: `<AntdRegistry><AppShell>{children}</AppShell></AntdRegistry>`.
- `src/components/AppShell.tsx` (client): `ConfigProvider` (locale `vi_VN`, `colorPrimary #1f6feb`), `<App>` (để dùng `App.useApp()`), `Layout.Sider` + `Menu` (key = path). Thêm trang mới → thêm vào hằng `MENU`.
- `src/app/raw/[source]/page.tsx` là **một trang động dùng chung** cho 4 nguồn ngoài Orders: cột, sheet, cột bắt buộc đều đọc từ `SOURCE_META`. `/raw/orders` là route tĩnh nên không bị route động che.
- `ScopeBar` có thêm ô **Nguồn** (`dataSource`), dùng chung cho Build (`/events`), Post/Unpost (`/posting`) và lọc GL (`/gl`).
- Mọi page là client component (`"use client"`), tự fetch API.

### 8.2 Helper
`src/components/client.ts`:
- `useApi<T>(url | null)` → `{data, loading, error, reload}`; `url = null` thì không gọi; tự gọi lại khi url đổi; chống race bằng sequence ref. Filter/phân trang thường được đưa vào url qua `toQuery`. `data` cũ **được giữ** tới khi request mới xong (kể cả khi url thành null) → Drawer có thể thoáng hiện dữ liệu bản ghi trước.
- `getJson`, `postJson(url, body, method?)`, `deleteJson` – lỗi HTTP ném `Error(body.error)`.
- `toQuery(obj)` bỏ giá trị null/undefined/"".
- `useOptions()` = `useApi("/api/options")`; `money(v)` định dạng `en-US` 2 số lẻ.

`src/components/ui.tsx`:
- `columnsOf<T>(fields, docs?, overrides?)` → cột antd Table: header `FieldTitle` (tooltip từ docs), cột tiền canh phải + `money`, cột trạng thái (`PostStatus, Status, BuildStatus, Severity, BalanceImpact, Classify, ItemStatus`) → `StatusTag`, width/ellipsis theo tên cột. Override từng cột qua `overrides[name]` (VD `fixed: "left"`).
- `StatusTag` – màu theo map `COLORS`.
- `ScopeBar` – Select ComCode + `DatePicker.RangePicker picker="month" format="YYYYMM"`, value dạng `{comCode?, periodFrom?, periodTo?}`.
- Tooltip cột: `GL_FIELD_DOCS`, `EVENT_FIELD_DOCS`, `POSTING_BATCH_FIELD_DOCS` (`src/lib/field-docs.ts`); `RAW_DOCS` nằm trong `src/app/raw/orders/page.tsx`.

### 8.3 antd v6 – dùng prop mới (prop cũ vẫn chạy nhưng cảnh báo)

| Component | Dùng | Không dùng |
|---|---|---|
| Space, Divider | `orientation` | `direction` |
| Alert | `title` | `message` |
| Steps item | `content` | `description` |
| Drawer | `size={960}` | `width` |
| Modal, Tabs, Tooltip | `destroyOnHidden` | `destroyOnClose`, `destroyInactiveTabPane` |
| Card | `variant` | `bordered` |
| Statistic | `styles.content` | `valueStyle` |

- message/modal/notification: lấy từ `const { message, modal } = App.useApp()`, không gọi static `message.success`.
- **Không** dùng `Modal forceRender` (gây "Portal only work in client side" khi SSR). Form trong Modal: `destroyOnHidden` + `<Form initialValues={...} preserve={false}>`, chỉ gọi `form.validateFields()` khi modal đang mở.
- Tải file: dùng `<Button href="/api/.../export?...">` (trình duyệt tải trực tiếp).

---

## 9. Quy ước code

- Comment & text UI tiếng Việt; tên bảng/cột/hàm tiếng Anh, **tên cột giữ nguyên như sheet**.
- **Logic nghiệp vụ chỉ đặt trong `src/lib/engine`** (thuần, có test). Route/page không chứa quy tắc kế toán.
- Tiền: tính bằng `Decimal`, làm tròn `toDecimalPlaces(2, Decimal.ROUND_HALF_UP)` trước khi lưu/so sánh. Không cộng float.
- So khớp mã (ComCode, JTC, DataSource, PartnerCode, currency): trim + uppercase.
- Lỗi do input người dùng: `throw new BadRequestError("...")` (`src/lib/errors.ts`) → 400.
- Truy vấn `IN (...)` lớn: chia `chunk(list, 400–500)` (`services/common.ts`).
- Ghi nhiều bảng: 1 `db.transaction` đồng bộ; batch log (BuildBatch/PostingBatch) tạo **ngoài** transaction để lỗi vẫn giữ lại bản ghi FAILED.
- Thêm ExceptionType: cập nhật union trong `engine/types.ts`, `TYPE_DOCS` ở `src/app/exceptions/page.tsx`, bảng §6.8.
- Thêm cột GL/Event: cập nhật `gl-columns.ts`, `field-docs.ts`.
- ESLint: biến bắt đầu bằng `_` được phép không dùng (`eslint.config.mjs`).

---

## 10. Testing & baseline

### 10.1 Cấu trúc
- `vitest.config.mts`: alias `@` → `src`, chạy `tests/**/*.test.ts`, môi trường node.
- `tests/helpers/fixtures.ts`:
  - `loadMasters()` / `loadIndex(overrides?)` – master từ `data/seed/*.csv` + Company/Gateway mặc định (không cần DB).
  - `loadSampleOrders(file?)` – đọc `data/samples/orders-sample.csv|.xlsx` qua `readTable` + `normalizeOrderRow`, gán `RawOrderID` 1..n.
  - `toEventRows(drafts, startId=1000)` – giả lập insert DB (gán AccountingEventID).
- `tests/engine/*.test.ts` – test engine thuần.
- `tests/engine/reconcile-events.test.ts` – mô phỏng `runBuildOrders` (phạm vi trọn đơn, load event theo OrderID, SourceID đang build / đã chết / ngoài phạm vi) trên dữ liệu mẫu: đổi mapping/RuleSeq/cách viết JTC/ngày giao sau khi post, 1 item chuyển ngày trong khi ngày cũ còn item, event ngày cũ chưa post bị xóa, dữ liệu trùng có sẵn, event cũ chưa có ItemCodes (chặn thận trọng, bổ sung ItemCodes khi hash khớp), item đến muộn, sau khi Unpost (Build toàn bộ hoặc theo ComCode cũ), thêm rule, amount về 0, gỡ mapping, đơn nhiều cổng (đổi 1 cổng, công ty chưa post không bị chặn nhầm, Build theo ComCode).
- `tests/engine/post-guard.test.ts` – `findDuplicateItems`: dữ liệu bình thường không bị giữ; trùng item với event POSTED khác ComCode/ngày giao; 2 event cùng chờ post; bỏ qua ERROR/BUILD, SKIPPED; event chưa có ItemCodes.
- `tests/integration/gateway-remap.test.ts` – DB tạm riêng: post → đổi mapping Stripe → ONTARIO → Build chặn 12 event → Post không ghi thêm → Unpost + Build + Post theo ZENIROXPAY kỳ 202511 → Post ONTARIO → ONTARIO 501.40, ZENIROXPAY 5,838.30.
- `tests/integration/posted-guards.test.ts` – DB tạm riêng:
  1. đơn 2 cổng, đổi 1 cổng → chặn 15 (full và theo ONTARIO), sổ không đổi → Unpost → ONTARIO 563.70 / ZENIROXPAY 5,838.30;
  2. gỡ mapping → Build → import lại đổi FulfilledAt bị từ chối → gắn lại mapping → không ghi trùng;
  3. như 2 nhưng Unpost trước khi import → vẫn từ chối ("Unbuild ComCode … kỳ …") → Unbuild → import được → Build + Post 6,339.70;
  4. đổi ngày giao sẵn trong DB sau khi post → Build chặn 12 → Unpost ZENIROXPAY 202511 + Build theo phạm vi đó → xóa 12 event ngày cũ → Post 6,339.70, không còn exception `POSTED_*`;
  5. đổi cổng → chặn → Unpost ZENIROXPAY → Unbuild ONTARIO: dòng Stripe vẫn BUILT, import đổi ngày bị từ chối → Build + Post ONTARIO 501.40 / ZENIROXPAY 5,838.30;
  6. Post giữ 174 event chưa có ItemCodes (Build lại thì post bình thường) và 12 event trùng do phiên bản cũ tạo (sổ không đổi).
  7. event POSTED chưa có ItemCodes: import dòng sửa cùng đơn bị từ chối (gợi ý Build lại) → Build bổ sung ItemCodes → import được, không ghi trùng.
- `tests/integration/flow.test.ts` – set `process.env.DATABASE_PATH` sang file tạm **trước khi** `await import(...)` các service (import tĩnh sẽ mở DB mặc định), chạy import → build → rebuild → post → export → chặn re-import → unpost → unbuild → build/post lại → Unpost+Unbuild theo kỳ; xóa file DB ở `afterAll`.

### 10.2 Baseline hồi quy (file order mẫu 64 dòng, master snapshot hiện tại)

| Chỉ số | Giá trị |
|---|---|
| Dòng FULFILLED / UNFULFILLED | 60 / 4 |
| AccountingEvent | **174** = PRODUCT 60 + SHIPADD 58 + TAX 0 + SELLER_PROFIT 56 |
| Exception sau build | 70 INFO (4 NOT_FULFILLED + 66 AMOUNT_ZERO) |
| Post Single | NOTHING_TO_POST (Orders đều Bulk) |
| Post Bulk | **21 chứng từ, 42 dòng GL** |
| Σ Nợ = Σ Có | **6,339.70** (Product 3,553.95 + ShipAdd 285.40 + SellerProfit 2,500.35) |
| Ngày 20/11/2025 | Product 2,230.66 · ShipAdd 164.67 · cong2672000@gmail.com 397.04 · lyndylutz@gmail.com 145.00 · nguyenthang5356@gmail.com 1,027.68 |
| Order `MTUBV-181125-51MRR` | PRODUCT 34.99, SHIPADD 4.99, SELLER_PROFIT 28.42 (TaxID `VA4ZH4IIFMUTCFCXF1GY`, `FFT-FFT ARG`) |

Nếu thay đổi làm lệch các số này mà không cố ý đổi nghiệp vụ → là bug.

**Baseline các nguồn ngoài Orders** (file mẫu trong `data/samples/`, trích từ workbook thật — `tests/engine/build-bank.test.ts` + `tests/integration/bank-sources.test.ts`)

| Nguồn | File mẫu | Dòng | Event | Ghi chú |
|---|---|---:|---:|---|
| PayPal | `paypal-sample.csv` | 81 | **113** | 1 dòng ERROR `MISSING_JOURNAL_TYPE` (`PP_GENERAL_CURRENCY_CONVERSION`) |
| Stripe | `stripe-sample.csv` | 48 | **71** | gồm `STRIPE_RECEIPT_CUSTOMER` và `STRIPE_RESERVE` |
| PIPO | `pipo-sample.csv` | 36 | **48** | 2 dòng `Status = Retrieved` bị bỏ |
| Master Card | `master-card-sample.csv` | 39 | **39** | Nợ `11202091` / Có `11202061`, Σ = **1.076,87 USD** |
| Bank_Royal | `bank-royal-sample.csv` | 31 | **55** | CAD → USD, `RateType = DIV` |

Mọi chứng từ của 4 nguồn phải cân Σ Nợ = Σ Có (`assertBalanced` throw nếu lệch).

**Chạy toàn bộ workbook thật** (`Data-khac-order.xlsx`, 29 MB — đã kiểm chứng một lần, không nằm trong test tự động):

| Nguồn | Dòng raw | Event | Chứng từ | Dòng GL | Σ Nợ = Σ Có |
|---|---:|---:|---:|---:|---:|
| PayPal | 142.659 | 198.243 | 4.778 | 10.260 | 6.986.394,87 |
| Stripe | 1.413 | 2.712 | 287 | 928 | 123.799,26 |
| PIPO | 952 | 969 | 969 | 1.938 | 3.223.338,19 |
| AccountingSource | 70 | 94 | 94 | 188 | 10.033,85 |
| **Tổng** | | **202.018** | **6.128** | **13.314** | **10.343.566,17** |

Exception: **95 dòng** (1 ERROR = `PP_GENERAL_CURRENCY_CONVERSION`; 50 WARNING `MISSING_PARTNER` là seller chưa có trong Partners; 44 INFO). Thời gian: import PayPal ~30s, build ~28s, post ~8s; RSS đỉnh ~11,8 GB (xem §13.2).

### 10.3 Test trình duyệt (tùy chọn, chưa có trong repo)
Có thể dùng `playwright-core` với Edge có sẵn: `chromium.launch({ channel: "msedge" })`, chạy dev server, `setInputFiles` vào `input[type=file]` của trang `/raw/orders`, bấm các nút Build/Post, kiểm tra text "6,339.70", bắt `page.on("console")` để phát hiện lỗi/cảnh báo. Lưu ý antd render trùng text (dùng `.filter({ visible: true })`), tên nút có kèm aria-label icon (VD `rollback Unbuild`).

---

## 11. Hướng dẫn mở rộng

### 11.1 Thêm nguồn dữ liệu mới

PayPal / Stripe / PIPO / AccountingSource **đã làm xong** — xem §6.11. Phần dưới là cách thêm nguồn **thứ 5** (VD Payoneer), tận dụng lại khung có sẵn.

Nếu nguồn mới cũng có dạng "1 dòng sao kê ngân hàng/PSP → N bút toán" thì **không phải viết engine mới**, chỉ cần khai báo:

1. **Lấy file mẫu thật** và đọc yêu cầu trong `tai lieu du an.md`. Đối chiếu output với `data/samples/gltrans-reference.csv` (có sẵn dòng GL PayPal thật).
2. **Schema:** thêm bảng raw vào `schema.ts` dùng lại `bankRawColumns()` (`SourceKey` unique, `PostingDate`, `BuildStatus`, `RowHash`…) + các cột sheet giữ **đúng tên header** → `npm run db:generate`.
3. **Cột:** thêm danh sách cột + `SOURCE_META` + `SHEET_COLUMNS` vào `src/lib/sources/columns.ts` (client-safe, không import `node:*`).
4. **Normalize:** thêm `normalize<Source>Row` vào `src/lib/sources/normalize.ts`. Chọn `SourceKey` theo quy tắc §6.11.3 — **không được phụ thuộc cột người dùng điền tay**.
5. **Spec engine:** thêm `src/lib/engine/sources/<source>.ts` implement `BankSourceSpec` (thuần khai báo). Không viết quy tắc kế toán ở đây — chúng nằm trong `build-bank.ts`.
6. **Đăng ký:** thêm adapter vào `adapterOf` (`services/import-source.ts`), `builders` (`services/build-source.ts`) và `RAW_SOURCE_TABLES` (`services/queries.ts`).
7. **Master data:** JournalType phải có dòng với đúng `DataSource` mới — nếu thiếu thì `classifyOf` trả null và **event không bao giờ post được**. Thêm cả `MappingBankAccount` cho số tài khoản mặc định của nguồn.
8. **Post:** không cần sửa.
9. **UI:** trang raw `/raw/[source]` và API `/api/sources/[source]` tự chạy theo `SOURCE_META`; chỉ cần thêm 1 dòng vào `MENU` (`src/components/AppShell.tsx`).
10. **Test:** trích file mẫu vào `data/samples/`, thêm loader vào `tests/helpers/fixtures.ts`, mở rộng `tests/engine/build-bank.test.ts` + `tests/integration/bank-sources.test.ts`, ghi baseline mới vào §10.2.

Nếu nguồn mới có hình dạng khác hẳn (gom nhiều dòng thành 1 event như Orders) thì viết engine riêng theo mẫu `build-orders.ts`.

### 11.2 Thêm/đổi cột hoặc bảng
1. Sửa `src/lib/db/schema.ts` (tên cột PascalCase).
2. `npm run db:generate` → kiểm tra SQL trong `drizzle/`.
3. Cập nhật engine type (`EventDraft`, `GlLineDraft` suy ra từ schema) và nơi gán giá trị.
4. GL/Event: thêm vào `src/lib/gl-columns.ts` (thứ tự export) và `src/lib/field-docs.ts`.
5. Parser master nếu cột đến từ sheet (`parse-master.ts`).
6. Chạy test; restart dev (migration tự chạy).

### 11.3 Thêm AmountSource cho Orders
Sửa `amountFor()` và phần cộng dồn group trong `build-orders.ts` (thêm field vào `OrderGroup`), thêm JournalType + JournalLineRule tương ứng trong sheet, thêm mã vào `ORDER_JOURNAL_TYPE_CODES` nếu là nghiệp vụ mới, cập nhật test/baseline và bảng §6.2.

### 11.4 Thêm API + trang
- Route: `src/app/api/<path>/route.ts`, export `GET/POST = handle(async (req) => ok(await service(...)))`; parse bằng `parseScope/paging/str/int/bool/jsonBody`.
- Page: `src/app/<path>/page.tsx` với `"use client"`, dùng `useApi`, `columnsOf`, `ScopeBar`; thêm vào `MENU` trong `AppShell.tsx`.

### 11.5 Lộ trình theo tài liệu gốc
> Các bảng/hàm dưới đây là **đề xuất, chưa có trong code**.

- **Accounting Period lock** (§4.3): bảng `AccountingPeriod(ComCode, Period, Status, LockedBy, LockedAt, UnlockReason)`; hàm `assertPeriodsOpen(comCode, periods)` gọi ở đầu import/build/post/unpost/unbuild, ném `BadRequestError`.
- **Company tree** (§4.1–4.2): thêm `ParentComCode`, `CompanyType`, `IsPostingEnabled`, `IncludeInParentReport` vào `Company`; chặn ghi sổ với `REPORTING_NODE`.
- **FX theo ExchangeRateResolveRule** (§11): thêm bảng rule (RateCategory/RateDesc/RateFrequency/Effective period) và mở rộng `resolveFx` (Daily theo TransDate); GL lưu snapshot tỷ giá.
- **Auth/phân quyền** (§20) và **Operation Audit Log** (§18).

---

## 12. Debug & lỗi thường gặp

| Triệu chứng | Nguyên nhân | Xử lý |
|---|---|---|
| `npm i` lỗi `better-sqlite3` … `gyp ERR! find Python` | Mất `.npmrc` (`ignore-scripts=true`) hoặc gọi npm với `--ignore-scripts=false` → npm chạy `node-gyp rebuild` (§1.4) | Giữ `.npmrc`, xóa `node_modules` rồi `npm ci`; không cần cài Python/Build Tools |
| `npm run db:reset` báo `EPERM` (Windows) | Dev server/process node vẫn giữ file DB | Tắt `next dev` (kiểm tra còn process `node ... next dev` không) rồi chạy lại |
| `no such table` / `no such column` | Sửa schema nhưng chưa sinh migration | `npm run db:generate` rồi restart; dữ liệu test thì `db:reset` |
| Upload .xlsx trả 500 `Cannot read properties of undefined (reading 'trim')` | Dòng tiêu đề có ô trống **nằm giữa** các cột → `headers` có phần tử rỗng (sparse) | Xóa cột trống trong file; fix code: §13.3 |
| Import số sai (VD `"1,234"` thành 1.234) | Một dấu phẩy được hiểu là thập phân (file xuất từ Google Sheet locale VN) | File dùng dấu phẩy phân cách nghìn kiểu Mỹ phải có phần thập phân (`1,234.00`) hoặc xuất .xlsx; hoặc sửa `parseNumber` |
| Ngày bị đảo ngày/tháng | `parseDate` ưu tiên `M/D/YYYY` | Dùng `YYYY-MM-DD` hoặc .xlsx |
| Import lỗi "Unbuild trước khi import lại" | Dòng đã BUILT và dữ liệu thay đổi | Unbuild (hoặc Unpost + Unbuild) phạm vi đó rồi import lại |
| Event ERROR `MISSING_PARTNER` | Email seller không có / nhiều store không khớp `PartnerName` | Bổ sung Partners trong sheet → Sync → Build lại; hoặc thêm `TaxID` vào file order |
| Raw `ERROR` `MISSING_COMCODE` | `PaymentGatewayName` mới | Master → GatewayCompanyMapping → Build lại |
| Post Single luôn `NOTHING_TO_POST` | Nghiệp vụ Orders đều Classify Bulk | Bình thường |
| Build lại thấy `EventsReplaced` = tổng số event | Build luôn replace event chưa post | Bình thường |
| Build lại không đổi số liệu đã post | Event POSTED không bị ghi đè; có exception `POSTED_SOURCE_CHANGED` | Unpost → Build → Post |
| Event ERROR `POSTED_KEY_CHANGED` sau khi sửa GatewayCompanyMapping / RuleSeq / ngày giao | Item đã ghi sổ dưới khóa cũ; tạo event NEW sẽ ghi sổ trùng (§6.2) | Trang Posting → Unpost theo ComCode + kỳ cũ nêu trong message → Build (gồm kỳ/ComCode mới nếu message ghi) → Post cả ComCode cũ và mới |
| Import lỗi "Dòng đã ghi sổ (event …, POSTED)…" / "Dòng còn nằm trong AccountingEvent chưa post…" dù dòng không BUILT | Item của dòng còn nằm trong event (đã post hoặc chưa); đổi dữ liệu rồi Build + Post sẽ ghi sổ trùng (§6.1) | Unpost + Unbuild (hoặc chỉ Unbuild nếu chưa post) theo ComCode + kỳ nêu trong message rồi import lại |
| Post báo `ErrorEvents`, exception `DUPLICATE_ITEM` | Item đã/đang chờ ghi sổ ở event khác ngày giao/công ty, hoặc event tạo trước migration `0001` (§6.3) | Build lại (phạm vi gồm cả event kia) → Post. Sau khi nâng cấp lên bản có cột `ItemCodes`, Build lại trước khi Post |
| Đổi TK trong JournalType nhưng Post vẫn ra TK cũ | TK được copy vào event lúc Build | Build lại (event chưa post sẽ được replace) |
| Sync Google Sheet lỗi | Sheet không share public / mất mạng | Kiểm tra quyền "Anyone with the link"; snapshot cũ vẫn giữ nguyên |
| Build client lỗi `Can't resolve 'fs'` / `node:crypto` | Page client import module server | Chỉ `import type`, hoặc tách hằng ra file client-safe (§2.3) |
| GET trả 405 | Route tĩnh che route động (§7) | Khai báo method trong route tĩnh |
| Cảnh báo "Portal only work in client side" | Modal `forceRender` | Bỏ `forceRender` (§8.3) |
| Cảnh báo prop deprecated của antd | Dùng prop v5 | Đổi theo §8.3 |
| `AGENTS.md` bị thêm block lúc chạy dev | `next dev` tự quản lý block `nextjs-agent-rules` | Để nguyên; không sửa trong block đó |
| Chứng từ báo "không cân" | Bug gom dòng Bulk hoặc làm tròn | Xem `assertBalanced` và khóa gom dòng trong `postEvents` |

### 12.1 Soi dữ liệu
Dùng DB Browser for SQLite, `sqlite3 data/finance.db`, hoặc Node:

```bash
node -e "const D=require('better-sqlite3');const db=new D('data/finance.db');console.table(db.prepare('SELECT PostStatus, count(*) n FROM AccountingEvent GROUP BY PostStatus').all())"
```

Truy vấn hữu ích:

```sql
-- Chứng từ không cân
SELECT DocNum, round(sum(AccountedDr),2) dr, round(sum(AccountedCr),2) cr
FROM GLTrans GROUP BY DocNum HAVING dr <> cr;

-- Truy vết 1 order: raw → event → GL
SELECT * FROM RawOrders WHERE OrderId = 'MTUBV-181125-51MRR';
SELECT AccountingEventID, JournalTypeCode, Amount, PostStatus, PostedDocNum, ErrorMessage
FROM AccountingEvent WHERE OrderID = 'MTUBV-181125-51MRR';
SELECT * FROM GLTrans WHERE DocNum IN (
  SELECT PostedDocNum FROM AccountingEvent WHERE OrderID = 'MTUBV-181125-51MRR');

-- Exception lỗi thật
SELECT BatchType, ExceptionType, count(*) FROM ExceptionLog WHERE Severity <> 'INFO' GROUP BY 1, 2;

-- Tổng hợp phát sinh theo tài khoản
SELECT AccountCode, round(sum(AccountedDr),2) dr, round(sum(AccountedCr),2) cr FROM GLTrans GROUP BY AccountCode;
```

Test nhanh 1 hàm engine mà không chạy app: viết test trong `tests/engine/` dùng `loadIndex()` + `loadSampleOrders()`.

---

## 13. Giả định, hạn chế, nợ kỹ thuật

### 13.1 Giả định nghiệp vụ (chưa được xác nhận chính thức)
- Dòng GL Bulk: `ReferenceTxnID/OrderID/RefNum = null`, `Description = MemoTemplate | {n} events` (sheet mẫu chỉ có dòng Single).
- Order không có cột tiền tệ → `InputCurr = USD`.
- `PartnerTaxID` trên GL lấy từ bảng Partners (với INDIVIDUALS là `INDIVIDUALS`), trong khi sample GL PayPal cũ để null với partner cố định.
- Mọi dòng của 1 group order dùng seller của dòng đầu tiên.
- Company = cổng thanh toán; `ZeniroxPay Inc.` và `ZeniroxPay - Stripe` cùng `ZENIROXPAY`.
- `ProductAmount = Quantity × UnitPrice` theo tài liệu, không dùng `TotalPrice` (có dòng mẫu `TotalPrice` lệch).
- **Tỷ giá bổ sung ngoài Google Sheet (2026-09-17, `data/seed/exrate.csv` ExrateID 19–63 + DB):** kỳ 202501–202608, mỗi kỳ 1 dòng, `ExrateDate` = ngày 1 của tháng.
  - ONTARIO (FncCurr CAD, InputCurr USD): `CAD/USD MUL` = Bank of Canada `FXMUSDCAD` (bình quân tháng, CAD cho 1 USD) — cùng quy ước 15 dòng `USD/CAD DIV` có sẵn (khớp 15/15); nối thêm `USD/CAD DIV` 202604–202608.
  - VICBEA (FncCurr VND, InputCurr USD): `VND/USD MUL` = bình quân tháng của (mua chuyển khoản + bán)/2 Vietcombank trên các ngày có công bố (tỷ giá mua bán chuyển khoản trung bình — TT200 sửa bởi TT53, TT133 Điều 52, TT99/2025). Kỳ từ 2026 (TT99: lệch ≤ ±1% so với tỷ giá tại ngày giao dịch) tháng nào vượt biên thì đưa vào biên: chỉ 202601 (26,195.24 → 26,189.30). Ngân hàng tham chiếu phải là ngân hàng VICBEA thường xuyên giao dịch; khác Vietcombank thì thay số.
  - Dòng `USD/VND DIV 26500` (202503) của sheet lệch ~3.7% so với thị trường và sai chiều cho công ty VND; giữ nguyên vì là dữ liệu sheet.
- **Partners bổ sung ngoài Google Sheet (2026-09-17, PartnerID 1931–1942):** 12 seller có trong file order thật nhưng thiếu trong Partners/finance-old. `PartnerCode` = email viết thường, `PartnerName` = `FFT-{StoreName}`, `BankType` PingPong, **`PartnerTaxID` NULL** (không có nguồn mã seller). Sync từ Google Sheet ghi đè cả DB lẫn `data/seed/*.csv` → phải thêm các dòng tỷ giá/seller này vào sheet trước khi Sync.
- **Giả định của 4 nguồn ngoài Orders (2026-09-21)** — xem §6.11.8 cho danh sách master data đã thêm, tất cả cũng phải đưa vào Google Sheet:
  - `BalanceImpact` của `Bank_Royal`/`Master Card` hiểu theo quy ước **sao kê ngân hàng**: `Debit` = tiền ra khỏi tài khoản (Amount ghi âm), `Credit` = tiền vào (ghi dương). Suy từ bút toán, không có trong tài liệu: `BANK_BANK_FEE` (Debit) phải ra `Nợ 64200020 / Có 11202001`, và `BANK_INTERNAL_TRANSFER_FROM` (Credit, Contra `11202053`) phải ra `Nợ 11202001 / Có 11202053`.
  - `Master Card` **không có cột ContraAccount**; cả 39 dòng đều là nhận tiền từ PingPong nên Import gán mặc định `11202061`. Mặc định của JournalType (`11301001` – "Rút PayPal về Bank VN") là sai cho nghiệp vụ này.
  - Tài khoản GL của thẻ MasterCard (`11202091`) là **tài khoản mới do dự án đặt**, không có trong CoA gốc.
  - PIPO dùng `JournalType` của `DataSource = PIPO` mới thêm, với `BankAccount = 11202061`. Tài liệu §5.1 coi PIPO là DataSource riêng nhưng master chưa có dòng nào.
  - `PostingDate` của Stripe lấy cột `Date` (ngày balance transaction), không phải `Created (UTC)` hay `Available On (UTC)` — tài liệu không nói rõ.
  - `Bank_Royal` và `Master Card` **không có trong §5.1** của tài liệu gốc; xếp vào `AccountingSource` vì cả hai đều điền JournalType của DataSource đó.
  - 1 dòng PayPal `General Currency Conversion` (`PP_GENERAL_CURRENCY_CONVERSION`) **cố ý để lỗi** `MISSING_JOURNAL_TYPE`: master chỉ có `PP_USER_INITIATED_CURRENCY_CONVERSION`. Chưa tự suy diễn vì là quyết định nghiệp vụ — thêm dòng JournalType vào sheet nếu muốn ghi sổ dòng này.

### 13.2 Hạn chế kỹ thuật
- Tài khoản trên event là bản copy lúc Build; rule/tỷ giá/CoA đọc lúc Post.
- `hasAccount` trả true nếu CoA rỗng.
- `loadMasterIndex` đọc toàn bộ master mỗi lần gọi (không cache).
- Build lọc ComCode trong JS (load hết raw theo kỳ); Post load hết candidate vào bộ nhớ; export và `listMaster` (trừ partners) load toàn bộ → chưa tối ưu cho dữ liệu lớn. Đo trên file order thật (55,111 dòng → 156,233 event → 3,350 chứng từ): Import ~20s; Build lần đầu ~30s; Build lại khi đã post ~17s; Build khi phải replace toàn bộ (sau Unpost all) 50–78s; Post ~9s; RSS tiến trình 4–10GB; Export Excel toàn bộ AccountingEvent 4–5 phút. Build/Post chạy đồng bộ trong request → chặn server Next trong lúc chạy; nên Build theo kỳ + ComCode.
- **Nguồn ngoài Orders chạy cùng kiểu đồng bộ, không chunk** (lựa chọn có ý thức khi làm §6.11). Đo trên workbook thật: import PayPal 142.659 dòng ~30s, Build ~28s (198k event), Post ~8s; **RSS đỉnh ~11,8 GB** — cần `NODE_OPTIONS=--max-old-space-size=12288` cho `next dev`/`next start`, nếu không dễ OOM. Mỗi lần import đọc lại toàn bộ file .xlsx 29 MB (~10–13s) kể cả khi chỉ lấy sheet 31 dòng. Nếu gặp OOM thì hướng sửa là đọc/ghi theo lô ~5.000 dòng trong `importSourceFile` và `runBuildSource`.
- Unbuild theo ComCode cũng reset raw có `ComCode` null; lọc kỳ bỏ qua raw không có `FulfilledAt`.
- `runBuildSource` lọc kỳ bằng so sánh chuỗi `PostingDate` với `YYYY-MM-01`…`YYYY-MM-31` (không dùng `periodOfDateColumn`) → dòng không có `PostingDate` bị bỏ khi có lọc kỳ.
- Unpost không reset event `SKIPPED` / `ERROR` giai đoạn POST.
- Không khóa kỳ, không audit log thao tác, không auth.
- SQLite 1 process; không phù hợp nhiều instance.
- `INVALID_FULFILLED_DATE` chưa dùng.
- Chưa có test trình duyệt trong repo.

### 13.3 Bug / rủi ro đã biết (chưa sửa)

Phát hiện khi rà soát tài liệu với code. Khi sửa, thêm test tái hiện và xóa dòng tương ứng ở đây. Số thứ tự giữ nguyên để không lệch tham chiếu (đã sửa: #3, #4, #13 – xem §6.2).

| # | Vấn đề | Vị trí | Hướng sửa gợi ý |
|---|---|---|---|
| 1 | File .xlsx có ô tiêu đề trống giữa các cột → `canonicalHeaders` gọi `.trim()` trên phần tử undefined → HTTP 500 (đã tái hiện) | `src/lib/io/read-table.ts` (`headerOf` dùng `.map` trên mảng thưa), `src/lib/orders/normalize.ts` (`canonicalHeaders`) | Dùng `Array.from(values, ...)` hoặc `h ?? ""` trước khi trim |
| 2 | Body JSON hỏng / `postBatchId` không phải số → `/api/unpost`, `/api/unbuild` chạy thật trên toàn bộ dữ liệu | `src/lib/api.ts` (`jsonBody`, `int`, `bool`) | Ném `BadRequestError` khi JSON hỏng hoặc tham số sai kiểu |
| 5 | Bulk post bổ sung sinh chứng từ mới trùng `PostingGroupKey` | `src/lib/engine/post.ts` | Chấp nhận (mỗi batch 1 chứng từ) hoặc gom vào chứng từ cũ |
| 6 | `hasAccount` không xét `CoA.Status` (TK inactive vẫn qua) | `src/lib/engine/masters.ts` | Chỉ nạp TK `Status = Active` |
| 7 | `NegativeMode` lạ → SIGNED; `RateType` khác `DIV` → MUL, không báo lỗi | `src/lib/engine/post.ts`, `src/lib/engine/resolve-fx.ts` | Validate khi parse master |
| 8 | Unbuild lọc raw theo `RawOrders.ComCode` đã lưu (+ item của event bị xóa), Build lọc theo mapping hiện tại → dòng raw có ComCode lưu cũ mà không có event nào có thể không được reset khi mapping đổi (không gây ghi sổ trùng: import vẫn báo "Unbuild trước", Build vẫn build lại) | `src/lib/services/clear.ts`, `src/lib/services/build.ts` | Thống nhất 1 cách xác định ComCode |
| 9 | Exception POST mồ côi sau rebuild/Unbuild; Unbuild có scope không xóa exception ComCode/Period null | `src/lib/services/build.ts`, `src/lib/services/clear.ts` | Xóa exception theo event bị xóa |
| 10 | `parseDate` fallback lỏng đổi ISO có `Z` sang giờ máy chủ (có thể lệch ngày); không hỗ trợ `DD/MM/YYYY` | `src/lib/engine/parse.ts` | Parse UTC cho chuỗi có timezone; thêm tùy chọn định dạng khi import |
| 11 | `/api/orders`, `/api/exceptions` không validate/uppercase `comCode`, kỳ | route tương ứng | Dùng `parseScope` |
| 12 | `TYPE_DOCS` thiếu `UNKNOWN_AMOUNT_SOURCE` | `src/app/exceptions/page.tsx` | Bổ sung mô tả |
| 14 | Build/Post/Export chạy đồng bộ trong request: Build toàn bộ file thật khi phải replace 50–78s, chặn mọi request khác; bấm Build 2 lần chạy chồng | `src/lib/services/build.ts`, `src/app/api/build/route.ts` | Chạy nền (job + polling), khóa 1 Build/Post tại 1 thời điểm; bỏ qua replace event không đổi |
| 15 | Tiến trình bị kill giữa Build/Post → `BuildBatch`/`PostingBatch` kẹt `RUNNING` mãi (dữ liệu vẫn rollback đúng) | `src/lib/services/build.ts`, `src/lib/services/post.ts` | Đánh dấu batch RUNNING cũ là FAILED khi khởi động |
| 16 | Export Excel toàn bộ AccountingEvent (156k dòng) mất 4–5 phút, RSS tới ~7.8GB | `src/lib/services/export.ts` | Dùng ExcelJS streaming writer hoặc CSV |
| 17 | Dòng `FULFILLED` nhưng trống `FulfilledAt` chỉ bị bỏ qua với exception INFO `NOT_FULFILLED` (lẫn trong hàng nghìn dòng UNFULFILLED bình thường) | `src/lib/engine/build-orders.ts` | Tách mức WARNING/ERROR riêng cho FULFILLED thiếu ngày |

---

## 14. Thuật ngữ

| Thuật ngữ | Nghĩa |
|---|---|
| **ComCode** | Mã công ty ghi sổ (ở đây = cổng thanh toán) |
| **FncCurr / InputCurr** | Tiền hạch toán của công ty / tiền giao dịch nguyên tệ |
| **DataSource** | Nguồn dữ liệu: ORDERS, PAYPAL, STRIPE, PIPO, AccountingSource |
| **JournalType / JournalTypeCode** | Loại giao dịch gốc / mã nghiệp vụ chuẩn của engine |
| **JournalLineRule** | Quy tắc sinh 1 cặp Nợ/Có cho 1 JournalTypeCode |
| **RuleSeq / EventSeq** | Thứ tự rule; event lưu `EventSeq = RuleSeq` để join lại khi Post |
| **PairCode** | Tên cặp bút toán: BANK_CONTRA, CONTRA_TRANS, FEE_BANK |
| **Bank / Contra / Trans / Fee account** | Vai trò tài khoản: tiền (ngân hàng/PSP) / đối ứng (phải thu, phải trả, tạm giữ) / nghiệp vụ (doanh thu, chi phí) / phí |
| **AmountSource / AmountFactor** | Lấy số tiền từ đâu / hệ số nhân (VD -1) |
| **NegativeMode** | SIGNED giữ dấu · REVERSE đảo vế khi âm · ERROR chặn khi âm |
| **Classify** | Single (1 event 1 chứng từ) / Bulk (gom nhiều event) |
| **DocNum** | Số chứng từ trên GL (`ASI-…` Single, `ASB-…` Bulk) |
| **PostingGroupKey** | Khóa gom nhóm của Bulk |
| **PostBatchID** | Mã lần Post |
| **INDIVIDUALS** | Partner cố định cho khách lẻ (doanh thu order) |
| **Build / Post** | Raw → Event / Event → GL |
| **Unpost / Unbuild** | Gỡ GL (event về NEW) / Xóa event (raw về NOT_BUILT) |

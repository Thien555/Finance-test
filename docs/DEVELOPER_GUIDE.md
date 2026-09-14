# DEVELOPER GUIDE – Sky Finance Accounting Engine

> Tài liệu kỹ thuật cho người/AI tiếp tục phát triển hoặc fix bug. Viết tiếng Việt, giữ nguyên tên bảng/cột/hàm/file.
> **Quy tắc:** khi thay đổi hành vi code, cập nhật mục tương ứng trong file này cùng lúc.
> Tài liệu nghiệp vụ gốc (yêu cầu tổng thể, chưa làm hết): [`tai lieu du an.md`](../tai%20lieu%20du%20an.md).

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

### 1.2 Chưa làm (theo `tai lieu du an.md`)
Auth/phân quyền (§20), Company tree & Accounting Period lock (§4), nguồn PayPal/PIPO/Stripe/AccountingSource (§7.2, §7.4–7.6), Manual Entry (§6), ExchangeRateResolveRule dạng Daily (§11 – hiện chỉ theo kỳ), PartnerSourceMapping riêng, Operation Audit Log, dashboard nâng cao.

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
    events/page.tsx               2. AccountingEvent
    posting/page.tsx              3. Posting
    gl/page.tsx                   4. GLTrans
    exceptions/page.tsx           Exceptions
    master/page.tsx               Master data
    api/**/route.ts               26 route handler (§7)
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
    db/schema.ts                  Drizzle schema 15 bảng + type
    db/client.ts                  getDb() (migrate + seed lần đầu), closeDb, DB_FILE
    db/seed.ts                    replaceMasters, seedMastersIfEmpty, seedDefaults, readSnapshotTexts
    engine/
      parse.ts                    parseNumber, parseDate, parseDateTime, toText, toFlag, isBlank, nowIso
      keys.ts                     ymd, periodOf, orderTransactionId, orderSourceId, singleDocNum, bulkDocNum, postingGroupKey, eventKey, sha256
      masters.ts                  Masters, MasterIndex, parsePartnerRule, accountFromSource
      resolve-partner.ts          resolveFixedPartner, resolveSeller
      resolve-fx.ts               resolveFx, applyFx
      build-orders.ts             buildOrderEvents + hằng ORDER_JOURNAL_TYPE_CODES
      post.ts                     classifyOf, expandEvent, postEvents, assertBalanced
      types.ts                    ExceptionType, ExceptionDraft, EventDraft, GlLineDraft
    io/read-table.ts              readTable (CSV/XLSX → records)
    master/sources.ts             ID Google Sheet + gid, DEFAULT_COMPANIES, DEFAULT_GATEWAY_MAPPINGS
    master/parse-master.ts        Parse CSV 6 bảng master
    orders/columns.ts             46 cột file order – client-safe
    orders/normalize.ts           canonicalHeaders, normalizeOrderRow
    services/
      common.ts                   Scope, loadMasterIndex, scopeWhere, chunk, insertExceptions, deleteExceptionsByKeys
      import-orders.ts            importOrders
      build.ts                    runBuildOrders
      post.ts                     runPost
      clear.ts                    unpost, unbuild, resetTransactionalData
      queries.ts                  list*/detail/dashboard/options/listMaster
      export.ts                   glWorkbook, eventsWorkbook
      master.ts                   syncMastersFromGoogleSheet, upsertGatewayMapping, deleteGatewayMapping, upsertCompany
tests/
  helpers/fixtures.ts             loadMasters, loadIndex, loadSampleOrders, toEventRows
  engine/parse.test.ts
  engine/build-orders.test.ts
  engine/post.test.ts
  integration/flow.test.ts        Cả luồng trên DB tạm
```

### 2.3 Quy tắc import (quan trọng)
- **Page client không được import** module kéo theo `node:crypto`, `node:fs`, `exceljs`, `better-sqlite3` (ví dụ `engine/keys.ts`, `orders/normalize.ts`, `services/*` trừ `import type`). Nếu cần hằng số dùng chung, đặt trong file client-safe: `src/lib/orders/columns.ts`, `src/lib/gl-columns.ts`, `src/lib/field-docs.ts`.
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
| `ERROR` | `BUILD` | Build: không map được seller | **Không** | Sửa Partners → Build lại (event được replace) |
| `ERROR` | `POST` | Post: thiếu rule/TK/tỷ giá/CoA, amount âm với ERROR | **Có** (retry mỗi lần Post) | Sửa master → Post lại |
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
| `MappingBankAccount` | `ID` auto | `ComCode`, `BankAccountNumber`, `InputCurr`, `GLAccountCode`, `BankName`, `IsActive` (Orders chưa dùng) |
| `Company` | `ComCode` | `CompanyName`, `FunctionalCurrency` (= FncCurr), `IsActive`. **Không có trong sheet** |
| `GatewayCompanyMapping` | `ID` auto, unique `PaymentGatewayName` | Map cột `PaymentGatewayName` của order → `ComCode`. **Không có trong sheet** |

**Raw**

| Bảng | Khóa | Ghi chú |
|---|---|---|
| `ImportBatch` | `ImportBatchID` | `DataSource`, `FileName`, `UploadedAt`, `Status`, `TotalRows`, `SuccessRows`, `ErrorRows`, `SkippedRows`, `ErrorMessage`, `ErrorDetails` (JSON `[{row,key,message}]`, tối đa 500) |
| `RawOrders` | `RawOrderID`, **unique `ItemCode`** | `ImportBatchID`, `ComCode` (resolve lúc import và build), `BuildStatus`, `BuildMessage`, `RowHash` + 46 cột file order (xem `src/lib/orders/columns.ts`). Index `OrderId`, `FulfilledAt` |

**Engine**

| Bảng | Khóa | Ghi chú |
|---|---|---|
| `BuildBatch` | `BuildBatchID` | Scope + `SourceRows`, `EventsCreated`, `EventsReplaced`, `EventsError`, `SkippedRows` |
| `AccountingEvent` | `AccountingEventID`; **unique `UX_AccountingEvent_Key` (ComCode, DataSource, JournalTypeCode, TransactionID, EventSeq)** | Đủ cột sheet AccountingEvent + `ErrorStage`, `BuildBatchID`. Index `PostStatus`, `PostedDocNum`, (`DataSource`,`SourceID`) |
| `PostingBatch` | `PostBatchID` | Cột sheet Postingbatch + `PostedEvents`, `ErrorEvents`, `SkippedEvents` |
| `GLTrans` | `ID` | Đúng 33 cột sheet GlTrans. Index `DocNum`, `PostBatchID`, (`ComCode`,`Period`) |
| `ExceptionLog` | `ID` | `BatchType` (IMPORT/BUILD/POST), `BatchID`, `DataSource`, `ComCode`, `Period`, `Severity` (INFO/WARNING/ERROR), `ExceptionType`, `SourceKey`, `Message`, `CreatedAt` |

Không có foreign key; liên kết qua giá trị: `GLTrans.DocNum` ↔ `AccountingEvent.PostedDocNum`; `AccountingEvent.OrderID` + `PostingDate` ↔ `RawOrders.OrderId` + `FulfilledAt`.

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
   - Có rồi, khác, chưa BUILT → **update** (gán ImportBatchID mới, reset NOT_BUILT).
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
2. Load raw theo scope: kỳ lọc bằng SQL trên `FulfilledAt`; **ComCode lọc trong JS** bằng `comCodeOfGateway` (raw chưa map chỉ được xử lý khi không chọn ComCode). Chú ý: lọc theo kỳ sẽ **bỏ qua dòng không có FulfilledAt**.
3. Gọi engine.
4. Transaction:
   - Load event hiện có theo `SourceID` của các dòng có FulfilledAt, map theo `eventKey`.
   - Draft chưa có → insert (`EventsCreated`).
   - Đã có & `POSTED` → giữ nguyên (`EventsUnchangedPosted`); nếu `SourceHash` khác → exception `POSTED_SOURCE_CHANGED` (WARNING).
   - Đã có & chưa POSTED → update toàn bộ, xóa thông tin post (`EventsReplaced`; **build lại luôn replace kể cả không đổi**).
   - Event cũ của các SourceID đó mà lần này không sinh ra và chưa POSTED → **xóa** (`EventsRemoved`). Lưu ý: event cũ được load theo `SourceID` **không lọc ComCode** → xem §13.3.
   - Event POSTED mà lần này amount về 0 (bị skip) → không có draft nên **không** sinh `POSTED_SOURCE_CHANGED`, chỉ có `AMOUNT_ZERO`.
   - Cập nhật `RawOrders.BuildStatus/BuildMessage/ComCode` cho mọi dòng đã xử lý.
   - Xóa exception BUILD cũ theo tập SourceKey có thể sinh ra (ItemCode, `{TransactionID}|{JTC}`, các JTC, `{JTC}|{RuleSeq}`), rồi insert exception mới.
5. BuildBatch → SUCCESS (hoặc FAILED + ErrorMessage; transaction rollback – khi FAILED, các bộ đếm `EventsCreated/Replaced` trong response có thể khác 0 dù dữ liệu đã rollback).

**Test:** `tests/engine/build-orders.test.ts`.

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
4. `postEvents(candidates, classify, index)`.
5. Transaction: insert GLTrans (chunk 200, gán `PostBatchID`, `AddDate`); update event POSTED theo từng DocNum; event lỗi → `ERROR`/`POST` + ErrorMessage; event bỏ qua → `SKIPPED`/`POST`; xóa exception POST cũ theo key `EventID {id} | {TransactionID}` của mọi candidate rồi insert mới; batch → SUCCESS (+ InsertedRows, PostedEvents, ErrorEvents, SkippedEvents).
6. Exception bất ngờ (VD chứng từ không cân) → rollback, batch FAILED.

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

**Test:** `tests/engine/post.test.ts` (Bulk trên dữ liệu mẫu; Single/REVERSE/SIGNED/ERROR/FX DIV/MISSING_FX/FIXED partner với JournalType giả `TEST_JT`).

### 6.4 Unpost / Unbuild / Unpost + Unbuild / Reset

`src/lib/services/clear.ts`. `unpost` và `unbuild` nhận `preview` → chỉ đếm, không sửa. `resetTransactionalData` không có preview (xóa ngay).

**`unpost({scope, postBatchId, preview})`** – `POST /api/unpost`
1. Tìm event `POSTED` trong scope (và `PostBatchID` nếu có) → tập `PostedDocNum`.
2. Mở rộng ra **toàn bộ chứng từ**: đếm mọi event POSTED có DocNum đó, dòng GL có DocNum đó, danh sách PostBatchID liên quan → `UnpostResult {events, glLines, documents, batches}`.
3. Chạy thật (transaction): xóa GLTrans theo DocNum; event → `NEW`, xóa `PostedDocNum/PostingGroupKey/PostBatchID/PostedAt/ErrorStage/ErrorMessage`; batch nào không còn dòng GL → `UNPOSTED`.
- Event `SKIPPED` hoặc `ERROR/POST` **không bị reset** bởi unpost.

**`unbuild({scope, includePosted, preview})`** – `POST /api/unbuild`
1. `includePosted = true` → chạy `unpost(scope)` trước (preview thì chỉ mô phỏng).
2. Xóa event trong scope có `PostStatus ≠ POSTED` (`deletedEvents`); `postedEventsKept` = số event POSTED còn lại.
3. Raw về `NOT_BUILT` (BuildMessage null) nếu: `BuildStatus ≠ NOT_BUILT`, `RawOrders.ComCode` (giá trị đã lưu, không phải mapping hiện tại) = scope **hoặc null**, kỳ `FulfilledAt` trong scope, và `OrderId` **không** còn event POSTED nào.
4. Xóa `ExceptionLog` BatchType BUILD khớp `ComCode = scope` / `Period` trong scope (không scope → xóa hết BUILD). Có scope thì exception có ComCode/Period null (VD `MISSING_COMCODE`, lỗi cấu hình) **không bị xóa**; exception POST của event bị xóa **không bị dọn** (mồ côi).

**`resetTransactionalData()`** – `POST /api/reset`: xóa `GLTrans, AccountingEvent, PostingBatch, BuildBatch, ExceptionLog, RawOrders, ImportBatch` + reset `sqlite_sequence` (ID bắt đầu lại từ 1). Master giữ nguyên.

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
| `POSTED_SOURCE_CHANGED` | BUILD | WARNING | `{TxnID}\|{JTC}` | Event đã post nhưng nguồn/cấu hình đổi → Unpost, Build, Post lại |
| `INVALID_FULFILLED_DATE` | — | — | — | **Khai báo nhưng chưa dùng** (import đang từ chối dòng thay vì ghi exception) |

- Chống nhân đôi: Build xóa exception BUILD cũ theo tập SourceKey mà lần build đó có thể sinh ra; Post xóa exception POST cũ của **các candidate lần post đó**. Exception của event đã bị xóa (rebuild bỏ event stale, Unbuild) có thể còn sót lại.
- Với dữ liệu mẫu, build sinh 70 exception INFO (4 NOT_FULFILLED + 66 AMOUNT_ZERO).

### 6.9 Master data page

- **UI:** `/master` – nút "Sync từ Google Sheet" (Popconfirm); Tabs (`destroyOnHidden`): GatewayCompanyMapping (thêm/sửa/xóa, Modal + Form `initialValues`, `preserve={false}`, ComCode dùng `AutoComplete`), Company (thêm/sửa), và 6 tab chỉ xem (Partners phân trang server + search; các bảng khác API trả toàn bộ, phân trang ở client). Sau sync, tab xem được remount bằng `key` có `version`.
- **API:** `GET /api/master/[table]`, `POST /api/master/sync`, `POST|DELETE /api/master/gateway-mapping`, `GET|POST /api/master/company`.
- **Service:** `src/lib/services/master.ts`
  - `syncMastersFromGoogleSheet()`: tải 6 CSV song song (`fetch`, no-store); response lỗi hoặc bắt đầu bằng `<` (trang HTML đăng nhập) → throw; `replaceMasters` (parse hết rồi mới xóa & insert trong 1 transaction); thành công mới ghi đè `data/seed/*.csv`. Không đụng Company/GatewayCompanyMapping.
  - `upsertGatewayMapping`: bắt buộc tên + ComCode (uppercase); trùng `PaymentGatewayName` với bản ghi khác → `BadRequestError`; ComCode chưa có trong Company → tự tạo Company (FunctionalCurrency USD).
  - `upsertCompany`: insert hoặc update theo ComCode.
- Sửa master **không tự build lại**; phải bấm Build (thay đổi JournalType TK/Partner/gateway) hoặc Post (thay đổi rule/tỷ giá/CoA) — xem §13.

### 6.10 Dashboard
- **UI:** `/` – Steps 1→4 kèm số liệu, nút Import file order mẫu / Chạy full cycle / Xóa dữ liệu test, 4 thẻ thống kê, Collapse giải thích luồng + công thức + lần chạy gần đây.
- **API:** `GET /api/dashboard` → `dashboardStats()` (raw theo BuildStatus, event theo PostStatus, GL lines/docs/Σ Dr/Σ Cr, exception theo Severity, 5 import/build/post gần nhất).
- `GET /api/options` → `filterOptions()` (`comCodes` từ Company, `journalTypeCodes` + dataSource, `periods` từ event + raw, `postBatches`) – dùng cho Select trên các trang qua `useOptions()`.

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
| POST | `/api/build` | body scope | `BuildSummary` | `runBuildOrders` |
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

### 10.3 Test trình duyệt (tùy chọn, chưa có trong repo)
Có thể dùng `playwright-core` với Edge có sẵn: `chromium.launch({ channel: "msedge" })`, chạy dev server, `setInputFiles` vào `input[type=file]` của trang `/raw/orders`, bấm các nút Build/Post, kiểm tra text "6,339.70", bắt `page.on("console")` để phát hiện lỗi/cảnh báo. Lưu ý antd render trùng text (dùng `.filter({ visible: true })`), tên nút có kèm aria-label icon (VD `rollback Unbuild`).

---

## 11. Hướng dẫn mở rộng

### 11.1 Thêm nguồn dữ liệu mới (PayPal / Stripe / PIPO / AccountingSource)
Post đã tổng quát, chủ yếu cần Import + Build cho nguồn mới. Làm theo mẫu Orders:

1. **Lấy file mẫu thật** của nguồn (danh sách cột) và đọc yêu cầu trong `tai lieu du an.md` (§7.2 AccountingSource, §7.4 PayPal, §7.5 PIPO, §7.6 Stripe). Đối chiếu output mong đợi với `data/samples/gltrans-reference.csv` (có sẵn các dòng PayPal thật: `PP_HOLD_DISPUTE_INVESTIGATION`, `PP_CHARGEBACK`, `PP_CHARGEBACK_FEE`...).
2. **Schema:** thêm bảng raw (VD `RawPayPal`, khóa duy nhất = TransactionID) vào `schema.ts` → `npm run db:generate`. Thêm cột danh sách vào file client-safe kiểu `src/lib/<source>/columns.ts`.
3. **Import:** tạo `normalize` + `services/import-<source>.ts` theo mẫu `import-orders.ts` (RowHash, quy tắc re-import, ImportBatch `DataSource`).
4. **MasterIndex:** bổ sung lookup còn thiếu:
   - JournalType theo **loại giao dịch gốc**: `DataSource + JournalType` (PayPal dùng `Type`, Stripe dùng `TransType`) – hiện index chỉ có theo `JournalTypeCode`.
   - `MappingBankAccount` theo `ComCode + BankAccountNumber` → `GLAccountCode` (BankGLAccount) & `InputCurr` (dữ liệu đã có trong `masters.bankMappings`, chưa có method).
5. **Engine** `src/lib/engine/build-<source>.ts` trả `{events, exceptions, rawStatus, stats}` như Orders:
   - Lọc điều kiện (PayPal/Stripe chỉ `Currency = USD`, PIPO `Status = SUCCESS`) → exception khi loại.
   - Map loại giao dịch → JournalType; thiếu → `MISSING_JOURNAL_TYPE`.
   - Resolve account: giá trị trên nguồn → MappingBankAccount → mặc định JournalType.
   - AmountSource: `GROSS`, `FEE`, `NET`, `AMOUNT` từ cột nguồn (rule PayPal pair 3 dùng `FEE` với `AmountFactor = -1`).
   - `TransactionID` = mã giao dịch nguồn; `BankAccountNumber` = tài khoản nguồn (VD `PAYPAL1`); partner Fixed/From Source.
   - Mỗi rule active → 1 event (PayPal thường 3 rule: BANK_CONTRA, CONTRA_TRANS, FEE_BANK).
6. **Service** `build.ts`: thêm `runBuild<Source>` theo mẫu `runBuildOrders` (SourceID riêng, tập SourceKey để xóa exception cũ). Nếu cần thêm ExceptionType → §9.
7. **Post:** không cần sửa. Classify Single/Bulk đọc từ JournalType. Kiểm tra DocNum/Description khớp `gltrans-reference.csv` (Single PayPal: mỗi event 1 DocNum, Description `Pair N: ... | {TxnID}`, BankAccountNumber `PAYPAL1`).
8. **API/UI:** route import/build cho nguồn; trang raw mới; Build panel chọn nguồn; thêm vào `MENU`; Dashboard đếm theo nguồn.
9. **Test:** fixture file mẫu + test engine + mở rộng integration test; ghi baseline mới vào §10.2.

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

### 13.2 Hạn chế kỹ thuật
- Tài khoản trên event là bản copy lúc Build; rule/tỷ giá/CoA đọc lúc Post.
- `hasAccount` trả true nếu CoA rỗng.
- `loadMasterIndex` đọc toàn bộ master mỗi lần gọi (không cache).
- Build lọc ComCode trong JS (load hết raw theo kỳ); Post load hết candidate vào bộ nhớ; export và `listMaster` (trừ partners) load toàn bộ → chưa tối ưu cho dữ liệu lớn.
- Unbuild theo ComCode cũng reset raw có `ComCode` null; lọc kỳ bỏ qua raw không có `FulfilledAt`.
- Unpost không reset event `SKIPPED` / `ERROR` giai đoạn POST.
- Không khóa kỳ, không audit log thao tác, không auth.
- SQLite 1 process; không phù hợp nhiều instance.
- `INVALID_FULFILLED_DATE` chưa dùng.
- Chưa có test trình duyệt trong repo.

### 13.3 Bug / rủi ro đã biết (chưa sửa)

Phát hiện khi rà soát tài liệu với code. Khi sửa, thêm test tái hiện và xóa dòng tương ứng ở đây.

| # | Vấn đề | Vị trí | Hướng sửa gợi ý |
|---|---|---|---|
| 1 | File .xlsx có ô tiêu đề trống giữa các cột → `canonicalHeaders` gọi `.trim()` trên phần tử undefined → HTTP 500 (đã tái hiện) | `src/lib/io/read-table.ts` (`headerOf` dùng `.map` trên mảng thưa), `src/lib/orders/normalize.ts` (`canonicalHeaders`) | Dùng `Array.from(values, ...)` hoặc `h ?? ""` trước khi trim |
| 2 | Body JSON hỏng / `postBatchId` không phải số → `/api/unpost`, `/api/unbuild` chạy thật trên toàn bộ dữ liệu | `src/lib/api.ts` (`jsonBody`, `int`, `bool`) | Ném `BadRequestError` khi JSON hỏng hoặc tham số sai kiểu |
| 3 | Build theo 1 ComCode có thể xóa event chưa post của ComCode khác cùng `OrderId + ngày` (hoặc event ComCode cũ sau khi đổi gateway mapping) | `src/lib/services/build.ts` (load `existing` theo `SourceID`) | Thêm điều kiện ComCode khi load/xóa stale, hoặc xử lý đổi mapping có chủ đích |
| 4 | Event POSTED mà amount nguồn về 0 không báo `POSTED_SOURCE_CHANGED` | `src/lib/services/build.ts` | So sánh cả event POSTED không còn draft |
| 5 | Bulk post bổ sung sinh chứng từ mới trùng `PostingGroupKey` | `src/lib/engine/post.ts` | Chấp nhận (mỗi batch 1 chứng từ) hoặc gom vào chứng từ cũ |
| 6 | `hasAccount` không xét `CoA.Status` (TK inactive vẫn qua) | `src/lib/engine/masters.ts` | Chỉ nạp TK `Status = Active` |
| 7 | `NegativeMode` lạ → SIGNED; `RateType` khác `DIV` → MUL, không báo lỗi | `src/lib/engine/post.ts`, `src/lib/engine/resolve-fx.ts` | Validate khi parse master |
| 8 | Unbuild lọc raw theo `RawOrders.ComCode` đã lưu, Build lọc theo mapping hiện tại → lệch khi mapping đổi | `src/lib/services/clear.ts`, `src/lib/services/build.ts` | Thống nhất 1 cách xác định ComCode |
| 9 | Exception POST mồ côi sau rebuild/Unbuild; Unbuild có scope không xóa exception ComCode/Period null | `src/lib/services/build.ts`, `src/lib/services/clear.ts` | Xóa exception theo event bị xóa |
| 10 | `parseDate` fallback lỏng đổi ISO có `Z` sang giờ máy chủ (có thể lệch ngày); không hỗ trợ `DD/MM/YYYY` | `src/lib/engine/parse.ts` | Parse UTC cho chuỗi có timezone; thêm tùy chọn định dạng khi import |
| 11 | `/api/orders`, `/api/exceptions` không validate/uppercase `comCode`, kỳ | route tương ứng | Dùng `parseScope` |
| 12 | `TYPE_DOCS` thiếu `UNKNOWN_AMOUNT_SOURCE` | `src/app/exceptions/page.tsx` | Bổ sung mô tả |
| 13 | Response Build FAILED có thể báo số event tạo/thay khác 0 dù đã rollback | `src/lib/services/build.ts` | Reset bộ đếm khi lỗi |

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

# DEVELOPER GUIDE – Sky Finance Accounting Engine

> Tài liệu kỹ thuật cho người/AI tiếp tục phát triển hoặc fix bug. Viết tiếng Việt, giữ nguyên tên bảng/cột/hàm/file.
> **Quy tắc:** khi thay đổi hành vi code, cập nhật mục tương ứng trong file này cùng lúc.
> Tài liệu nghiệp vụ gốc (yêu cầu tổng thể, chưa làm hết): [`tai lieu du an.md`](../tai%20lieu%20du%20an.md).
> Đặc tả nghiệp vụ tổng thể (BA) cho cả 4 nguồn, có sơ đồ luồng: [`BA_ACCOUNTING_ENGINE.md`](Docs-BA/BA_ACCOUNTING_ENGINE.md).

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
| Chống ghi sổ trùng (Build / Post / Import / Unbuild) | §6.1, §6.2, §6.3, §6.4; PayPal/Stripe/PIPO: §6.11.6 | `src/lib/engine/reconcile-events.ts`, `src/lib/engine/post-guard.ts`, `src/lib/services/import-source.ts`, `src/lib/services/clear.ts` |
| Lỗi import file / parse số / ngày | §6.1, §12 | `src/lib/services/import-orders.ts`, `src/lib/io/read-table.ts`, `src/lib/orders/normalize.ts`, `src/lib/engine/parse.ts` |
| Seller không map được | §6.2, §5 | `src/lib/engine/resolve-partner.ts` |
| Unpost / Unbuild sai | §6.4 | `src/lib/services/clear.ts` |
| Khóa kỳ kế toán, thao tác bị bỏ qua / từ chối vì kỳ khóa, sửa dữ liệu kỳ đã khóa | §6.12 | `src/lib/engine/period-lock.ts`, `src/lib/services/periods.ts`, `src/lib/services/common.ts` (`loadPeriodLocks`, `notLocked`) |
| Thêm cột / đổi schema | §4, §11.2 | `src/lib/db/schema.ts`, `drizzle/` |
| Thêm nguồn PayPal/Stripe/PIPO | §11.1 | — |
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
- **3 nguồn ngoài Orders** end-to-end (§6.11): PayPal, Stripe, PIPO — Import → Build → Post → Unpost/Unbuild theo nguồn.
- **Kỳ kế toán & khóa sổ** (§6.12): khóa/mở khóa theo công ty × tháng (trang `/periods`, có lịch sử); kỳ LOCKED chặn Import, Build, Post, Unpost, Unbuild và "Xóa dữ liệu test".

### 1.2 Chưa làm (theo `tai lieu du an.md`)
Auth/phân quyền (§20), Company tree (§4), trạng thái kỳ đóng vĩnh viễn (CLOSED, chờ có đăng nhập — §6.12.8), Manual Entry (§6), ExchangeRateResolveRule dạng Daily (§11 – hiện chỉ theo kỳ), PartnerSourceMapping riêng, Operation Audit Log (ngoài lịch sử khóa kỳ), dashboard nâng cao.

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
| `npm run db:seed` | Nạp lại master từ `data/seed/*.csv`: thay toàn bộ 6 bảng sheet; Company & GatewayCompanyMapping thêm/cập nhật, không xóa dòng chỉ có trong DB (§5.3) |
| `npm run db:export-seed` | Ghi Company & GatewayCompanyMapping trong DB ra `data/seed/company.csv`, `gateway-company-mapping.csv` (sau khi sửa trên web, để commit sang máy khác) |
| `npm run db:clear` | Xóa dữ liệu giao dịch (raw, event, GL, batch, exception), giữ master và bảng kỳ kế toán, rồi VACUUM. **Còn kỳ LOCKED → từ chối**, in `Không xóa: …`, thoát mã 1 (§6.12) |
| `npm run db:reset` | Xóa `data/finance.db*` (phải tắt dev server trước trên Windows). Mất luôn trạng thái kỳ + lịch sử khóa (§13.3) |

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
  seed/*.csv                      Snapshot 6 sheet master + company.csv, gateway-company-mapping.csv (seed DB)
  samples/order-data.csv          File order thật 55.112 dòng (dùng cho test)
  samples/Bank_{Paypal,Stripe,Pipo}.csv
                                  File thật của 3 nguồn ngoài Orders (142.659 / 1.413 / 952 dòng)
  samples/*-reference.csv         Mẫu GlTrans/AccountingEvent/PostingBatch từ hệ thống cũ để đối chiếu format
  finance.db                      SQLite (gitignore, tự tạo)
drizzle/                          Migration SQL (0000_init.sql … 0004_slippery_tigra.sql = 2 bảng kỳ kế toán) + meta
scripts/seed.ts, export-seed.ts, clear-db.ts, reset-db.ts
                                  Script npm db:seed / db:export-seed / db:clear / db:reset
src/
  app/
    layout.tsx                    AntdRegistry + AppShell
    globals.css
    page.tsx                      Dashboard
    raw/orders/page.tsx           1. Raw Orders
    raw/[source]/page.tsx         1b-1d. Raw PayPal / Stripe / PIPO (1 trang động)
    events/page.tsx               2. AccountingEvent
    posting/page.tsx              3. Posting
    gl/page.tsx                   4. GLTrans
    exceptions/page.tsx           Exceptions
    periods/page.tsx              Kỳ kế toán: ma trận công ty × kỳ, khóa / mở khóa, lịch sử (§6.12, §8.4)
    master/page.tsx               Master data
    api/**/route.ts               31 route handler (§7)
  components/
    AppShell.tsx                  Layout + menu + ConfigProvider vi_VN
    client.ts                     useApi, getJson/postJson/deleteJson, toQuery, useOptions, money
    ui.tsx                        columnsOf, FieldTitle, StatusTag, ScopeBar, LockedPeriodsAlert
  lib/
    api.ts                        handle(), ok/fail, parseScope, paging, str/int/bool, xlsxResponse
    errors.ts                     BadRequestError (→ HTTP 400)
    field-docs.ts                 Giải thích cột GLTrans/AccountingEvent/PostingBatch/AccountingPeriod(+Log) (tooltip), PERIOD_RULES – client-safe
    gl-columns.ts                 Thứ tự cột GLTrans/AccountingEvent – client-safe
    gl-filter.ts                  URLSearchParams → GlFilter
    db/schema.ts                  Drizzle schema 20 bảng + type
    db/client.ts                  getDb() (migrate + seed lần đầu), closeDb, DB_FILE
    db/seed.ts                    replaceMasters, seedMastersIfEmpty, readSnapshotTexts, read/upsert/writeCompanySnapshot
    engine/
      parse.ts                    parseNumber, parseDate, parseDateTime, toText, toFlag, isBlank, nowIso
      keys.ts                     ymd, periodOf, orderTransactionId, orderSourceId, singleDocNum, bulkDocNum, postingGroupKey, eventKey, sha256
      masters.ts                  Masters, MasterIndex, parsePartnerRule, accountFromSource
      resolve-partner.ts          resolveFixedPartner, resolveSeller, resolvePartnerByCode
      resolve-fx.ts               resolveFx, applyFx
      build-orders.ts             buildOrderEvents, orderRowsInScope + hằng ORDER_JOURNAL_TYPE_CODES
      build-bank.ts               buildBankEvents, BankSourceSpec, amountFromSource — engine chung 3 nguồn ngoài Orders (§6.11)
      sources/*.ts                Khai báo từng nguồn paypal/stripe/pipo (đọc cột nào, lọc gì, tiền ở đâu)
      reconcile-events.ts         reconcileEvents (đối chiếu draft với event trong DB → insert/replace/xóa/chặn ghi sổ trùng; bỏ qua kỳ khóa qua `isLocked`)
      period-lock.ts              Kỳ kế toán (§6.12): lockKey, PeriodLocks, orderRowRefs, LockTally, lockMsg, resolveLockTargets,
                                  pendingIssues, isValidPeriod, actorError, unlockReasonError, laterLockedPeriods, isBalanced
      post.ts                     classifyOf, expandEvent, postEvents, assertBalanced
      post-guard.ts               findDuplicateItems (chốt chặn lúc Post: item đã/đang ghi sổ dưới khóa khác)
      types.ts                    ExceptionType, ExceptionDraft, EventDraft, GlLineDraft
    io/read-table.ts              readTable (CSV/XLSX → records)
    master/sources.ts             ID Google Sheet + gid, LOCAL_MASTER_FILES (tên file snapshot Company/Gateway)
    master/parse-master.ts        Parse CSV 8 bảng master
    orders/columns.ts             46 cột file order – client-safe
    orders/normalize.ts           canonicalHeaders, normalizeOrderRow
    sources/columns.ts            Cột 5 sheet ngoài Orders, SOURCE_META, SHEET_COLUMNS, canonicalHeaderMap – client-safe
    sources/normalize.ts          normalize{Paypal,Stripe,Pipo}Row
    sources/route-params.ts       parseSourceKey (tham số [source] sai → 400)
    services/
      common.ts                   Scope, loadMasterIndex, scopeWhere, chunk, insertExceptions, deleteExceptionsByKeys, deleteExceptionsByDataSource,
                                  loadPeriodLocks, notLocked, lockedWhere, replaceLockSummaries, periodOfDateColumn
      import-orders.ts            importOrders
      import-source.ts            importSourceFile (chung cho 3 nguồn)
      build.ts                    runBuildOrders
      build-source.ts             runBuildSource, SOURCE_DATA_SOURCES, resetSourceRawStatus, countBuiltSourceRows, countLockedSourceRows
      post.ts                     runPost
      clear.ts                    unpost, unbuild, resetTransactionalData
      periods.ts                  listPeriodGrid, aggregate, lockPeriods, unlockPeriod, listPeriodLog, lockedPeriodSummary (§6.12)
      queries.ts                  list*/detail/dashboard/options/listMaster
      export.ts                   glWorkbook, eventsWorkbook
      master.ts                   syncMastersFromGoogleSheet, upsertGatewayMapping, deleteGatewayMapping, upsertCompany
tests/
  helpers/fixtures.ts             loadMasters, loadIndex, loadSampleOrders (memo hóa), loadSample{Paypal,Stripe,Pipo},
                                  scenarioRows/scenarioRecords (tập con kịch bản), toCsv/oneRowCsv, toEventRows
  engine/parse.test.ts
  engine/build-orders.test.ts
  engine/post.test.ts
  engine/reconcile-events.test.ts Build lại: chống ghi sổ trùng theo item khi khóa event đổi, đổi ngày giao, đơn nhiều cổng, phạm vi ComCode;
                                  nhóm "khóa sổ" (isLocked); dòng ngân hàng bị phân loại lại sau khi post (oneEventSetPerSource)
  engine/period-lock.test.ts      Quy tắc kỳ kế toán: chuẩn hóa khóa, PeriodLocks, orderRowRefs, LockTally, resolveLockTargets, pendingIssues
  engine/post-guard.test.ts       Chốt chặn ghi sổ trùng lúc Post
  integration/flow.test.ts        Cả luồng trên DB tạm
  integration/gateway-remap.test.ts Đổi GatewayCompanyMapping sau khi post → chặn → Unpost → Build → Post
  engine/build-bank.test.ts       3 nguồn ngoài Orders: map JournalType, resolve tài khoản 3 tầng, dấu tiền
  integration/bank-sources.test.ts Import 5 sheet → Build → Post → Unpost/Unbuild theo nguồn
  integration/bank-unbuild.test.ts Unbuild ngân hàng giữ BUILT dòng còn event POSTED (bug cũ §13.3 #21), Import chặn, để trống ô nguồn
  integration/posted-guards.test.ts Đơn 2 cổng đổi 1 cổng; import lại đổi ngày giao sau khi gỡ mapping
  integration/period-lock.test.ts Kỳ khóa: Import/Build/Post/Unpost/Unbuild/Xóa dữ liệu test không đổi dữ liệu kỳ khóa
  integration/periods.test.ts     Service + route kỳ kế toán: lưới, khóa, mở khóa, lịch sử, việc dở
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
| `BUILT` | Dòng đã được dùng để sinh event (kể cả khi mọi amount = 0) | Unbuild → NOT_BUILT, trừ dòng còn nằm trong event không bị xóa (POSTED, kỳ khóa…, §6.4). Import lại dòng thay đổi bị chặn |
| `SKIPPED` | Không FULFILLED / thiếu FulfilledAt (`BuildMessage` ghi lý do) | Build lại, import lại |
| `ERROR` | Thiếu ComCode mapping / Company | Sửa master → Build lại |

### 3.3 `AccountingEvent.PostStatus` + `ErrorStage`

| PostStatus | ErrorStage | Nguồn gốc | Post có lấy? | Cách xử lý |
|---|---|---|---|---|
| `NEW` | null | Build thành công | Có | — |
| `ERROR` | `BUILD` | Build: không map được seller (`MISSING_PARTNER`); hoặc item của event đã POSTED dưới khóa khác, kể cả dòng ngân hàng đã POSTED bị phân loại lại sang JTC khác (`POSTED_KEY_CHANGED`, §6.11.6); hoặc item còn nằm trong event (mọi trạng thái) thuộc kỳ đã khóa sổ (`PERIOD_LOCKED`, §6.12) | **Không** | Seller: sửa Partners → Build lại (event được replace). Khóa đổi: Unpost ComCode + kỳ cũ (nêu trong message) → Build → Post. Kỳ khóa: mở khóa kỳ nêu trong message → Unpost/Unbuild kỳ đó → Build + Post → khóa lại |
| `ERROR` | `POST` | Post: thiếu rule/TK/tỷ giá/CoA, amount âm với ERROR; item trùng event khác ngày giao/công ty hoặc event chưa có ItemCodes (`DUPLICATE_ITEM`) | **Có** (retry mỗi lần Post) | Sửa master → Post lại. `DUPLICATE_ITEM`: Build lại (§6.3) |
| `SKIPPED` | `POST` | Post: amount × factor = 0 hoặc TK null có cờ Skip | Không | Unbuild/Build nếu cần |
| `POSTED` | null | Post thành công, có `PostedDocNum`, `PostBatchID`, `PostedAt`, `PostingGroupKey` (Bulk) | Không | Unpost → NEW |

### 3.4 Batch

| Bảng | Status |
|---|---|
| `ImportBatch` | `SUCCESS` (không lỗi) · `PARTIAL` (có lỗi nhưng có dòng thành công/skip) · `FAILED` (thiếu cột bắt buộc hoặc toàn lỗi). Tạm `RUNNING` trong transaction. Dòng bị từ chối vì kỳ khóa tính là lỗi |
| `BuildBatch` | `RUNNING` → `SUCCESS` / `FAILED`. Bỏ qua phần kỳ khóa vẫn là `SUCCESS` |
| `PostingBatch` | `RUNNING` → `SUCCESS` / `FAILED`; `UNPOSTED` khi Unpost xóa hết dòng GL của batch (batch còn dòng GL của kỳ khóa giữ `SUCCESS`). Không tạo batch nếu không có event (`NOTHING_TO_POST` chỉ có trong response) |

### 3.5 `AccountingPeriod.Status` (§6.12)

| Giá trị | Ý nghĩa | Chuyển sang |
|---|---|---|
| `OPEN` | Mặc định — **không có dòng** cũng là OPEN. Mọi thao tác chạy bình thường | Khóa (trang `/periods`, bắt buộc tên người khóa) → `LOCKED` |
| `LOCKED` | Đã khóa sổ công ty × tháng: Import từ chối dòng của kỳ; Build/Post/Unpost/Unbuild bỏ qua và báo số lượng; "Xóa dữ liệu test" bị từ chối | Mở khóa (bắt buộc tên + lý do ≥ 10 ký tự) → `OPEN` |

Mỗi lần chuyển ghi 1 dòng `AccountingPeriodLog` (`Action` LOCK/UNLOCK). Chưa có trạng thái đóng vĩnh viễn.

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
| `MappingBankAccount` | `ID` auto | `ComCode`, `BankAccountNumber`, `InputCurr`, `GLAccountCode`, `BankName`, `IsActive`. Orders không dùng; 3 nguồn còn lại dùng để resolve tài khoản ngân hàng/PSP (§6.11) |
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

> Tên cột của 4 bảng raw mới giữ **đúng header sheet**, kể cả khoảng trắng (`Transaction ID`, `Time Zone`, `invoiceId (metadata)`) và typo `BankAccoutNumber`. Trong TypeScript chúng có tên thuộc tính gọn hơn (`TransactionID`, `TimeZone`, `MetaInvoiceId`) — xem `src/lib/db/schema.ts`.
> `ComCode` của các bảng này lấy **thẳng từ cột ComCode trên file** (khác Orders — Orders suy từ `PaymentGatewayName`).

**Engine**

| Bảng | Khóa | Ghi chú |
|---|---|---|
| `BuildBatch` | `BuildBatchID` | Scope + `SourceRows`, `EventsCreated`, `EventsReplaced`, `EventsError`, `SkippedRows` |
| `AccountingEvent` | `AccountingEventID`; **unique `UX_AccountingEvent_Key` (ComCode, DataSource, JournalTypeCode, TransactionID, EventSeq)** | Đủ cột sheet AccountingEvent + `ErrorStage`, `BuildBatchID`, `ItemCodes` (JSON mảng ItemCode tạo nên event, NULL với event tạo trước migration `0001`). Index `PostStatus`, `PostedDocNum`, (`DataSource`,`SourceID`), (`DataSource`,`OrderID`) |
| `PostingBatch` | `PostBatchID` | Cột sheet Postingbatch + `PostedEvents`, `ErrorEvents`, `SkippedEvents` |
| `GLTrans` | `ID` | Đúng 33 cột sheet GlTrans. Index `DocNum`, `PostBatchID`, (`ComCode`,`Period`) |
| `ExceptionLog` | `ID` | `BatchType` (IMPORT/BUILD/POST), `BatchID` (null với tóm tắt INFO `PERIOD_LOCKED` của Post — §6.12.5), `DataSource`, `ComCode`, `Period`, `Severity` (INFO/WARNING/ERROR), `ExceptionType`, `SourceKey`, `Message`, `CreatedAt` |

**Kỳ kế toán** (trạng thái vận hành: không nằm trong Google Sheet hay `data/seed`, Sync và "Xóa dữ liệu test" không đụng tới — §6.12)

| Bảng | Khóa | Ghi chú |
|---|---|---|
| `AccountingPeriod` | PK (`ComCode`, `Period`) | `Status` OPEN/LOCKED (mặc định OPEN; **không có dòng = OPEN**), `LockedBy`, `LockedAt`, `UnlockedBy`, `UnlockedAt`, `UnlockReason`, `Note` (ghi chú lúc khóa), `ModifiedDate`. Index `Status`. Dòng chỉ được tạo khi khóa lần đầu (upsert), không bao giờ bị xóa |
| `AccountingPeriodLog` | `ID` auto | **Chỉ thêm**: `ComCode`, `Period`, `Action` (LOCK/UNLOCK), `FromStatus`, `ToStatus`, `ActorName`, `Reason` (ghi chú khi khóa / lý do khi mở), `ChecksSnapshot` (JSON việc dở lúc thao tác), `CreatedAt`. Index (`ComCode`, `Period`) |

Không có foreign key; liên kết qua giá trị:

| Từ | Sang | Ghi chú |
|---|---|---|
| `GLTrans.DocNum` | `AccountingEvent.PostedDocNum` | Liên kết chính GL ↔ event. Bulk: nhiều event 1 DocNum |
| `GLTrans.PostingGroupKey` | `AccountingEvent.PostingGroupKey` | Chỉ Bulk; Single để null |
| `GLTrans.ReferenceTxnID` | `AccountingEvent.TransactionID` | Chỉ Single; Bulk để null |
| `AccountingEvent.OrderID` + `PostingDate` | `RawOrders.OrderId` + `FulfilledAt` | Cách join thực tế ở `eventDetail`/`glDocumentDetail` |
| `AccountingEvent.ItemCodes` (JSON) | `RawOrders.ItemCode` (unique) | **n-n**, liên kết event → dòng raw duy nhất được vật chất hóa; truy vấn bằng `json_each`. Chỉ Orders dùng; 3 nguồn kia để null |
| `AccountingEvent.SourceID` = `{DataSource}\|{SourceKey}` | `RawPaypal/RawStripe/RawPipo.SourceKey` | Liên kết event → dòng raw của các nguồn ngoài Orders (1 dòng raw ⇄ 1 bộ event) |
| `RawOrders.ImportBatchID` | `ImportBatch.ImportBatchID` | |
| `AccountingEvent.BuildBatchID` / `PostBatchID` | `BuildBatch` / `PostingBatch` | `PostBatchID` về null khi Unpost |
| `GLTrans.PostBatchID` | `PostingBatch.PostBatchID` | notNull |
| `ExceptionLog.BatchType` + `BatchID` | `BuildBatch` / `PostingBatch` | Polymorphic; `IMPORT` chưa có caller |
| `AccountingPeriod` (`ComCode`, `Period`) | `AccountingEvent`, `GLTrans`, `ExceptionLog` (`ComCode`, `Period`); `RawOrders` (`ComCode` đã lưu **và** ComCode theo mapping hiện tại, kỳ của `FulfilledAt`); `RawPaypal/RawStripe/RawPipo` (`ComCode`, kỳ của `PostingDate`) | So khớp `UPPER(TRIM(ComCode))` + kỳ; ComCode hoặc kỳ trống → không thuộc kỳ nào, không bao giờ bị khóa (§6.12.2) |

Bảng tổng hợp 20 bảng (vai trò, khóa, bước ghi): [`BA_ACCOUNTING_ENGINE.md` mục 21](Docs-BA/BA_ACCOUNTING_ENGINE.md#21-bảng-dữ-liệu). Chuỗi tra cứu master: [`MAPPING_ORDERS_TO_GLTRANS.md` §12.1](Mapping/MAPPING_ORDERS_TO_GLTRANS.md).

### 4.3 Kết nối, migrate, seed
- `getDb()` (`src/lib/db/client.ts`): mở `DATABASE_PATH` hoặc `data/finance.db`, bật WAL, chạy `migrate()` với `drizzle/`, gọi `seedMastersIfEmpty()` (nếu `JournalType` rỗng → nạp snapshot 6 bảng sheet; bảng `Company`/`GatewayCompanyMapping` nào rỗng → nạp từ `company.csv`/`gateway-company-mapping.csv`; bảng đã có dữ liệu thì không đụng). Instance cache trên `globalThis.__financeDb` (sống qua HMR).
- **Đổi schema:** sửa `schema.ts` → `npm run db:generate` (tạo `drizzle/000X_*.sql`) → restart dev. Với dữ liệu test có thể `npm run db:reset`.
- Migration `0004_slippery_tigra.sql` tạo `AccountingPeriod` + `AccountingPeriodLog` (rỗng = mọi kỳ OPEN) — DB cũ tự nhận qua `getDb()`, không cần reset. `seedMastersIfEmpty` không nạp gì vào 2 bảng này.
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
Không có trong Google Sheet, sửa ở trang `/master`. Snapshot trong `data/seed` (`LOCAL_MASTER_FILES`) là dữ liệu thật xuất từ DB, không phải giá trị mặc định:
- `company.csv`: `ComCode, CompanyName, FunctionalCurrency, IsActive`. Snapshot 2026-09-22: `ZENIROXPAY`, `MESSIPAY` USD · `ONTARIO` CAD · `VICBEA` VND.
- `gateway-company-mapping.csv`: `PaymentGatewayName, ComCode, IsActive` theo thứ tự ID (DB mới được ID 1..n đúng thứ tự file). 24 cổng; `ZeniroxPay Inc.` và `ZeniroxPay - Stripe` → `ZENIROXPAY` (user đã chốt: company = cổng thanh toán).
- Parse (`parseCompanies`, `parseGatewayMappings`): `ComCode`/`FunctionalCurrency` viết hoa như `upsertCompany`, tiền tệ trống → `USD`, bỏ dòng thiếu khóa; file không còn dòng hợp lệ → throw.
- **Chuyển sang máy khác:** sửa trên web → `npm run db:export-seed` → commit 2 file → máy kia `git pull` + `npm run db:seed` (DB mới thì `npm run dev` tự nạp).
- `upsertCompanySnapshot` (dùng bởi `db:seed`) thêm mới hoặc cập nhật theo `ComCode` / `PaymentGatewayName` trong 1 transaction, **không xóa** dòng chỉ có trong DB. Dòng trùng khóa bị đè bằng giá trị trong file → sửa trên web mà chưa export thì `db:seed` trả về giá trị cũ. Muốn bỏ 1 cổng ở máy khác thì xóa trên web máy đó.
- Đổi `FunctionalCurrency` của công ty đã có event (vd. máy cũ có `ONTARIO` USD, snapshot là CAD): event chưa post nhận `FncCurr` mới ở lần Build sau; event **đã post giữ `FncCurr` cũ mà Build không báo gì** (`FncCurr` không nằm trong `eventKey`/`SourceHash`) → muốn quy đổi lại phải Unpost → Build → Post phạm vi công ty đó (§6.4).
- Test không dùng snapshot này mà dùng bộ cố định `TEST_COMPANIES`/`TEST_GATEWAY_MAPPINGS` (§10.1).

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
- **UI:** `/raw/orders` – `Upload.Dragger` (customRequest gửi FormData), modal kết quả, tab Raw orders (lọc search/ComCode/ItemStatus/BuildStatus, phân trang server), tab Lịch sử import (mở rộng xem `ErrorDetails`).
- **API:** `POST /api/orders/import` (multipart field `file`).
- **Service:** `importOrders(buffer, fileName)` – `src/lib/services/import-orders.ts`.

**Xử lý:**
1. `readTable` (`src/lib/io/read-table.ts`): `.csv/.txt` → papaparse (header, bỏ dòng trống, bỏ BOM); `.xlsx` → exceljs, chọn sheet đầu tiên có header `OrderId` (không có thì sheet đầu), header ở dòng 1, bỏ dòng rỗng; giá trị ô: hyperlink → text, richText → nối text, formula → result, Date giữ nguyên. Đuôi khác → `BadRequestError`.
2. `canonicalHeaders` (`src/lib/orders/normalize.ts`): map header không phân biệt hoa thường/khoảng trắng về 46 tên chuẩn. Thiếu cột bắt buộc (`REQUIRED_ORDER_COLUMNS`: OrderId, ItemCode, ItemStatus, Quantity, UnitPrice, PaymentGatewayName) → tạo ImportBatch `FAILED`, không ghi dòng nào.
3. `normalizeOrderRow`: cột `number` → `parseNumber`; `date` → `parseDate` (không parse được thì giữ text); `datetime` → `parseDateTime`; `text` → `toText`. Lỗi dòng: thiếu OrderId/ItemCode; `FulfilledAt` có giá trị nhưng không parse được. `RowHash = sha256(dòng đã chuẩn hóa)`.
4. Trong 1 transaction, theo `ItemCode`:
   - Trùng trong cùng file → lỗi dòng.
   - Chưa có → insert, `ComCode = comCodeOfGateway(PaymentGatewayName)`, `BuildStatus = NOT_BUILT`.
   - Có rồi, `RowHash` giống → **bỏ qua** (SkippedRows) — kể cả khi dòng thuộc kỳ khóa.
   - **Kỳ khóa sổ (§6.12)** — kiểm tra ngay sau bước trên, trước mọi nhánh dưới (kỳ khóa đọc bằng `loadPeriodLocks(tx)` trong cùng transaction). Dòng mới hoặc dòng thay bị **lỗi** `"Dòng thuộc X kỳ P đã khóa sổ → không nhận…"` (`lockMsg.importRow`) khi một trong các cặp sau đang LOCKED:
     - giá trị mới: ComCode theo gateway của dòng mới × kỳ `FulfilledAt` mới;
     - giá trị cũ (dòng đã có): ComCode theo mapping hiện tại của gateway cũ và `ComCode` đang lưu × kỳ `FulfilledAt` cũ (`orderRowRefs`).
     Dòng chưa giao (không `FulfilledAt`) không thuộc kỳ nào nên giá trị mới không bị chặn, nhưng vẫn không thay được dòng cũ đã giao trong kỳ khóa. Vì vậy dời ngày giao **ra khỏi** kỳ khóa cũng bị từ chối.
   - Có rồi, khác, `BuildStatus = BUILT` → **lỗi** "Unbuild trước khi import lại".
   - Có rồi, khác, chưa BUILT nhưng **ItemCode còn nằm trong AccountingEvent bất kỳ** (VD gateway bị gỡ mapping rồi Build → raw thành ERROR nhưng event POSTED được giữ; sau đó Unpost thì event thành NEW) → **lỗi**, message nêu event, ComCode, kỳ:
     - event POSTED: "Dòng đã ghi sổ (event …, POSTED) … → Unpost + Unbuild ComCode X kỳ P trước khi import lại";
     - event chưa post: "Dòng còn nằm trong AccountingEvent chưa post (…) … → Unbuild ComCode X kỳ P trước khi import lại".
     Event cũ chưa có `ItemCodes` thì coi là chứa item nếu cùng OrderId + ngày giao; message gợi ý Build lại trước (Build bổ sung `ItemCodes` cho event POSTED không đổi, §6.2) rồi import lại. Chặn đường đổi FulfilledAt/gateway trong khi event cũ còn ở khóa cũ → Build lại + Post sẽ ghi sổ trùng. Dòng `ERROR`/`SKIPPED` bình thường không có event nên không bị ảnh hưởng.
     Nếu một event chứa item nằm ở kỳ khóa thì event đó được báo trước (`lockMsg.importEvent`: "Dòng còn nằm trong event … thuộc X kỳ P đã khóa sổ → không cho thay. Muốn sửa: mở khóa …") và dòng tính vào `LockedRows`, vì lời khuyên Unpost/Unbuild không làm được khi kỳ còn khóa.
   - Có rồi, khác, chưa BUILT, item không nằm trong event nào → **update** (gán ImportBatchID mới, reset NOT_BUILT).
5. Response `ImportOrdersResult` (errors tối đa 200); `ImportBatch.ErrorDetails` lưu tối đa 500. `LockedRows` = số dòng bị từ chối vì kỳ khóa (dòng thuộc kỳ khóa + dòng có item trong event kỳ khóa), **là một phần của `ErrorRows`**; luôn có mặt (0 ở nhánh FAILED thiếu cột).

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
4. Transaction (đầu transaction đọc kỳ khóa `loadPeriodLocks(tx)` — §6.12; engine ở bước 3 vẫn chạy trên **mọi** dòng trong phạm vi, kể cả dòng kỳ khóa):
   - Load mọi event (mọi ComCode, mọi PostStatus) của các `OrderID` đang build **và** các đơn có event trong phạm vi build mà không còn dòng nào được build (dòng đã đổi ngày giao sang kỳ khác / đổi OrderId). Chia theo `SourceID`:
     - thuộc các dòng đang build → `existing` (thay thế / xóa / cảnh báo);
     - **SourceID đã chết** – không còn dòng raw nào (mọi kỳ, mọi ComCode) có SourceID đó → cũng vào `existing`: chưa post thì bị xóa, POSTED thì cảnh báo và dùng để chặn draft trùng item; thêm `{TransactionID}|{JTC}` của chúng vào tập khóa exception cần làm mới;
     - còn dòng raw nhưng ngoài phạm vi build → chỉ lấy event **POSTED** hoặc event **thuộc kỳ khóa ở mọi trạng thái** (`relatedPosted`, để đối chiếu — event kỳ khóa không thay/xóa được nên item của nó cũng chặn draft trùng). Không kỳ nào khóa → y như cũ (chỉ POSTED).
   - Engine `reconcileEvents` (`src/lib/engine/reconcile-events.ts`) lập kế hoạch, service chỉ thực thi (nhận thêm `isLocked` — phần kỳ khóa xem §6.12.4):
     - Draft chưa có khóa → insert (`EventsCreated`).
     - Đã có & `POSTED` → giữ nguyên (`EventsUnchangedPosted`); nếu `SourceHash` khác → `POSTED_SOURCE_CHANGED` (WARNING).
     - Đã có & chưa POSTED → update toàn bộ, xóa thông tin post (`EventsReplaced`; **build lại luôn replace kể cả không đổi**).
     - **Chống ghi sổ trùng theo item:** khóa event (`ComCode|DataSource|JTC|TransactionID|EventSeq`) đổi sau khi post (đổi `GatewayCompanyMapping`, đổi `RuleSeq`/cách viết JTC, đổi ngày giao) thì draft mới không trùng khóa event POSTED cũ. Draft chưa POSTED bị **chặn** khi có event POSTED **cùng OrderID** (mọi ngày giao, kể cả khi cả 2 ngày giao cùng nằm trong lần build), khác khóa, cùng DataSource, **có ItemCode trùng** với draft, và: khác SourceID (item đã ghi sổ ở ngày giao khác); hoặc khác ComCode (item đã ghi sổ ở công ty khác — kể cả chỉ 1 phần đơn đổi công ty, kể cả khác JTC); hoặc cùng ComCode + cùng JTC và event POSTED đó không còn được sinh ra (đổi RuleSeq). Build Orders **không** truyền `oneEventSetPerSource` (chỉ nguồn ngân hàng bật, bỏ điều kiện cùng JTC ở vế cuối — §6.11.6), vì 1 SourceID (đơn + ngày giao) sinh 4 nghiệp vụ hợp lệ. Draft bị chặn vẫn được ghi nhưng `PostStatus = ERROR`, `ErrorStage = BUILD` (Post không lấy) + exception `POSTED_KEY_CHANGED` (ERROR) nêu event/DocNum cũ, phần khóa đổi, ComCode + kỳ cần Unpost, kỳ/ComCode mới cần Build/Post thêm (`EventsBlocked`). Sau khi Unpost, event cũ thành NEW và không còn sinh ra (khóa cũ không còn dòng nguồn) nên Build xóa nó → hết chặn, không ghi sổ trùng. Event NEW trùng lỡ tạo từ trước cũng chuyển ERROR. Không chặn: thêm rule mới khi rule đã post vẫn sinh ra; item mới của công ty khác trong đơn nhiều cổng (ItemCode không trùng). Event POSTED cũ chưa có `ItemCodes` (tạo trước migration `0001`): nếu có draft cùng khóa và cùng `SourceHash` (hash đã gồm danh sách item) → ghi bổ sung `ItemCodes` (`healItemCodes`, không đổi `ModifiedDate`), từ đó xử lý như event mới; còn lại coi là trùng item khi cùng SourceID mà đã đổi (không còn sinh ra hoặc SourceHash khác), hoặc SourceID của nó đã chết — thận trọng, có thể chặn thừa, message ghi rõ "tạo trước khi có cột ItemCodes".
     - Event POSTED không còn được sinh ra và không bị draft nào thay chỗ (số tiền về 0, rule tắt, gateway/Company mất mapping, dòng đổi ngày giao sang kỳ ngoài phạm vi build) → giữ nguyên + `POSTED_SOURCE_CHANGED` (WARNING).
     - Event cũ chưa POSTED không còn được sinh ra (kể cả của SourceID đã chết) → **xóa** (`EventsRemoved`).
     - SQL replace / remove / heal `ItemCodes` thêm `notLocked(AccountingEvent.ComCode, Period)` — chốt thứ 2, không bao giờ sửa/xóa event kỳ khóa dù plan có lỗi.
   - Cập nhật `RawOrders.BuildStatus/BuildMessage/ComCode` cho mọi dòng đã xử lý, **trừ** dòng mà ComCode theo mapping hiện tại hoặc `ComCode` đang lưu × kỳ `FulfilledAt` bị khóa (`orderRowRefs`) → giữ nguyên, đếm `LockedRows`.
   - Xóa exception BUILD cũ theo tập SourceKey có thể sinh ra từ các dòng đã xử lý (ItemCode, `{TransactionID}|{JTC}` — JTC luôn viết hoa, các JTC, `{JTC}|{RuleSeq}`), rồi insert exception mới. Vì build trọn đơn nên exception của mọi ComCode trong đơn được làm mới cùng lúc. Kỳ khóa: exception cũ có (ComCode, Period) khóa **giữ nguyên** (`deleteExceptionsByKeys(…, locks)`), exception mới thuộc kỳ khóa **không ghi**; ERROR `PERIOD_LOCKED` của plan gắn với draft kỳ mở nên luôn ghi. Cuối cùng `replaceLockSummaries` thay tóm tắt INFO `PERIOD_LOCKED` (§6.12.5).
5. Transaction commit xong mới gán bộ đếm (`EventsCreated/Replaced/Removed/Blocked`; `EventsError` = số event ghi vào DB với PostStatus ERROR; `Exceptions` = số exception **thực ghi**, gồm cả tóm tắt INFO `PERIOD_LOCKED` — không kỳ nào khóa thì bằng số cũ; `LockedSkipped`, `LockedConflicts`, `LockedRows`, `LockedPeriods` — §6.12.3) → BuildBatch SUCCESS. Lỗi giữa chừng → rollback, BuildBatch FAILED + ErrorMessage, bộ đếm event giữ 0.

**Test:** `tests/engine/build-orders.test.ts`, `tests/engine/reconcile-events.test.ts` (kể cả nhóm "khóa sổ"), `tests/integration/gateway-remap.test.ts`, `tests/integration/posted-guards.test.ts`.

### 6.3 Post Single / Bulk

- **Mục đích:** AccountingEvent → GLTrans (tài liệu gốc §9).
- **UI:** `/posting` – Post tất cả (Single rồi Bulk), Post Single, Post Bulk, Unpost theo phạm vi; bảng PostingBatch với "Xem GL" (`/gl?postBatchId=`) và "Unpost batch".
- **API:** `POST /api/post` body `{classify: "Single"|"Bulk"|"All" (mặc định All), comCode?, periodFrom?, periodTo?, dataSource?}` → `PostSummary[]`.
- **Service:** `runPost(classify, scope)` – `src/lib/services/post.ts`.
- **Engine:** `src/lib/engine/post.ts`.

**Service:** `runPost` đọc master (`loadMasterIndex`) và kỳ khóa (`loadPeriodLocks`) **1 lần** cho cả Single lẫn Bulk. Có kỳ khóa → thêm 1 câu GROUP BY đếm event chờ post thuộc kỳ khóa theo DataSource × JTC × ComCode × kỳ, phân loại bằng `classifyOf` (nhóm Classify null bị bỏ — vốn không bao giờ post được): `PostSummary.LockedEvents` / `LockedPeriods` chỉ tính loại đang chạy; `LockTally` đếm cả 2 loại để "Post Single" không xóa mất tóm tắt event Bulk (§6.12.5). Rồi với từng loại:

1. Candidate = event trong scope có `PostStatus = NEW` **hoặc** (`ERROR` và `ErrorStage = POST`) (`pendingWhere()`), **không thuộc kỳ khóa** (`notLocked`), rồi lọc `classifyOf(index, e) === classify` (Classify lấy từ JournalType theo DataSource+JTC; **JournalType không có Classify thì event không bao giờ được post**). 1 chứng từ (DocNum) luôn thuộc đúng 1 công ty × 1 kỳ (Single = 1 event; Bulk gom theo `ComCode` + ngày `yyyyMMdd`) nên lọc theo event là đủ, không bao giờ post dở 1 chứng từ.
2. Không có candidate → trả `Status: NOTHING_TO_POST`, không tạo batch (vẫn có `LockedEvents`/`LockedPeriods`).
3. Tạo `PostingBatch` RUNNING (`ComCodeList` = scope hoặc danh sách ComCode của event; `PeriodFrom/To` = scope hoặc min/max).
4. **Chốt chặn ghi sổ trùng** – engine `findDuplicateItems` (`src/lib/engine/post-guard.ts`), so candidate với mọi event cùng `OrderID` (mọi PostStatus, kể cả ngoài scope). Một item chỉ thuộc 1 ngày giao và 1 công ty, nên candidate bị giữ lại (thành `ERROR`/`POST` + exception `DUPLICATE_ITEM`, tính vào `ErrorEvents`) khi:
   - có item trùng với event **POSTED** khác SourceID hoặc khác ComCode;
   - có item trùng với event khác **cũng đang chờ post** (NEW, ERROR/POST) khác SourceID hoặc khác ComCode → giữ cả hai;
   - là event Orders chưa có `ItemCodes` (tạo trước migration `0001`) → phải Build lại trước.
   Cùng SourceID + ComCode (nhiều JTC/rule của cùng đơn) là bình thường; event `ERROR/BUILD` (đã bị chặn) và `SKIPPED` không tính. Bình thường Build đã chặn/dọn hết nên bước này không giữ event nào; nó bảo vệ khi dữ liệu lệch mà chưa Build lại (dữ liệu từ phiên bản cũ, Post trước khi Build, sửa DB tay). Xử lý: Build lại phạm vi gồm cả event kia rồi Post. Truy vấn event đối chiếu ở bước này **không lọc kỳ khóa** → event kỳ khóa vẫn chặn candidate trùng item.
5. `postEvents(candidates còn lại, classify, index)`.
6. Transaction: insert GLTrans (chunk 200, gán `PostBatchID`, `AddDate`); update event POSTED theo từng DocNum; event lỗi → `ERROR`/`POST` + ErrorMessage; event bỏ qua → `SKIPPED`/`POST`; xóa exception POST cũ theo key `EventID {id} | {TransactionID}` của mọi candidate (giữ bản cũ còn gắn kỳ khóa) rồi insert mới; batch → SUCCESS (+ InsertedRows, PostedEvents, ErrorEvents, SkippedEvents).
7. Exception bất ngờ (VD chứng từ không cân) → rollback, batch FAILED.
8. Sau cả 2 loại: `replaceLockSummaries(tx, "POST", dataSource ? [dataSource] : null, scope, tally, null)` trong 1 transaction — chạy cả khi không bỏ qua gì để dọn tóm tắt cũ sau khi mở khóa.

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

`src/lib/services/clear.ts`. `unpost` và `unbuild` nhận `preview` → chỉ đếm, không sửa. `resetTransactionalData` không có preview (xóa ngay). Phần thuộc kỳ khóa sổ luôn **giữ nguyên** và chỉ được báo số lượng qua các trường `locked*` (§6.12.3); không kỳ nào khóa → điều kiện SQL y như cũ, các trường `locked*` = 0 / `[]`.

**`unpost({scope, postBatchId, preview})`** – `POST /api/unpost`
1. Tìm event `POSTED` trong scope (và `PostBatchID` nếu có), **không thuộc kỳ khóa** (`notLocked`) → tập `PostedDocNum`. Có kỳ khóa: 1 câu GROUP BY (DocNum, ComCode, Period) với `lockedWhere` đếm `lockedDocuments`, `lockedEvents`, `lockedPeriods`; DocNum nào có event kỳ khóa cũng bị loại khỏi danh sách unpost (chốt phụ — theo quy tắc 1 DocNum = 1 công ty × 1 kỳ thì không đổi kết quả) → không bao giờ xóa dở 1 chứng từ.
2. Mở rộng ra **toàn bộ chứng từ**: đếm mọi event POSTED có DocNum đó, dòng GL có DocNum đó, danh sách PostBatchID liên quan → `UnpostResult {events, glLines, documents, batches, lockedDocuments, lockedEvents, lockedPeriods}`.
3. Chạy thật: đọc kỳ khóa, chọn chứng từ và xóa nằm trong **1 transaction** (`$client.transaction`; gọi từ Unbuild thì thành savepoint). Xóa GLTrans theo DocNum; event → `NEW`, xóa `PostedDocNum/PostingGroupKey/PostBatchID/PostedAt/ErrorStage/ErrorMessage`; batch nào không còn dòng GL → `UNPOSTED` (còn dòng GL của kỳ khóa → giữ `SUCCESS`).
- Event `SKIPPED` hoặc `ERROR/POST` **không bị reset** bởi unpost.

**`unbuild({scope, includePosted, preview})`** – `POST /api/unbuild`
1. `includePosted = true` → chạy `unpost(scope)` trước (preview thì chỉ mô phỏng). Chạy thật: Unpost và các bước dưới nằm trong **1 transaction** (transaction con thành savepoint) → lỗi giữa chừng rollback cả phần Unpost, không để sổ bị gỡ mà event chưa xóa. Kỳ khóa đọc trong transaction đó. Điều kiện lọc raw dùng subquery trên `AccountingEvent` (không truyền danh sách OrderId làm tham số) nên không vướng giới hạn 32,766 biến SQL của SQLite ở dữ liệu lớn.
2. Xóa event trong scope có `PostStatus ≠ POSTED` (`deletedEvents`); `postedEventsKept` = số event POSTED còn lại. Kỳ khóa: `eventScope` thêm `notLocked` → event kỳ khóa (mọi trạng thái) không bị xóa, không tính vào `deletedEvents`/`postedEventsKept`, và được coi là "còn lại" ở bước 3 → raw của item giữ BUILT.
3. Raw về `NOT_BUILT` (BuildMessage null) nếu:
   - `BuildStatus ≠ NOT_BUILT`;
   - có scope ComCode: `RawOrders.ComCode` (giá trị đã lưu, không phải mapping hiện tại) = scope **hoặc null**, **hoặc** ItemCode nằm trong event bị xóa ở lần này (ComCode event khác raw khi mapping đã đổi);
   - kỳ `FulfilledAt` trong scope;
   - (`RawOrders.ComCode` đang lưu, kỳ `FulfilledAt`) **không** thuộc kỳ khóa;
   - ItemCode **không** còn nằm trong event nào không bị xóa ở lần này (event POSTED, event của ComCode/kỳ khác, event kỳ khóa). Event cũ chưa có `ItemCodes` → giữ BUILT cả đơn.
   Nhờ vậy dòng có item còn trong event (VD Unbuild ComCode mới sau khi đổi mapping, event chưa post của ComCode cũ vẫn còn) vẫn `BUILT`, import không thay được dòng đó.
4. Xóa `ExceptionLog` BatchType BUILD khớp `ComCode = scope` / `Period` trong scope (không scope → xóa hết BUILD), trừ exception thuộc kỳ khóa (kể cả tóm tắt INFO `PERIOD_LOCKED`). Có scope thì exception có ComCode/Period null (VD `MISSING_COMCODE`, lỗi cấu hình) **không bị xóa**; exception POST của event bị xóa **không bị dọn** (mồ côi).
5. **Để trống ô nguồn** (`scope.dataSource` rỗng; chọn `ORDERS` thì bỏ bước này): bước 2 đã xóa event chưa POSTED của **mọi** nguồn, nên nhánh này làm thêm cho từng nguồn PayPal/Stripe/PIPO, trong cùng transaction: `resetSourceRawStatus(tx, source, scope, locks)` (chỉ dòng không còn event nào — quy tắc của nhánh ngân hàng bên dưới) và `deleteExceptionsByDataSource(tx, "BUILD", DataSource, scope, locks)` (theo `DataSource` + ComCode, không theo kỳ — như nhánh ngân hàng, nên xóa cả exception gom nhóm `Period = null`). Preview đếm bằng `countBuiltSourceRows(…, survives)` với đúng `survives` của Orders; `rawRowsReset` = raw Orders + raw ngân hàng; `lockedRawRows` / `lockedPeriods` cộng thêm raw ngân hàng kỳ khóa (`countLockedSourceRows`, `lockedSourcePeriods`). Trước bản sửa, nhánh này chỉ reset `RawOrders` → raw ngân hàng giữ BUILT dù event của chúng đã bị xóa.
6. `UnbuildResult` thêm `lockedEvents` (event trong scope thuộc kỳ khóa, mọi trạng thái), `lockedRawRows` (raw đã build trong phạm vi raw thuộc kỳ khóa), `lockedPeriods` (hợp 2 nguồn trên, sort).

**Unbuild nguồn ngoài Orders:** khi `scope.dataSource` là `PAYPAL`/`STRIPE`/`PIPO`, `unbuild` đi nhánh riêng (`unbuildBankSource`) vì các nguồn này không dùng `ItemCodes` — 1 dòng raw ⇄ 1 bộ event, nối bằng `SourceID = {DataSource}|{SourceKey}`. Không đụng tới Orders hay các nguồn khác.
1. Xóa event chưa POSTED trong scope (`eventScope` = `scopeWhere` + `notLocked`, như Orders).
2. **Sau khi xóa**, `resetSourceRawStatus(tx, source, scope, locks)` đưa về NOT_BUILT dòng raw của đúng bảng đó trong phạm vi (ComCode đang lưu + kỳ `PostingDate`), không thuộc kỳ khóa, và **không còn event nào** cùng `DataSource` có `SourceID = {DataSource}|{SourceKey}` (`withoutEvents` trong `build-source.ts`: `NOT EXISTS` trên index `IX_AccountingEvent_Source`). Dòng còn event — POSTED được giữ (Unbuild không kèm Unpost), event kỳ khóa, event nằm ngoài phạm vi xóa — **giữ nguyên BuildStatus**, nên Import vẫn chặn sửa dòng đó (§6.11.6). Dòng BUILT không sinh event nào ("Không sinh event nào — mọi rule bị bỏ qua") vẫn được reset.
3. Xóa exception BUILD theo `DataSource` (+ ComCode): `deleteExceptionsByDataSource(…, locks)`.

Preview: `countBuiltSourceRows(db, source, scope, locks, survives)` đếm dòng đã build sẽ được reset; `survives` mô phỏng phần sắp xóa y như Orders (`removedNow` = event chưa POSTED trong `eventScope`; preview "Unpost + Unbuild" coi cả event POSTED trong phạm vi là bị xóa). Gọi không truyền `survives` (= `1 = 1`, mọi event còn trong DB) chỉ đúng **sau** khi đã xóa — đó là cách `resetSourceRawStatus` dùng. `countLockedSourceRows` cho `lockedRawRows`.

Trước bản sửa §13.3 #21, bước 2 reset **mọi** dòng raw đã build trong phạm vi, kể cả dòng còn event POSTED được giữ (`postedEventsKept`) → mất chốt Import; sửa tay `JournalType` rồi import + Build (JTC mới = khóa event mới, cùng SourceID + ComCode nên không bị chặn) + Post → ghi sổ trùng.

**`resetTransactionalData()`** – `POST /api/reset`, `npm run db:clear`: xóa `GLTrans, AccountingEvent, PostingBatch, BuildBatch, ExceptionLog, RawOrders, RawPaypal, RawStripe, RawPipo, ImportBatch` + reset `sqlite_sequence` (ID bắt đầu lại từ 1). Master và 2 bảng kỳ kế toán giữ nguyên. **Còn kỳ LOCKED → `BadRequestError`** (`lockMsg.resetRefused`: "Còn N kỳ đang khóa sổ (…) → mở khóa ở trang Kỳ kế toán trước khi xóa dữ liệu test"), kiểm tra trong cùng transaction với lệnh xóa: `/api/reset` trả 400, `db:clear` in `Không xóa: …` ra stderr và thoát mã 1.

**UI:** trang `/events` và `/posting` gọi API với `preview: true` trước, hiển thị `modal.confirm` kèm số lượng (và `LockedPeriodsAlert` "Giữ nguyên …" khi có phần kỳ khóa), bấm OK mới chạy thật. Mọi thứ trong phạm vi đều thuộc kỳ khóa → chỉ `message.warning`, không mở hộp xác nhận (§8.4). Xác nhận Unbuild có `postedEventsKept > 0` → Alert "{n} event đã POSTED sẽ giữ lại (cần Unpost trước); dòng raw của chúng giữ BUILT nên chưa import lại được".

**Test:** `tests/integration/flow.test.ts`; nhánh ngân hàng và để trống ô nguồn: `tests/integration/bank-sources.test.ts`, `tests/integration/bank-unbuild.test.ts`.

### 6.5 Run Accounting Cycle
`POST /api/cycle` (body scope) → `runBuildOrders(scope)`; nếu build SUCCESS → `runPost("All", scope)`. Response `{build, post}`. Nút "Chạy full cycle" trên Dashboard. Kỳ khóa không làm lệnh thất bại: Build bỏ qua phần kỳ khóa (vẫn SUCCESS), Post bỏ qua event kỳ khóa; Dashboard báo riêng `build.LockedSkipped` và Σ `post[].LockedEvents` (không cộng, vì 1 event NEW kỳ khóa có thể bị cả 2 bước đếm).

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

- **UI:** `/exceptions` – bảng tổng hợp (click để lọc), filter Bước/Mức/Type/ComCode/search, bảng chi tiết. Mô tả cách xử lý nằm trong hằng `TYPE_DOCS` của `src/app/exceptions/page.tsx`; filter Type lấy từ `Object.keys(TYPE_DOCS)` nên type thiếu mô tả (hiện là `INVALID_FULFILLED_DATE`, chưa dùng) không có trong filter.
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
| `POSTED_KEY_CHANGED` | BUILD | ERROR | `{TxnID}\|{JTC}` | Item của event đã POSTED dưới khóa khác (đổi GatewayCompanyMapping sang ComCode khác — cả khi chỉ 1 cổng của đơn nhiều cổng đổi, đổi RuleSeq, đổi ngày giao; nguồn ngân hàng: dòng đã POSTED ra JTC khác — §6.11.6) → event mới bị ghi ERROR/BUILD để không ghi sổ trùng (§6.2). Unpost theo ComCode + kỳ cũ nêu trong message → Build (toàn bộ, hoặc phạm vi gồm cả kỳ/ComCode mới nếu message ghi) → Post cả ComCode cũ và mới. Build xóa event cũ đã Unpost vì khóa cũ không còn sinh ra |
| `DUPLICATE_ITEM` | POST | ERROR | EventID | Chốt chặn lúc Post (§6.3): item của event đã POSTED hoặc đang chờ post ở event khác ngày giao / khác ComCode, hoặc event Orders chưa có `ItemCodes` → không post. Build lại (phạm vi gồm cả event kia) rồi Post |
| `PERIOD_LOCKED` | BUILD / POST | INFO | `PERIOD_LOCKED\|{DataSource}\|{ComCode}\|{Period}` | **Tóm tắt** phần Build (dòng nguồn, event) hoặc Post (event) bỏ qua vì công ty × kỳ đã khóa sổ; 1 dòng mỗi nguồn × công ty × kỳ, **thay mới mỗi lần chạy** (không cộng dồn); bản của Post có `BatchID` null. Bình thường, không cần xử lý. Mở khóa kỳ thì bị xóa (§6.12.5) |
| `PERIOD_LOCKED` | BUILD | ERROR | `{TxnID}\|{JTC}` | Draft ở kỳ **mở** đụng event thuộc kỳ khóa: cùng khóa event (nguồn ngân hàng đổi ngày ra khỏi kỳ khóa → không ghi) hoặc trùng item (Orders đổi ngày giao / đổi cổng → ghi ERROR/BUILD thay cho `POSTED_KEY_CHANGED`). Mở khóa kỳ nêu trong message (ghi lý do) → Unpost/Unbuild kỳ đó → Build + Post lại → khóa lại (§6.12.4) |
| `INVALID_FULFILLED_DATE` | — | — | — | **Khai báo nhưng chưa dùng** (import đang từ chối dòng thay vì ghi exception) |

- Chống nhân đôi: Build xóa exception BUILD cũ theo tập SourceKey mà lần build đó có thể sinh ra (gồm `{TxnID}|{JTC}` của event có SourceID đã chết); Post xóa exception POST cũ của **các candidate lần post đó**. Exception POST của event đã bị xóa (rebuild bỏ event stale, Unbuild) có thể còn sót lại. Exception có (ComCode, Period) thuộc kỳ khóa không bị Build/Unbuild/Post xóa; tóm tắt INFO `PERIOD_LOCKED` được thay bằng `replaceLockSummaries` (§6.12.5).
- Với dữ liệu mẫu, build sinh 70 exception INFO (4 NOT_FULFILLED + 66 AMOUNT_ZERO).

### 6.9 Master data page

- **UI:** `/master` – nút "Sync từ Google Sheet" (Popconfirm); Tabs (`destroyOnHidden`): GatewayCompanyMapping (thêm/sửa/xóa, Modal + Form `initialValues`, `preserve={false}`, ComCode dùng `AutoComplete`), Company (thêm/sửa), và 6 tab chỉ xem (Partners phân trang server + search; các bảng khác API trả toàn bộ, phân trang ở client). Sau sync, tab xem được remount bằng `key` có `version`.
- **API:** `GET /api/master/[table]`, `POST /api/master/sync`, `POST|DELETE /api/master/gateway-mapping`, `GET|POST /api/master/company`.
- **Service:** `src/lib/services/master.ts`
  - `syncMastersFromGoogleSheet()`: tải 6 CSV song song (`fetch`, no-store); response lỗi hoặc bắt đầu bằng `<` (trang HTML đăng nhập) → throw; `replaceMasters` (parse hết rồi mới xóa & insert trong 1 transaction); thành công mới ghi đè `data/seed/*.csv`. Không đụng Company/GatewayCompanyMapping.
  - `upsertGatewayMapping`: bắt buộc tên + ComCode (uppercase); trùng `PaymentGatewayName` với bản ghi khác → `BadRequestError`; ComCode chưa có trong Company → tự tạo Company (FunctionalCurrency USD).
  - `upsertCompany`: insert hoặc update theo ComCode.
- **Đổi `GatewayCompanyMapping` của cổng đã post:** Build lần sau không tạo event NEW cho item đã ghi sổ mà ghi ERROR + `POSTED_KEY_CHANGED` (§6.2), kể cả khi chỉ 1 cổng của đơn nhiều cổng đổi. Quy trình: sửa mapping → Unpost phạm vi ComCode **cũ** + kỳ liên quan (nêu trong message) → Build (không chọn ComCode, hoặc chọn ComCode cũ/mới) → Post cả ComCode cũ và mới. Hoặc Unpost + Unbuild trước rồi mới sửa mapping.
- Sửa master **không tự build lại**; phải bấm Build (thay đổi JournalType TK/Partner/gateway) hoặc Post (thay đổi rule/tỷ giá/CoA) — xem §13. Build/Post lại không đụng dữ liệu kỳ đã khóa sổ, nên sửa master không đổi được số liệu kỳ đó (§6.12).
- Kỳ kế toán (khóa sổ) **không** phải master data: quản lý ở trang `/periods` (§6.12), không nằm trong Google Sheet hay `data/seed`, Sync không đụng tới. Trang `/master` có 1 dòng dẫn sang.

### 6.10 Dashboard
- **UI:** `/` – Steps 1→4 kèm số liệu, nút Chạy full cycle / Xóa dữ liệu test, 4 thẻ thống kê, Collapse giải thích luồng + công thức + lần chạy gần đây. Popconfirm "Xóa dữ liệu test" ghi rõ giữ master + trạng thái kỳ và bị từ chối khi còn kỳ khóa (link `/periods`); lỗi 400 hiện bằng `modal.error`.
- **API:** `GET /api/dashboard` → `dashboardStats()` (raw theo BuildStatus, event theo PostStatus, GL lines/docs/Σ Dr/Σ Cr, exception theo Severity, 5 import/build/post gần nhất).
- `GET /api/options` → `filterOptions()` (`comCodes` từ Company, `journalTypeCodes` + dataSource, `periods` từ event + raw, `postBatches`) – dùng cho Select trên các trang qua `useOptions()`.

---

### 6.11 Build các nguồn ngoài Orders (PayPal / Stripe / PIPO)

Tài liệu gốc: §7.4 PayPal, §7.5 PIPO, §7.6 Stripe. Dữ liệu thật: `data/samples/Bank_{Paypal,Stripe,Pipo}.csv`.

> **Bản giải thích cho kế toán/BA, lần theo số liệu thật của file mẫu:**
> [`MAPPING_PAYPAL_TO_GLTRANS.md`](Mapping/MAPPING_PAYPAL_TO_GLTRANS.md) ·
> [`MAPPING_STRIPE_TO_GLTRANS.md`](Mapping/MAPPING_STRIPE_TO_GLTRANS.md) ·
> [`MAPPING_PIPO_TO_GLTRANS.md`](Mapping/MAPPING_PIPO_TO_GLTRANS.md).
> Mục này là bản kỹ thuật; ba tài liệu kia có ví dụ từng dòng Nợ/Có và bảng cân đối của từng nguồn.
>
> **Các cột điền tay** (`JournalType`, `StoreName`, `PartnerCode`, `ComCode`) được điền theo công thức nào, và đặc tả bước tự điền PREFILL (chưa code): [`BA_PREFILL_SOURCES.md`](BA_PREFILL_SOURCES.md).

**Post không phải sửa gì** — 3 nguồn này chỉ thêm tầng Import + Build.

#### 6.11.1 Bản đồ nguồn → sheet → bảng

| `source` (URL/API) | `DataSource` (trên event) | Sheet | Bảng raw | Dòng thật |
|---|---|---|---|---|
| `paypal` | `PAYPAL` | `Bank_Paypal` | `RawPaypal` | 142.659 |
| `stripe` | `STRIPE` | `Bank_Stripe` | `RawStripe` | 1.413 |
| `pipo` | `PIPO` | `Bank_Pipo` | `RawPipo` | 952 |


#### 6.11.2 Khác Orders ở đâu

| | Orders | 3 nguồn này |
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

`AccountingEvent.TransactionID` vẫn là **mã giao dịch gốc** (để `ReferenceTxnID` và đuôi `Description` khớp sheet mẫu GLTrans). `SourceID` = `{DataSource}` + `{SourceKey}`.

#### 6.11.4 Engine

- `src/lib/engine/build-bank.ts` — engine chung, chứa toàn bộ quy tắc kế toán.
- `src/lib/engine/sources/{paypal,stripe,pipo}.ts` — `BankSourceSpec`, thuần khai báo: đọc cột nào, lọc dòng nào, số tiền lấy ở đâu.

Trình tự mỗi dòng:

1. **`accept`** — lọc theo điều kiện nguồn. PayPal/Stripe chỉ `Currency = USD`; PIPO chỉ `Status = Success`. Dòng bị loại → `SKIPPED` + exception INFO `SOURCE_ROW_SKIPPED`.
2. **ComCode → Company** — thiếu → `MISSING_COMCODE` / `MISSING_COMPANY`.
3. **PostingDate** — đọc không ra → `INVALID_SOURCE_ROW`.
4. **JournalType** — cột điền tay thắng (`index.journalType(dataSource, code)`); trống thì `index.journalTypeByNativeType(dataSource, nativeType)` so với cột `JournalType.JournalType` của master. Không ra → `MISSING_JOURNAL_TYPE`.
5. **Tài khoản**, đúng thứ tự §7.2 bước 3: **giá trị trên dòng nguồn → MappingBankAccount (`ComCode` + số tài khoản) → mặc định của JournalType**.
6. **Partner** theo `JournalType.Partner`: `Fixed = X` → `resolveFixedPartner`; `From Source` → `resolvePartnerByCode` (tra `Partners.PartnerCode`, 1 email nhiều store thì lọc tiếp bằng `StoreName`). Không tìm thấy → vẫn ghi sổ với mã đó, `PartnerTaxID` trống + cảnh báo `MISSING_PARTNER`.
7. **Mỗi JournalLineRule active → 1 event**, `EventSeq = RuleSeq`, `Amount` theo `AmountSource` (`AMOUNT` / `GROSS` / `FEE` / `NET`) — **giữ nguyên dấu, chưa nhân `AmountFactor`** (Post mới nhân).

`MasterIndex` được bổ sung 2 lookup: `journalTypeByNativeType(dataSource, nativeType)` và `bankMapping(comCode, bankAccountNumber)`. Hàm sau chuẩn hóa **bỏ số 0 đứng đầu** vì export ngân hàng hay đệm số 0 (`076621019512`) trong khi master ghi `76621019512`.

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

#### 6.11.6 Chống ghi sổ trùng

1 dòng raw ⇄ 1 bộ event (`SourceID = {DataSource}|{SourceKey}`), khóa `SourceKey` ổn định → **không cần `ItemCodes` và post-guard theo item**. Chống ghi sổ trùng có 3 chốt:

1. **Import** (`importSourceFile`) — dòng đã có mà `RowHash` đổi, sau bước kỳ khóa (§6.12):
   - Còn event nào cùng `DataSource` + `SourceID` (mọi PostStatus, mọi ComCode/kỳ; tra theo lô 500 qua index `IX_AccountingEvent_Source`; nhiều event thì báo event kỳ khóa trước, rồi POSTED) → **lỗi dòng**, message nêu event, ComCode, kỳ:
     - POSTED: *"Dòng đã ghi sổ (event …, ComCode X kỳ P, POSTED) và dữ liệu thay đổi → Unpost + Unbuild {DataSource} ComCode X kỳ P trước khi import lại"*;
     - chưa post: *"Dòng còn nằm trong AccountingEvent chưa post (event …, ComCode X kỳ P, {PostStatus}) và dữ liệu thay đổi → Unbuild {DataSource} ComCode X kỳ P trước khi import lại"*.

     Xét ở **mọi BuildStatus** và **trước** nhánh BUILT (Orders thì ngược lại: BUILT báo "Unbuild trước", chỉ dòng chưa BUILT mới tra event — §6.1). Nhờ vậy dòng ERROR/SKIPPED mà event POSTED cũ vẫn còn (VD danh mục bỏ JournalType của dòng sau khi post → Build ra ERROR, event POSTED được giữ) cũng không thay được.
   - Không còn event nhưng `BuildStatus = BUILT` (dòng không sinh event nào) → *"Dòng đã build thành AccountingEvent và dữ liệu thay đổi → Unbuild {DataSource} trước khi import lại"*.
   - Còn lại → thay dòng, về NOT_BUILT.

   Dòng mới (SourceKey chưa có) chỉ tra event khi đang có kỳ khóa. Vì vậy sửa tay cột `JournalType`/`PartnerCode` sau khi đã Build/Post đều bị chặn ngay khi import.
2. **Unbuild** chỉ đưa về NOT_BUILT dòng không còn event nào (§6.4). Unbuild không kèm Unpost giữ event POSTED, nên dòng của nó vẫn bị chốt 1 chặn: muốn sửa dòng đã ghi sổ phải **Unpost + Unbuild** rồi mới import lại. Trước bản sửa §13.3 #21, Unbuild reset mọi dòng trong phạm vi nên chốt 1 (khi đó chỉ xét `BUILT`) mất tác dụng với dòng còn event POSTED.
3. **Build** — `runBuildSource` truyền `oneEventSetPerSource: true` cho `reconcileEvents`: event POSTED (hoặc thuộc kỳ khóa) cùng `SourceID`, cùng ComCode mà lần Build này không còn sinh ra chặn draft mới của dòng **dù khác JournalTypeCode / OrderID** → draft ghi `ERROR`/`BUILD` + `POSTED_KEY_CHANGED` (event kỳ khóa: ERROR `PERIOD_LOCKED`, §6.12.4); event POSTED cũ bị thay chỗ nên không cảnh báo `POSTED_SOURCE_CHANGED` thêm. Ứng viên so sánh gồm thêm mọi event POSTED/kỳ khóa cùng `SourceID` trong `existing`, ngoài nhóm cùng OrderID/TransactionID (OrderID của dòng — PayPal là `Invoice ID` — có thể đã đổi). Lý do: 1 dòng sao kê chỉ có 1 bộ nghiệp vụ, JTC đổi nghĩa là dòng bị **phân loại lại** sau khi ghi sổ. Chốt 1–2 chặn đường sửa tay qua Import, nhưng dòng vẫn có thể đổi JTC mà không qua Import: dòng để trống cột `JournalType` khi danh mục đổi tên gốc (`journalTypeByNativeType`), hoặc dữ liệu đã lỡ thay trước bản sửa. Không có cờ thì vế cuối của `conflicts` đòi cùng JTC → draft JTC mới thành NEW, event cũ chỉ bị cảnh báo → Post ghi sổ trùng. Orders không bật (§6.2). Không chặn: thêm rule mới khi event POSTED của các rule cũ vẫn được sinh ra cùng khóa. Message của nhánh này: "Dòng nguồn này đã ghi sổ ở event N (ComCode, JTC, chứng từ) dưới khóa khác (JournalTypeCode A → B, …) → chặn để không ghi sổ trùng. Unpost ComCode X kỳ P rồi Build + Post lại"; event nêu tên ghép theo cùng `EventSeq` (rule phí của dòng mới chỉ tới rule phí của dòng cũ).

`runBuildSource` **không truyền `deadSourceIds`** cho `reconcileEvents`: dòng biến mất khỏi file chỉ sinh cảnh báo `POSTED_SOURCE_CHANGED`, không chặn các dòng khác cùng `Invoice ID`.

**Kỳ khóa sổ (§6.12):** khóa event (`ComCode|DataSource|JTC|TransactionID|EventSeq`) **không chứa ngày**, nên 1 dòng đổi `PostingDate` sang kỳ khác vẫn trùng khóa với event cũ. Vì vậy:
- Import: từ chối dòng mới/thay khi (ComCode, kỳ `PostingDate`) mới **hoặc** cũ thuộc kỳ khóa; và khi event cùng `SourceID` (`bankSourceId(spec.dataSource, SourceKey)`, tra chung với chốt 1 ở trên — dòng mới chỉ tra khi đang có kỳ khóa) đang ở kỳ khóa: `lockMsg.importEvent` ("Dòng còn nằm trong event … thuộc X kỳ P đã khóa sổ → không cho thay. Muốn sửa: mở khóa …, [Unpost + ]Unbuild kỳ đó rồi import lại"), xét **trước** chốt 1 vì kỳ còn khóa thì không Unpost/Unbuild được. Cả 2 trường hợp tính vào `ImportSourceResult.LockedRows`.
- Build: dòng rời **khỏi** kỳ khóa → draft kỳ mở gặp event cùng khóa ở kỳ khóa → `EVENT_LOCKED`: không insert/replace (nên không lỗi UNIQUE `UX_AccountingEvent_Key`), ghi ERROR `PERIOD_LOCKED`; dòng raw vẫn nhận BuildStatus engine trả về. Với Stripe/PIPO, Import đã chặn đường này (dòng cũ thuộc kỳ khóa), nên chỉ gặp khi dòng đổi ngày sẵn trong DB. Với PayPal, `SourceKey` chứa ngày + giờ nên dòng dời ngày sang kỳ mở là **dòng raw mới** (SourceID mới, Import nhận) nhưng `TransactionID` giữ nguyên → Build chặn bằng `EVENT_LOCKED` như trên. Dòng đổi **vào** kỳ khóa (Import đã chặn; chỉ gặp khi dòng đổi ngày trước lúc khóa mà chưa Build lại) → draft `DRAFT_LOCKED`, event cũ ở kỳ mở xử lý như không còn sinh ra (chưa post → xóa, POSTED → `POSTED_SOURCE_CHANGED`).

#### 6.11.7 Exception được gom nhóm

Riêng PayPal, rule pair 2 bị bỏ vì JournalType không khai `TransAccount` đã là ~86.000 dòng. Ghi từng dòng thì màn Exceptions vô dụng và DB phình. Nên `build-bank.ts` gom theo `(ExceptionType, Severity, ComCode, SourceKey)` và thêm `— N dòng (VD: …)` vào message. Chạy toàn bộ file PayPal thật chỉ ra **37 dòng exception** cho 198k event.

Chi tiết từng dòng vẫn nằm ở `RawXxx.BuildMessage`, xem được trên trang raw của nguồn.

Hệ quả: exception của các nguồn này có `Period = null` → `runBuildSource` xóa exception cũ bằng `deleteExceptionsByDataSource` (theo `DataSource` + ComCode) chứ không theo khóa/kỳ như Orders. Cũng vì `Period = null` nên exception gom nhóm **không bao giờ được coi là thuộc kỳ khóa**: Build/Unbuild vẫn xóa rồi ghi lại chúng từ mọi dòng trong phạm vi, kể cả dòng kỳ khóa (cố ý, để giữ nguyên kết quả khi không khóa gì — §6.12.8).

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

### 6.12 Kỳ kế toán & khóa sổ (Accounting Period)

Tài liệu gốc §4.3: bảng AccountingPeriod, "kỳ LOCKED phải chặn mọi action ảnh hưởng dữ liệu". Mục đích: số liệu kỳ đã chốt / đã báo cáo không bị Import, Build, Post, Unpost lại làm đổi âm thầm. Đặc tả nghiệp vụ, căn cứ luật và so sánh với phần mềm khác: [`BA_ACCOUNTING_ENGINE.md` §4.3](Docs-BA/BA_ACCOUNTING_ENGINE.md#43-accounting-period).

- **UI:** `/periods` (menu "Kỳ kế toán") — §8.4.
- **API:** `GET /api/periods`, `POST /api/periods/lock`, `POST /api/periods/unlock`, `GET /api/periods/log` (§7).
- **Service:** `src/lib/services/periods.ts` (lưới, khóa/mở khóa, lịch sử); chốt chặn nằm trong từng service Import/Build/Post/Clear, dùng helper ở `src/lib/services/common.ts`.
- **Engine:** `src/lib/engine/period-lock.ts` (quy tắc thuần), `reconcileEvents({…, isLocked})`.

**Quyết định đã chốt**

| Vấn đề | Chọn |
|---|---|
| Đơn vị khóa | Công ty × tháng (`ComCode`, `YYYYMM`). Không có dòng `AccountingPeriod` = OPEN |
| Trạng thái | `OPEN` / `LOCKED`. Đóng vĩnh viễn (CLOSED) để dành khi có đăng nhập |
| Dòng Import thuộc kỳ khóa (dữ liệu về muộn) | **Từ chối dòng**, các dòng khác vẫn nhận |
| Lệnh phạm vi rộng (Build / Post / Unpost / Unbuild / full cycle) | **Bỏ qua phần kỳ khóa + báo số lượng**, không từ chối cả lệnh |
| "Xóa dữ liệu test" | **Từ chối** khi còn bất kỳ kỳ LOCKED |
| Khóa khi còn việc dở (raw chưa build, event NEW/ERROR, lệch Nợ/Có) | Chỉ **cảnh báo**; xác nhận thì khóa, nội dung cảnh báo lưu vào `ChecksSnapshot` |
| Thứ tự khóa | Tự do từng kỳ + "Khóa mọi kỳ đến hết kỳ P" (1 hoặc nhiều công ty); mở khóa khi kỳ sau còn khóa chỉ cảnh báo |
| Mở khóa | Bắt buộc tên + lý do ≥ 10 ký tự |
| Không kỳ nào khóa | Điều kiện SQL và kết quả **giống hệt trước khi có tính năng** → baseline §10.2 không đổi |

#### 6.12.1 Dữ liệu & kỳ của từng loại bản ghi

Hai bảng `AccountingPeriod` / `AccountingPeriodLog`: §4.2. Không nằm trong `data/seed`, không bị Sync (`replaceMasters`) hay `resetTransactionalData` xóa; `npm run db:reset` xóa file DB nên mất cả hai.

| Bản ghi | (ComCode, kỳ) đem so với kỳ khóa |
|---|---|
| `AccountingEvent`, `GLTrans`, `ExceptionLog` | Cột `ComCode`, `Period` |
| `RawOrders` | ComCode theo GatewayCompanyMapping **hiện tại** (Build sẽ ghi vào đó) **và** `ComCode` đang lưu trên dòng (event cũ nằm ở đó) × kỳ `FulfilledAt` (`orderRowRefs`) — 1 trong 2 bị khóa là dòng bị khóa. Riêng Unbuild (SQL) chỉ dùng `ComCode` đang lưu |
| `RawPaypal` / `RawStripe` / `RawPipo` | `ComCode` × kỳ `PostingDate` (Build kiểm thêm `spec.comCode(row)` × kỳ `spec.postingDate(row)`) |

ComCode hoặc kỳ trống (dòng chưa giao, cổng chưa map, exception gom nhóm `Period = null`) → **không thuộc kỳ nào, không bao giờ bị khóa**.

1 chứng từ (DocNum) luôn thuộc đúng 1 công ty × 1 kỳ: Single = 1 event; Bulk gom theo `PostingGroupKey` có `ComCode` + ngày `yyyyMMdd`. Nên lọc Post/Unpost theo event là đủ, không bao giờ post/gỡ dở 1 chứng từ.

#### 6.12.2 So khớp khóa: engine và SQL

- **Engine** (`period-lock.ts`): `lockKey(com, p)` = `UPPER(TRIM(com))|TRIM(p)`. `PeriodLocks` là tập khóa đang LOCKED (bỏ dòng trống/trùng); `isLocked({ComCode, Period})` trả `false` khi ComCode hoặc kỳ trống/null; có `isEmpty`, `size`, `keys` (sort), `periodsOf(com)`, `PeriodLocks.NONE`. `firstLocked(locks, refs)` trả ref đầu tiên bị khóa.
- **Đọc kỳ khóa:** `loadPeriodLocks(db)` (`Status = 'LOCKED'`) 1 lần mỗi thao tác — **trong transaction** của thao tác ghi (Import, Build, Unpost/Unbuild chạy thật, Reset) để kỳ khóa và phần ghi cùng 1 snapshot. Post đọc 1 lần ở đầu `runPost` (code đồng bộ nên không xen request khác).
- **SQL** cùng quy tắc với `lockKey`: `(upper(trim(coalesce(ComCode,''))) || '|' || trim(coalesce(Period,'')))` so với danh sách `locks.keys`.
  - `notLocked(locks, comCol, periodExpr)` → `[… NOT IN (…)]`. **Không kỳ nào khóa → `[]`**, nên `and(...where, ...notLocked(...))` sinh đúng SQL cũ.
  - `lockedWhere(...)` → `… IN (…)`, để đếm phần bị bỏ qua. Không khóa gì → `0 = 1`; các truy vấn đếm này chỉ chạy khi `!locks.isEmpty`.
  - `coalesce` là bắt buộc: `NULL NOT IN (…)` cho NULL, tức dòng thiếu ComCode/kỳ sẽ bị loại như thể đang khóa. Có `coalesce` thì khóa của nó là `COM|` hoặc `|YYYYMM`, không bao giờ nằm trong danh sách → luôn xử lý như kỳ mở, khớp với `isLocked` của engine.
  - Cột ngày dùng `periodOfDateColumn(col)` = `substr(col,1,4) || substr(col,6,2)` (ngày NULL → NULL → `''`).
- Khi không kỳ nào khóa, ngoài SQL cũ chỉ thêm 1 `SELECT` trên `AccountingPeriod` mỗi thao tác và 1 `DELETE` tóm tắt INFO `PERIOD_LOCKED` (không có dòng nào để xóa) mỗi lần Build/Post → kết quả, bộ đếm và baseline rule 9 không đổi.

#### 6.12.3 Kỳ khóa chặn gì — theo từng thao tác

| Thao tác | Với phần thuộc kỳ khóa | Báo ở đâu |
|---|---|---|
| Import Orders (§6.1) | Dòng mới/thay có (ComCode, kỳ) mới **hoặc** cũ bị khóa → lỗi dòng; dòng có item trong event kỳ khóa → lỗi dòng. Dòng giống hệt vẫn bỏ qua; dòng mới chưa giao vẫn được nhận (trừ khi thay dòng cũ đã giao trong kỳ khóa) | `ImportOrdersResult.LockedRows` (⊂ `ErrorRows`) + lỗi từng dòng |
| Import PayPal / Stripe / PIPO (§6.11.6) | Như trên theo (ComCode, kỳ `PostingDate`); khi đang có kỳ khóa thì thêm: event cùng `SourceID` ở kỳ khóa → lỗi dòng | `ImportSourceResult.LockedRows` |
| Build Orders / nguồn ngân hàng (§6.2, §6.12.4) | Engine chạy mọi dòng; không insert/replace/remove/heal event kỳ khóa; raw kỳ khóa giữ BuildStatus; exception kỳ khóa giữ nguyên, không ghi exception mới cho kỳ khóa; draft kỳ mở đụng event kỳ khóa → ERROR `PERIOD_LOCKED` | `BuildSummary.LockedSkipped` (draft kỳ khóa không ghi — `DRAFT_LOCKED`), `LockedConflicts` (draft kỳ mở bị chặn vì event kỳ khóa), `LockedRows` (raw giữ BuildStatus), `LockedPeriods`; INFO `PERIOD_LOCKED` |
| Post Single / Bulk (§6.3) | Event NEW / ERROR-POST kỳ khóa không vào candidate; vẫn được dùng để dò trùng item | `PostSummary.LockedEvents`, `LockedPeriods`; INFO `PERIOD_LOCKED` (`BatchID` null) |
| Unpost (§6.4) | Chứng từ kỳ khóa giữ nguyên | `UnpostResult.lockedDocuments`, `lockedEvents`, `lockedPeriods` |
| Unbuild / Unpost + Unbuild (§6.4) | Event kỳ khóa (mọi trạng thái) không xóa; raw kỳ khóa giữ BuildStatus; exception kỳ khóa giữ nguyên | `UnbuildResult.lockedEvents`, `lockedRawRows`, `lockedPeriods` (+ `unposted.locked*`) |
| Run full cycle (§6.5) | Build + Post như trên | `build.Locked*`, `post[].LockedEvents` |
| "Xóa dữ liệu test" (`/api/reset`, `npm run db:clear`) | **Từ chối cả lệnh** khi còn bất kỳ kỳ LOCKED (kể cả kỳ không có dữ liệu) | 400 / thoát mã 1 (`lockMsg.resetRefused`) |
| Sync master, sửa Company/Gateway | Không đụng bảng kỳ. Sửa master rồi Build/Post lại vẫn không đổi được dữ liệu kỳ khóa | — |
| Xem, lọc, Export GL/Event | Không ảnh hưởng | — |

`LockedPeriods` / `lockedPeriods` luôn dạng `"COMCODE|YYYYMM"`, sort, không trùng. Riêng Build: gồm các kỳ đã đếm (raw bỏ qua, draft `DRAFT_LOCKED`) + kỳ của mọi event kỳ khóa trong tập đối chiếu (`existing`); không gồm event kỳ khóa chỉ có trong `relatedPosted` (message ERROR đã nêu kỳ).

#### 6.12.4 Build: `reconcileEvents` với `isLocked`

**Không lọc input trước** (bỏ dòng kỳ khóa khỏi engine), vì SourceID của các dòng đó sẽ trông như "đã chết" → xóa nhầm event/exception; với nguồn ngân hàng, khóa event không chứa ngày nên draft kỳ mở trùng khóa với event kỳ khóa → lỗi UNIQUE hoặc ghi sổ trùng. Vì vậy engine vẫn chạy trên mọi dòng trong phạm vi, service truyền `isLocked: (x) => locks.isLocked(x)` và `reconcileEvents` tự bỏ qua:

1. **Heal `ItemCodes`:** vẫn nạp item của event POSTED cũ để dò trùng, nhưng chỉ ghi `healItemCodes` khi event không khóa.
2. **Vật cản trùng item** (`group()`): event kỳ khóa ở **mọi trạng thái** (không chỉ POSTED) cũng chặn — không xóa/thay được nên draft trùng item sẽ ghi sổ trùng. Build Orders cũng đưa event kỳ khóa (mọi trạng thái) của SourceID ngoài phạm vi vào `relatedPosted` (§6.2).
3. **Từng draft:**
   - Draft thuộc kỳ khóa → `plan.locked` lý do **`DRAFT_LOCKED`**, không ghi. Nếu event cùng khóa đang ở kỳ mở thì event đó coi như không còn sinh ra (chưa post → xóa, POSTED → `POSTED_SOURCE_CHANGED`).
   - Draft kỳ mở, event cùng khóa ở kỳ khóa (ngân hàng đổi ngày) → `plan.locked` lý do **`EVENT_LOCKED`**, không ghi, ERROR `PERIOD_LOCKED` (`lockMsg.sameKeyLocked`), `lockedConflicts++`.
   - Draft kỳ mở trùng item với event kỳ khóa → ghi `ERROR`/`BUILD` + ERROR `PERIOD_LOCKED` (`lockMsg.blockedByLocked`: "mở khóa … trước", thay lời khuyên "Unpost…" của `POSTED_KEY_CHANGED`); tính cả `blocked` lẫn `lockedConflicts`.
4. **Vòng cuối:** event kỳ khóa không bao giờ bị xóa hay cảnh báo `POSTED_SOURCE_CHANGED`; không còn được sinh ra thì chỉ đếm `lockedKept`.

`ReconcilePlan` thêm `locked: {draft, reason, eventId}[]`, `lockedConflicts`, `lockedKept`. Không truyền `isLocked` → plan y hệt trước (test so sánh deep-equal).

Service thêm chốt thứ 2 bằng SQL: replace/remove/heal đều có `notLocked`. Draft `EVENT_LOCKED` không được ghi nhưng dòng raw (kỳ mở) của nó vẫn nhận BuildStatus engine trả về.

#### 6.12.5 Exception `PERIOD_LOCKED`

- **INFO — tóm tắt phần bị bỏ qua.** `LockTally.add(dataSource, ref, "rows"|"events", n)` gom theo DataSource × ComCode × kỳ; `toExceptions("Build"|"Post")` sinh 1 dòng mỗi nhóm, SourceKey `PERIOD_LOCKED|{DataSource}|{ComCode}|{Period}` (`lockSummaryKey`), message `"X kỳ P đã khóa sổ → Build bỏ qua n dòng nguồn, m event. Muốn ghi lại: …"`.
  - Build: đếm raw giữ BuildStatus (dòng nguồn) + draft `DRAFT_LOCKED` (event); `BatchID` = BuildBatchID; `replaceLockSummaries(tx, "BUILD", [dataSource], scope, …)`.
  - Post: đếm event chờ post kỳ khóa của **cả Single lẫn Bulk** (không theo loại được chọn); `BatchID` null vì lần Post có thể không tạo batch; `replaceLockSummaries(tx, "POST", dataSource ? [dataSource] : null, scope, …)`.
  - `replaceLockSummaries` xóa tóm tắt INFO cũ của bước đó trong phạm vi (ComCode / kỳ / nguồn của scope) **và** bản cũ trùng SourceKey với bản mới, rồi ghi bản mới → **thay, không cộng dồn**. Luôn được gọi, kể cả khi rỗng, để dọn tóm tắt cũ.
  - Mở khóa 1 kỳ xóa mọi tóm tắt INFO `PERIOD_LOCKED` (BUILD + POST) của đúng ComCode + kỳ đó (`UnlockResult.removedSummaries`). Unbuild không xóa tóm tắt của kỳ còn khóa.
- **ERROR — draft kỳ mở đụng event kỳ khóa** (§6.12.4). SourceKey `{TransactionID}|{JTC}` (cùng dạng `POSTED_KEY_CHANGED`) nên được làm mới ở lần Build sau như exception BUILD thường. Dòng ngân hàng có nhiều rule (VD Stripe charge rule 10 + 30) sinh nhiều dòng cùng SourceKey — vô hại vì `ExceptionLog` không có unique trên SourceKey.

#### 6.12.6 Khóa / mở khóa — `src/lib/services/periods.ts`

Quy tắc thuần ở engine (`resolveLockTargets`, `pendingIssues`, `actorError`, `unlockReasonError`, `laterLockedPeriods`, `isBalanced`, `isValidPeriod`); service chỉ đọc/ghi DB. Giới hạn nhập liệu `PERIOD_RULES` (`src/lib/field-docs.ts`, client-safe, dùng chung cho form): lý do mở khóa ≥ 10 ký tự, tên ≤ 100, ghi chú/lý do ≤ 500 (đếm theo ký tự Unicode, sau trim), tối đa 500 kỳ mỗi lần khóa. Lỗi đầu vào → `BadRequestError` (400).

- **`aggregate(db, {comCode, periodFrom, periodTo})`:** mỗi bảng 1 câu GROUP BY rồi ghép theo `lockKey` — event theo PostStatus; GL: số dòng, số DocNum, Σ `AccountedDr` / `AccountedCr` (round 2, cộng bằng Decimal); raw 4 nguồn theo BuildStatus (Orders theo kỳ `FulfilledAt`, 3 nguồn kia theo kỳ `PostingDate`, bỏ dòng không có ngày). Raw có ComCode trống → `unassigned {Period, DataSource, NotBuilt, Error}` (chỉ nhóm còn chưa build/lỗi; vẫn đếm khi lọc công ty). Kỳ không đúng YYYYMM bị bỏ.
- **`listPeriodGrid(filter)`** → `PeriodGrid {companies, periods, cells, unassigned, lockedCount}`:
  - `cells` = hợp các (công ty, kỳ) có dữ liệu và có dòng `AccountingPeriod`. Mỗi ô: `Status` (không có dòng → OPEN), `HasRow`, các cột khóa/mở khóa, `rawBySource` (luôn đủ ORDERS/PAYPAL/STRIPE/PIPO), `rawNotBuilt`, `rawError`, `events`, `glLines`, `glDocs`, `dr`, `cr`, `balanced`, `issues`.
  - `companies` = bảng Company (theo bộ lọc) + ComCode chỉ có trong dữ liệu (`InCompanyTable: false` → không khóa được).
  - `periods` mới nhất trước; lọc đủ cả kỳ từ + kỳ đến thì thêm mọi tháng trong khoảng để khóa trước tháng chưa có dữ liệu (khoảng > 120 tháng: chỉ thêm 120 tháng mới nhất, đi lùi từ kỳ đến).
  - `lockedCount` = số kỳ LOCKED của mọi công ty (không theo bộ lọc).
- **`lockPeriods({targets | comCodes + throughPeriod, actor, note, preview})`:**
  - `resolveLockTargets`: chọn **đúng 1** cách — `targets` tường minh, hoặc `comCodes` + `throughPeriod` = mọi kỳ ≤ P **có dữ liệu** (raw / event / GL) của từng công ty **và chính P**. Chuẩn hóa trim/uppercase, bỏ trùng, sort; ComCode phải có trong Company; kỳ YYYYMM tháng 01–12 (năm ≥ 1900); tách riêng `alreadyLocked`; tổng (tính cả kỳ đã khóa) ≤ 500. Lỗi nối bằng `; `.
  - `preview: true` → `{preview, targets: PendingCheck[], alreadyLocked}` — việc dở từng ô, gồm `RAW_NO_COMCODE` từ raw chưa xác định công ty cùng kỳ.
  - Chạy thật: kiểm ghi chú ≤ 500 và `actorError`; 1 transaction đồng bộ, mỗi ô đọc lại dòng — đã LOCKED thì bỏ qua (**không ghi log**), còn lại upsert (`onConflictDoUpdate` trên PK) `Status LOCKED, LockedBy, LockedAt, Note, ModifiedDate` (thông tin mở khóa lần trước giữ nguyên) + 1 dòng log `LOCK` (`Reason` = ghi chú, `ChecksSnapshot` = JSON việc dở). Trả `{preview: false, locked, alreadyLocked, targets}`.
  - UI luôn gửi lệnh khóa thật bằng **danh sách `targets` đã xem trước**, để "khóa đến hết kỳ" không nở thêm kỳ giữa lúc xem và lúc xác nhận.
- **`unlockPeriod({comCode, period, actor, reason, preview})`:** kỳ phải đang LOCKED, nếu không → 400. `preview` → `{laterLockedPeriods, check, row}` (kỳ sau cùng công ty còn khóa: chỉ cảnh báo). Chạy thật: `actorError` + `unlockReasonError`; trong transaction đọc lại (đã mở ở tab khác → 400), đặt `Status OPEN` + `UnlockedBy`, `UnlockedAt`, `UnlockReason`, ghi log `UNLOCK` kèm snapshot, xóa tóm tắt INFO `PERIOD_LOCKED` của kỳ → `removedSummaries`.
- **`listPeriodLog(filter)`** → `{rows, total}`, mới nhất trước; lọc `comCode`, `period`, `periodFrom/To`, `action` (LOCK | UNLOCK, khác → 400); `pageSize` ≤ 500. **`lockedPeriodSummary()`** → `{count, keys}`.

**Việc dở (`pendingIssues`)** — chỉ cảnh báo, không chặn; lưu vào `ChecksSnapshot` (bỏ ComCode/Period/Status vì dòng log đã có):

| Code | Khi nào |
|---|---|
| `RAW_NOT_BUILT` | Raw chưa build — khóa rồi sẽ không build được |
| `RAW_ERROR` | Raw lỗi khi build (thiếu ComCode, JournalType…) |
| `RAW_NO_COMCODE` | Raw cùng kỳ chưa xác định công ty — không khóa theo công ty được |
| `EVENTS_NEW` | Event NEW chưa Post — khóa rồi sẽ không Post được |
| `EVENTS_ERROR` | Event ERROR (thiếu partner, tỷ giá, tài khoản…) |
| `GL_IMBALANCED` | Σ Nợ ≠ Σ Có (lệch ≥ 0,005 — `isBalanced`, tính bằng Decimal) |
| `NO_DATA` | Kỳ chưa có dữ liệu (không raw đã có công ty ở mọi BuildStatus, không event ở mọi PostStatus, không dòng GL — cùng định nghĩa với lưới và "Khóa đến hết kỳ") — chỉ là thông tin (khóa trước để chặn nhập nhầm); trang `/periods` không tính là việc dở |

#### 6.12.7 Sửa dữ liệu của kỳ đã khóa (dữ liệu về muộn)

VD `ZENIROXPAY 202511` đã khóa, sao kê / order tháng 11 về muộn: Import báo lỗi dòng "Dòng thuộc ZENIROXPAY kỳ 202511 đã khóa sổ → không nhận…". Quy trình: trang `/periods` → chọn ô → **Mở khóa** (tên + lý do) → Import → (Unpost / Unbuild nếu phải thay dữ liệu đã ghi) → Build → Post → kiểm tra → **Khóa** lại. Lịch sử có 1 dòng UNLOCK + 1 dòng LOCK, mỗi dòng kèm snapshot.

Dòng ở kỳ **mở** mà đụng dữ liệu kỳ khóa (đổi ngày giao / đổi cổng ra khỏi kỳ khóa, trùng item) bị chặn bằng ERROR `PERIOD_LOCKED`; message nêu kỳ cần mở khóa.

#### 6.12.8 Giới hạn & rủi ro đã biết

- Chưa có đăng nhập: `LockedBy` / `ActorName` là tên gõ tay (trang nhớ bằng `localStorage`), chưa phân quyền ai được khóa/mở; chưa có trạng thái đóng vĩnh viễn (CLOSED).
- Raw chưa xác định được công ty (ComCode trống) không khóa theo công ty được — chỉ được cảnh báo `RAW_NO_COMCODE` và Alert trên trang `/periods`.
- Exception gom nhóm của nguồn ngân hàng (`Period = null`) không thuộc kỳ nào → vẫn bị Build/Unbuild xóa và ghi lại, và vẫn đếm cả dòng kỳ khóa (§6.11.7).
- Tóm tắt INFO thay theo phạm vi + SourceKey: Build hẹp (VD 1 ComCode) chạm vài dòng của kỳ khóa sẽ ghi đè tóm tắt của lần Build toàn bộ bằng số nhỏ hơn.
- Đổi cổng sang công ty có kỳ đã khóa (VD Stripe → ONTARIO khi `ONTARIO 202511` khóa): event chưa post của công ty cũ bị xóa (không còn sinh ra), còn draft của công ty mới bị bỏ qua → đơn tạm không có event cho tới khi mở khóa; chỉ báo qua `LockedSkipped` + INFO. Cần nghiệp vụ xác nhận.
- `pendingIssues` không coi raw thiếu ComCode là "có dữ liệu" → ô chỉ có loại raw này báo cả `RAW_NO_COMCODE` lẫn `NO_DATA`.
- `npm run db:reset` xóa file DB → mất trạng thái kỳ và lịch sử.

**Test:** `tests/engine/period-lock.test.ts` (quy tắc thuần), nhóm "reconcileEvents — khóa sổ" trong `tests/engine/reconcile-events.test.ts`, `tests/integration/period-lock.test.ts` (chốt chặn từng thao tác), `tests/integration/periods.test.ts` (service + route kỳ) — §10.1.

---

## 7. API reference

Tất cả handler bọc bởi `handle()` (`src/lib/api.ts`): `BadRequestError` → 400 `{error}`; lỗi khác → log + 500 `{error}`.
- **Scope (`parseScope`)** – dùng ở build, post, unpost, unbuild, cycle, events (+export), gl (+summary, export), periods (+log): `comCode` (tự uppercase), `periodFrom`, `periodTo` (**bắt buộc YYYYMM**, sai → 400), `dataSource`.
- **Kỳ khóa sổ (§6.12):** response của import, build, post, unpost, unbuild, cycle có thêm các trường `Locked*` / `locked*` (§6.12.3); `/api/reset` trả 400 khi còn kỳ LOCKED.
- `/api/orders` và `/api/exceptions` đọc `comCode/periodFrom/periodTo` bằng `str()` → **không validate, không uppercase** (so khớp chính xác).
- **Phân trang (`paging`)**: `page` (mặc định 1), `pageSize` (mặc định 50; service giới hạn tối đa 5000).
- **Body lỏng:** `jsonBody` biến JSON hỏng thành `{}`; `bool()` chỉ nhận `"1"`/`"true"`/`true`; `int()` giá trị không phải số → null. Hệ quả: body sai gửi tới `/api/unpost` hoặc `/api/unbuild` sẽ chạy thật **trên toàn bộ dữ liệu** (không preview, không lọc batch) – UI luôn gửi đúng nhưng cần cẩn thận khi gọi tay.

| Method | Path | Tham số | Response | Service |
|---|---|---|---|---|
| POST | `/api/orders/import` | multipart `file` | `ImportOrdersResult` | `importOrders` |
| GET | `/api/orders` | page, pageSize, search, comCode, itemStatus, buildStatus, importBatchId, periodFrom, periodTo | `{rows, total}` | `listRawOrders` |
| GET | `/api/import-batches` | – | `ImportBatchRow[]` | `listImportBatches` |
| POST | `/api/sources/[source]/import` | multipart `file`; `source` ∈ `paypal, stripe, pipo` (khác → 400) | `ImportSourceResult` | `importSourceFile` |
| GET | `/api/sources/[source]` | page, pageSize, search, comCode, buildStatus, journalType, importBatchId, periodFrom, periodTo | `{rows, total, byStatus, journalTypes}` | `listRawSource` |
| POST | `/api/build` | body scope; `dataSource` chọn nguồn (trống = `ORDERS`, sai → 400) | `BuildSummary` | `runBuildOrders` / `runBuildSource` |
| GET | `/api/build-batches` | – | `BuildBatchRow[]` | `listBuildBatches` |
| POST | `/api/post` | body `classify` + scope | `PostSummary[]` | `runPost` |
| POST | `/api/unpost` | body `preview?`, `postBatchId?` + scope | `UnpostResult` | `unpost` |
| POST | `/api/unbuild` | body `preview?`, `includePosted?` + scope | `UnbuildResult` | `unbuild` |
| POST | `/api/cycle` | body scope | `{build, post}` | build + post |
| POST | `/api/reset` | – | `{done}` / 400 khi còn kỳ khóa | `resetTransactionalData` |
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
| GET | `/api/periods` | comCode, periodFrom, periodTo (`parseScope`) | `PeriodGrid` | `listPeriodGrid` |
| POST | `/api/periods/lock` | `{targets?: [{comCode, period}], comCodes?: string[], throughPeriod?, actor?, note?, preview?}` — chọn 1 trong 2: `targets` hoặc `comCodes` + `throughPeriod`; chạy thật bắt buộc `actor` | `LockPreview` / `LockResult` / 400 | `lockPeriods` |
| POST | `/api/periods/unlock` | `{comCode, period, actor?, reason?, preview?}` — chạy thật bắt buộc `actor` + `reason` ≥ 10 ký tự | `UnlockPreview` / `UnlockResult` / 400 | `unlockPeriod` |
| GET | `/api/periods/log` | comCode, period, periodFrom, periodTo, action (LOCK\|UNLOCK), page, pageSize (≤ 500) | `{rows, total}` | `listPeriodLog` |

> **Bẫy routing:** thư mục tĩnh `src/app/api/master/company/` **che** route động `[table]` cho path `/api/master/company` → file đó phải tự khai báo cả GET. Khi tạo route tĩnh cùng cấp với `[table]` nhớ điều này.

Dynamic params trong Next 16 là Promise: `(req, ctx: { params: Promise<{ id: string }> })` rồi `await ctx.params`.

---

## 8. Frontend

### 8.1 Khung
- `src/app/layout.tsx`: `<AntdRegistry><AppShell>{children}</AppShell></AntdRegistry>`.
- `src/components/AppShell.tsx` (client): `ConfigProvider` (locale `vi_VN`, `colorPrimary #1f6feb`), `<App>` (để dùng `App.useApp()`), `Layout.Sider` + `Menu` (key = path). Thêm trang mới → thêm vào hằng `MENU`. Mục "Kỳ kế toán" (`/periods`, icon khóa) nằm ngay trước "Master data".
- `src/app/raw/[source]/page.tsx` là **một trang động dùng chung** cho 3 nguồn ngoài Orders: cột, sheet, cột bắt buộc đều đọc từ `SOURCE_META`. `/raw/orders` là route tĩnh nên không bị route động che.
- `ScopeBar` có thêm ô **Nguồn** (`dataSource`), dùng chung cho Build (`/events`), Post/Unpost (`/posting`) và lọc GL (`/gl`).
- Mọi page là client component (`"use client"`), tự fetch API.

### 8.2 Helper
`src/components/client.ts`:
- `useApi<T>(url | null)` → `{data, loading, error, reload}`; `url = null` thì không gọi; tự gọi lại khi url đổi; chống race bằng sequence ref. Filter/phân trang thường được đưa vào url qua `toQuery`. `data` cũ **được giữ** tới khi request mới xong (kể cả khi url thành null) → Drawer có thể thoáng hiện dữ liệu bản ghi trước.
- `getJson`, `postJson(url, body, method?)`, `deleteJson` – lỗi HTTP ném `Error(body.error)`.
- `toQuery(obj)` bỏ giá trị null/undefined/"".
- `useOptions()` = `useApi("/api/options")`; `money(v)` định dạng `en-US` 2 số lẻ.

`src/components/ui.tsx`:
- `columnsOf<T>(fields, docs?, overrides?)` → cột antd Table: header `FieldTitle` (tooltip từ docs), cột tiền canh phải + `money`, cột trạng thái (`PostStatus, Status, BuildStatus, Severity, BalanceImpact, Classify, ItemStatus, Action, FromStatus, ToStatus`) → `StatusTag`, width/ellipsis theo tên cột. Override từng cột qua `overrides[name]` (VD `fixed: "left"`).
- `StatusTag` – màu theo map `COLORS`; kỳ kế toán: `OPEN` xanh lá, `LOCKED` đỏ (kèm icon khóa), `LOCK` volcano, `UNLOCK` cyan.
- `LockedPeriodsAlert({periods, what})` – Alert warning "`{what}` thuộc kỳ đã khóa sổ" + tối đa 6 kỳ (`"COMCODE|YYYYMM"` hiện thành `COMCODE YYYYMM`) + link `/periods`; `periods` rỗng → không render gì. Dùng cho kết quả Build/Post và xác nhận Unpost/Unbuild.
- `ScopeBar` – Select ComCode + `DatePicker.RangePicker picker="month" format="YYYYMM"`, value dạng `{comCode?, periodFrom?, periodTo?}`.
- Tooltip cột: `GL_FIELD_DOCS`, `EVENT_FIELD_DOCS`, `POSTING_BATCH_FIELD_DOCS`, `PERIOD_FIELD_DOCS`, `PERIOD_LOG_FIELD_DOCS` (`src/lib/field-docs.ts`); `RAW_DOCS` nằm trong `src/app/raw/orders/page.tsx`.

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

### 8.4 Kỳ kế toán (`/periods`) & hiển thị phần kỳ khóa

**Trang `src/app/periods/page.tsx`** (client, chỉ `import type` từ services/engine/schema):
- Alert giải thích tác dụng của LOCKED; Card lọc: Select nhiều công ty (ẩn/hiện cột phía client), `RangePicker` tháng (YYYYMM, gửi lên API), Tải lại, "Đang khóa n kỳ (mọi công ty)". Alert riêng liệt kê raw chưa xác định công ty theo kỳ × nguồn (`unassigned`).
- **Ma trận**: dòng = kỳ (mới nhất trên, 24 kỳ/trang), cột = công ty `ComCode (FncCurr)`; công ty không có trong Company có cảnh báo và không chọn được. Ô kỳ có checkbox chọn cả dòng (checked / indeterminate). Mỗi ô: checkbox + `StatusTag` + "GL n dòng · m CT" + chip `NEW` (event chưa Post), `ERR` (event lỗi), `Raw` (raw chưa build + lỗi), `Lệch` (Σ Nợ ≠ Σ Có); ô đang chọn / ô LOCKED có nền riêng. Rê chuột → Popover: raw theo nguồn, event theo trạng thái, GL, Σ Nợ/Có, Cân/Lệch, lần khóa/mở khóa gần nhất, việc dở. Ô không có dữ liệu hiện "—" nhưng vẫn chọn để khóa trước được.
- **Nút:** "Khóa (n)" — n = số ô OPEN đang chọn **và đang hiện** (ẩn công ty / đổi khoảng kỳ không khóa nhầm ô đã chọn trước) → preview → hộp xác nhận. "Khóa đến hết kỳ…" — Modal chọn công ty + tháng → preview → cùng hộp xác nhận; lệnh thật luôn gửi `targets` của preview. "Mở khóa" — chỉ bật khi chọn đúng 1 ô LOCKED. "Lịch sử" — Drawer (`size={1100}`, `destroyOnHidden`) lọc theo ô đang chọn nếu chọn đúng 1 ô (Tag bỏ lọc được), lọc Action, cột theo `PERIOD_LOG_FIELD_DOCS`, tóm tắt snapshot, dòng mở rộng xem JSON đầy đủ.
- **Hộp khóa:** Alert warning "Còn việc dở ở K kỳ" (bỏ qua `NO_DATA`) hoặc success; bảng từng ô (ComCode, Kỳ, raw chưa build, raw lỗi, event NEW, event ERROR, dòng GL, Σ Nợ, Σ Có, Cân/Lệch, việc dở); Alert info "Đã khóa – bỏ qua: …"; Form (`preserve={false}`) tên người khóa (bắt buộc, ≤ 100), ghi chú, checkbox bắt buộc "Tôi đã xem cảnh báo" khi có việc dở.
- **Hộp mở khóa:** Alert info, cảnh báo kỳ sau còn khóa, Descriptions (`FieldTitle` + `PERIOD_FIELD_DOCS`, GL, Σ Nợ/Có), việc dở, tên người mở khóa, lý do (TextArea `showCount`, ≥ `PERIOD_RULES.unlockReasonMinLength` ký tự sau trim), nút OK danger.
- Tên người thao tác nhớ trong `localStorage` key `sky-finance.periodActor` (đọc khi mở hộp, ghi sau khi thành công, đều bọc try/catch). Mọi message/modal lấy từ `App.useApp()`.

**Kết quả trên các trang khác** (tên trường ở §6.12.3):
- `/events` — kết quả Build: `LockedPeriodsAlert` (tiêu đề VD "Build bỏ qua 12 event (30 dòng raw), chặn 2 event đụng dữ liệu") + 2 dòng Descriptions "Bỏ qua do kỳ khóa (giữ nguyên)" = `LockedSkipped` event · `LockedRows` dòng raw, "Chặn do đụng kỳ khóa (ERROR PERIOD_LOCKED)" = `LockedConflicts`. Xác nhận Unbuild / Unpost + Unbuild: Alert "Giữ nguyên {lockedEvents} event, {lockedRawRows} dòng raw[, {unposted.lockedDocuments} chứng từ]"; mọi thứ trong phạm vi đều thuộc kỳ khóa → chỉ `message.warning`, không mở hộp xác nhận.
- `/posting` — kết quả Post: cột "Kỳ khóa (bỏ qua)" = `LockedEvents`, Alert gộp kỳ khóa của Single + Bulk. Unpost: mọi chứng từ trong phạm vi thuộc kỳ khóa → `message.warning`; còn lại xác nhận kèm Alert "Giữ nguyên {lockedDocuments} chứng từ ({lockedEvents} event)" (cả Unpost theo phạm vi lẫn theo batch).
- `/` (Dashboard) — full cycle ghi thêm "bỏ qua X event kỳ khóa" ở phần Build và phần Post (tách riêng); Popconfirm "Xóa dữ liệu test" ghi "Bị từ chối khi còn kỳ đang khóa sổ".
- `/raw/orders`, `/raw/[source]` — kết quả Import có dòng "Từ chối do kỳ khóa" = `LockedRows` khi > 0; lý do từng dòng ở bảng lỗi.
- `/exceptions` — `TYPE_DOCS.PERIOD_LOCKED` (INFO / ERROR, §6.8).
- `/master` — 1 dòng dẫn sang `/periods` (kỳ không nằm trong Google Sheet, Sync không đụng tới).

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
- Thao tác mới ghi/xóa dữ liệu giao dịch (raw, event, GL, exception): đọc `loadPeriodLocks(tx)` **trong** transaction, thêm `...notLocked(locks, ComCode, kỳ)` vào điều kiện ghi/xóa, đếm phần bị bỏ qua bằng `lockedWhere` và báo qua trường `Locked*` (§6.12). Không kỳ nào khóa thì SQL phải giữ nguyên để không lệch baseline.
- Thêm cột GL/Event: cập nhật `gl-columns.ts`, `field-docs.ts`.
- ESLint: biến bắt đầu bằng `_` được phép không dùng (`eslint.config.mjs`).

---

## 10. Testing & baseline

### 10.1 Cấu trúc

**Test chạy trên chính 4 file dữ liệu thật trong `data/samples/`, không dùng file mẫu cắt nhỏ.** Vì vậy `npm test` mất ~10 phút và đỉnh RSS ~10GB; đừng dùng làm vòng lặp phát triển, hãy chạy từng file (`npx vitest run tests/engine/post.test.ts`).

- `vitest.config.mts` chia **2 project**:
  - `engine` (`tests/engine/**`): `isolate: false` + `maxWorkers: 1` → mọi file dùng chung 1 tiến trình nên cache parse trong fixtures có tác dụng (parse lại mỗi file mất ~70s).
  - `integration` (`tests/integration/**`): `isolate: true`, `maxWorkers: 1` — bắt buộc, vì mỗi file tự set `DATABASE_PATH` ở module scope còn `getDb()` cache connection trên `globalThis`.
  - `fileParallelism: false` ở cả hai: 2 suite nặng chạy song song là 2 × ~10GB RSS.
  - `testTimeout`/`hookTimeout` = 600s. `npm test` bọc `cross-env NODE_OPTIONS=--max-old-space-size=12288`.
- `tests/helpers/fixtures.ts`:
  - `loadMasters()` / `loadIndex(overrides?)` – master từ `data/seed/*.csv` (không cần DB), riêng Company lấy bộ cố định `TEST_COMPANIES` (`ZENIROXPAY`, `ONTARIO` đều USD — `ONTARIO` thật là CAD nhưng test đổi cổng cần cùng tiền). `TEST_GATEWAY_MAPPINGS` lấy **mọi cổng `ZENIROXPAY` từ `data/seed/gateway-company-mapping.csv`** (13 tên): file order thật dùng 13 tên cổng, thiếu 1 tên là hàng nghìn dòng thành `MISSING_COMCODE`.
  - `seedTestCompanies(db)` – test integration gọi ngay sau `getDb()` để thay Company/Gateway vừa seed từ snapshot bằng bộ cố định trên.
  - `loadSampleOrders(file?)` / `loadSample{Paypal,Stripe,Pipo}(file?)` – đọc file thật qua `readTable` + normalizer thật, **memo hóa theo tên file** trong 1 tiến trình. Dòng hỏng (thiếu OrderId) bị bỏ qua chứ không throw — import thật cũng loại ra.
  - `loadOrderRecords()` – bảng thô (chuỗi nguyên bản) để test integration dựng lại CSV.
  - `scenarioRows()` / `scenarioRecords()` – **tập con kịch bản**: 431 dòng gồm 3 ngày giao (2025-11-20/21/22) + các dòng chưa fulfill trả tiền trong 11/2025. Chọn vì nó **thuần kỳ 202511** (giữ nguyên mọi `periodFrom/To = "202511"` của test cũ), có cả 2 cổng cần cho kịch bản remap, và chứa 2 đơn mốc `MTUBV-181125-51MRR` / `QVAJV-191125-Q1Z3V`. `SCENARIO_FREE_DAY = 2025-11-30` là ngày trống cùng kỳ dùng khi kịch bản cần dời ngày giao.
  - `toCsv()` / `oneRowCsv()` – dựng CSV đúng thứ tự cột; `oneRowCsv` chỉ gửi header + 1 dòng đã sửa, thay cho việc import lại cả file để mô phỏng "sửa tay 1 dòng".
  - `toEventRows(drafts, startId=1000)` – giả lập insert DB (gán AccountingEventID).
- **Suite nào chạy full, suite nào chạy tập con:**

| File | Dữ liệu | Thời gian |
|---|---|---|
| `engine/parse.test.ts` | full (+ round-trip .xlsx dựng trong bộ nhớ từ 200 dòng đầu) | ~70s |
| `engine/build-orders.test.ts`, `engine/post.test.ts` | full 55.111 dòng | dùng chung cache |
| `engine/build-bank.test.ts` | full 3 file bank | ~40s |
| `engine/post-guard.test.ts`, `engine/reconcile-events.test.ts` | **tập con 431 dòng** (nhóm "khóa sổ" thêm 4 dòng Stripe 11/2025 từ file thật) | vài giây khi dùng chung cache; `reconcile-events` chạy riêng ~110s (phần lớn là parse file) |
| `engine/period-lock.test.ts` | không dùng file mẫu (chỉ master qua `loadIndex()`) | ~1s |
| `integration/flow.test.ts` | **full** — vòng Import → Build → Post → Unpost → Unbuild → Build/Post lại | ~4,5 phút |
| `integration/bank-sources.test.ts` | full (chu kỳ Unpost/Unbuild chạy trên Stripe cho nhanh) | ~2,5 phút |
| `integration/bank-unbuild.test.ts` | lát nhỏ từ file ngân hàng thật | vài giây |
| `integration/gateway-remap.test.ts`, `integration/posted-guards.test.ts` | **tập con 431 dòng** | vài giây |
| `integration/period-lock.test.ts`, `integration/periods.test.ts` | **tập con 431 dòng** + vài chục dòng đầu `Bank_Stripe.csv` / `Bank_Paypal.csv` | vài giây (2 file + `engine/period-lock` ~13s) |
| `integration/seed.test.ts` | không dùng file mẫu | ~1s |

- `tests/engine/reconcile-events.test.ts` – mô phỏng `runBuildOrders` (phạm vi trọn đơn, load event theo OrderID, SourceID đang build / đã chết / ngoài phạm vi): đổi mapping/RuleSeq/cách viết JTC/ngày giao sau khi post, 1 item chuyển ngày trong khi ngày cũ còn item, event ngày cũ chưa post bị xóa, dữ liệu trùng có sẵn, event cũ chưa có ItemCodes, item đến muộn, sau khi Unpost, thêm rule, amount về 0, gỡ mapping, đơn nhiều cổng. Mọi kỳ vọng số lượng **suy từ dữ liệu** (`TOTAL`, `STRIPE_EVENTS`, `PRODUCT_EVENTS`, `PROFIT_EVENTS`) chứ không ghi cứng.
- `tests/integration/gateway-remap.test.ts` – DB tạm riêng: post → đổi mapping Stripe → ONTARIO → Build chặn 123 event → Post không ghi thêm → Unpost + Build + Post theo ZENIROXPAY kỳ 202511 → Post ONTARIO → ONTARIO 3.976,68 + ZENIROXPAY 39.250,90 = 43.227,58 (tổng không đổi).
- `tests/integration/posted-guards.test.ts` – DB tạm riêng, 7 kịch bản chống ghi sổ trùng (đơn 2 cổng, gỡ/gắn lại mapping, Unpost trước khi import, dòng đã đổi ngày giao sẵn trong DB, Unbuild ComCode mới khi item còn ở ComCode cũ, chốt chặn lúc Post, event POSTED chưa có ItemCodes).
- `tests/engine/period-lock.test.ts` – quy tắc kỳ kế toán (§6.12): `lockKey`/`parseLockKey`/`describePeriod`, `PeriodLocks` (trim + uppercase, bỏ trùng/trống, null → không khóa, `periodsOf` không dính công ty trùng tiền tố), `orderRowRefs` (khóa giá trị mới hoặc cũ đều bắt được; cổng chưa map / chưa giao → không khóa), `LockTally.toExceptions`, `isValidPeriod` (202513, 202500, 189912 sai), `actorError`/`unlockReasonError` (đếm ký tự Unicode), `resolveLockTargets` (targets / khóa đến hết kỳ / lỗi / giới hạn 500), `laterLockedPeriods`, `isBalanced`, `pendingIssues`, `lockMsg`.
- `tests/engine/reconcile-events.test.ts`, nhóm **"reconcileEvents — khóa sổ"** – `plan()` có tham số thứ 5 `isLocked` (helper `lockedAt(...keys)` qua `PeriodLocks`); `relatedPosted` của helper = event POSTED **hoặc** thuộc kỳ khóa, khớp `build.ts` — sửa bộ lọc đó ở `build.ts` thì sửa cả helper. Kịch bản: `isLocked` luôn false / chỉ khóa kỳ không liên quan → plan deep-equal khi không truyền; mọi draft khóa → không insert/replace/remove/heal/cảnh báo; rule tắt → `lockedKept`; đổi cổng Stripe → ONTARIO khi ZENIROXPAY khóa (ERROR `PERIOD_LOCKED`, build lại không nhân đôi); event kỳ khóa chưa post ngoài phạm vi vẫn chặn; ONTARIO khóa (`DRAFT_LOCKED`, event cũ xử lý như không còn sinh ra); ngân hàng đổi ngày ra/vào kỳ khóa (`EVENT_LOCKED`, không lỗi UNIQUE); không heal `ItemCodes` event kỳ khóa.
- `tests/engine/reconcile-events.test.ts`, các ca **`oneEventSetPerSource`** (nguồn ngân hàng, §6.11.6) – dòng đã POSTED bị phân loại lại sang JTC khác → draft ERROR `POSTED_KEY_CHANGED`, event POSTED cũ không bị cảnh báo thêm; cùng dữ liệu mà không bật cờ → plan như trước (Orders không đổi hành vi); các trường hợp hợp lệ không bị chặn.
- `tests/integration/bank-unbuild.test.ts` – DB tạm riêng, tái hiện bug cũ §13.3 #21 trên nguồn ngân hàng: Unbuild (không Unpost) sau khi Post giữ BUILT dòng còn event POSTED, chỉ reset dòng không còn event, preview khớp chạy thật; import lại dòng đã sửa tay `JournalType` bị từ chối với message Unpost + Unbuild; làm theo message thì không ghi sổ trùng; dòng POSTED đổi JournalType thẳng trong DB → Build chặn `POSTED_KEY_CHANGED`, Post không ghi thêm; Unbuild để trống ô nguồn cũng reset raw ngân hàng không còn event (có phạm vi kỳ: xóa cả exception gom nhóm `Period` null của nguồn ngân hàng; có kỳ khóa: dòng ngân hàng kỳ khóa giữ BUILT, tính vào `lockedRawRows`); PayPal 30 dòng.
- `tests/integration/period-lock.test.ts` – DB tạm, kỳ khóa ghi thẳng bằng SQL. Bất biến: dữ liệu kỳ khóa (event, GL, raw, exception trừ tóm tắt INFO) không đổi 1 byte và số `Locked*` khớp phần bị bỏ qua. Kịch bản: Build/Post sau khi khóa (đúng 1 tóm tắt INFO sau 2 lần chạy, Post tóm tắt `BatchID` null, mở khóa thì dọn); Unpost/Unbuild preview + chạy thật; Xóa dữ liệu test bị từ chối rồi được sau khi mở; Import (file giống hệt bỏ qua, sửa Profit bị từ chối, dòng mới 30/11 từ chối – 01/12 nhận, dời ngày ra khỏi kỳ khóa từ chối, dòng chưa giao nhận); đổi cổng Stripe → ONTARIO sau khi khóa (không ghi sổ trùng, làm theo message thì tổng sổ không đổi); kỳ trộn 202511 khóa + 202512 mở; lát Stripe (dòng đổi ngày sẵn trong DB → ERROR `PERIOD_LOCKED`, không lỗi UNIQUE); PayPal (SourceKey có ngày → dòng dời ngày thành dòng raw mới, Build chặn).
- `tests/integration/periods.test.ts` – service + route kỳ kế toán: lưới (DB mới, lọc đủ khoảng kỳ), preview việc dở, khóa thiếu tên/quá dài → 400, khóa ghi dòng + log + `ChecksSnapshot`, khóa lại → `alreadyLocked` không thêm log, khóa đến hết kỳ, đầu vào sai, mở khóa (lý do ngắn → 400, kỳ sau còn khóa, dọn tóm tắt INFO), lịch sử lọc/phân trang, route handler 400/200, Xóa dữ liệu test, Sync (`replaceMasters`) không đụng bảng kỳ, việc dở theo nguồn (raw chưa có công ty → `unassigned`, ComCode lạ, sổ lệch → `GL_IMBALANCED`).
- `tests/integration/seed.test.ts` – snapshot Company/Gateway ⇄ DB.
- `tests/integration/flow.test.ts` – set `process.env.DATABASE_PATH` sang file tạm **trước khi** `await import(...)` các service; xóa file DB ở `afterAll`.

### 10.2 Baseline hồi quy (4 file thật trong `data/samples/`, master snapshot hiện tại)

Sinh lại bằng `npm run audit -- orders|paypal|stripe|pipo` (chạy Import → Build → Post trên DB riêng, in đủ số liệu + thời gian + RSS).

**Orders — `order-data.csv`**

| Chỉ số | Giá trị |
|---|---|
| Dòng file / dòng hợp lệ | 55.112 / **55.111** (1 dòng thiếu OrderId ở dòng 27342) |
| FULFILLED / bỏ qua | 52.437 / 2.674 |
| AccountingEvent | **156.233** = PRODUCT 52.437 + SHIPADD 51.309 + SELLER_PROFIT 52.304 + TAX 183 |
| Event ERROR sau build | **2.388** (`MISSING_PARTNER` — seller chưa có trong Partners) |
| Exception sau build | 58.577 = AMOUNT_ZERO 53.515 + NOT_FULFILLED 2.674 + MISSING_PARTNER 2.388 |
| Post Single | NOTHING_TO_POST (Orders đều Bulk) |
| Post Bulk | **3.397 chứng từ, 6.794 dòng GL**, 153.845 event POSTED |
| Σ Nợ = Σ Có | **4.013.848,04** |
| Kỳ | 202511 → 202605 |
| Ngày 20/11/2025 | Product 2.230,66 · ShipAdd 164,67 · cong2672000@gmail.com 397,04 · lyndylutz@gmail.com 145,00 · nguyenthang5356@gmail.com 1.027,68 |
| Order `MTUBV-181125-51MRR` | PRODUCT 34,99 · SHIPADD 4,99 · SELLER_PROFIT 28,42 (TaxID `VA4ZH4IIFMUTCFCXF1GY`, `FFT-FFT ARG`) |

**3 nguồn ngoài Orders**

| Nguồn | File | Dòng | Event | Chứng từ | Dòng GL | Σ Nợ = Σ Có | Ghi chú |
|---|---|---:|---:|---:|---:|---:|---|
| PayPal | `Bank_Paypal.csv` | 142.659 | **198.243** | 4.778 | 10.260 | **6.986.394,87** | 1 dòng ERROR `MISSING_JOURNAL_TYPE` (`PP_GENERAL_CURRENCY_CONVERSION`); 37 dòng exception gom nhóm |
| Stripe | `Bank_Stripe.csv` | 1.413 | **2.712** | 287 | 928 | **123.799,26** | 70 dòng `reserved_funds` bỏ trống JournalType → `STRIPE_RESERVE` |
| PIPO | `Bank_Pipo.csv` | 952 | **968** | 968 | 1.936 | **3.223.254,07** | 3 dòng bị bỏ (2 `Retrieved` + 1 Status trống) |

**Tập con kịch bản** (431 dòng, thuần kỳ 202511): 1.205 event · 50 chứng từ · 100 dòng GL · Σ **43.227,58**; 41 đơn qua cổng Stripe = 123 event.

Mọi chứng từ phải cân Σ Nợ = Σ Có (`assertBalanced` throw nếu lệch). Nếu thay đổi làm lệch các số này mà không cố ý đổi nghiệp vụ → là bug.


### 10.3 Test trình duyệt (tùy chọn, chưa có trong repo)
Có thể dùng `playwright-core` với Edge có sẵn: `chromium.launch({ channel: "msedge" })`, chạy dev server, `setInputFiles` vào `input[type=file]` của trang `/raw/orders`, bấm các nút Build/Post, kiểm tra text "4,013,848.04", bắt `page.on("console")` để phát hiện lỗi/cảnh báo. Lưu ý antd render trùng text (dùng `.filter({ visible: true })`), tên nút có kèm aria-label icon (VD `rollback Unbuild`).

---

## 11. Hướng dẫn mở rộng

### 11.1 Thêm nguồn dữ liệu mới

PayPal / Stripe / PIPO **đã làm xong** — xem §6.11. Phần dưới là cách thêm nguồn **mới** (VD Payoneer), tận dụng lại khung có sẵn.

Nếu nguồn mới cũng có dạng "1 dòng sao kê ngân hàng/PSP → N bút toán" thì **không phải viết engine mới**, chỉ cần khai báo:

1. **Lấy file mẫu thật** và đọc yêu cầu trong `tai lieu du an.md`. Đối chiếu output với `data/samples/gltrans-reference.csv` (có sẵn dòng GL PayPal thật).
2. **Schema:** thêm bảng raw vào `schema.ts` dùng lại `bankRawColumns()` (`SourceKey` unique, `PostingDate`, `BuildStatus`, `RowHash`…) + các cột sheet giữ **đúng tên header** → `npm run db:generate`.
3. **Cột:** thêm danh sách cột + `SOURCE_META` + `SHEET_COLUMNS` vào `src/lib/sources/columns.ts` (client-safe, không import `node:*`).
4. **Normalize:** thêm `normalize<Source>Row` vào `src/lib/sources/normalize.ts`. Chọn `SourceKey` theo quy tắc §6.11.3 — **không được phụ thuộc cột người dùng điền tay**.
5. **Spec engine:** thêm `src/lib/engine/sources/<source>.ts` implement `BankSourceSpec` (thuần khai báo). Không viết quy tắc kế toán ở đây — chúng nằm trong `build-bank.ts`.
6. **Đăng ký:** thêm adapter vào `adapterOf` (`services/import-source.ts`, kèm `eventDataSource` = `spec.dataSource`), `builders` (`services/build-source.ts`, kèm `columns` ComCode/PostingDate/SourceKey — dùng cho kỳ khóa và "dòng không còn event" khi Unbuild) và `RAW_SOURCE_TABLES` (`services/queries.ts`). Khóa sổ (§6.12): thêm bảng raw vào `RAW_SOURCE_TABLES` của `services/clear.ts` (`lockedSourcePeriods`) và `RAW_SPECS` của `services/periods.ts` (lưới kỳ + việc dở).
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
> Các bảng/hàm dưới đây là **đề xuất, chưa có trong code** (trừ mục ghi "đã làm").

- **Accounting Period lock** (§4.3): **đã làm** — §6.12. Không dùng kiểu `assertPeriodsOpen` ném lỗi cả lệnh như đề xuất cũ: Import từ chối từng dòng, lệnh phạm vi rộng bỏ qua phần kỳ khóa và báo số lượng, chỉ "Xóa dữ liệu test" bị từ chối. Còn lại: trạng thái đóng vĩnh viễn (CLOSED) + phân quyền khóa/mở khi có đăng nhập; tự nhận người thao tác từ tài khoản thay cho tên gõ tay.
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
| Event ERROR `POSTED_KEY_CHANGED` sau khi sửa GatewayCompanyMapping / RuleSeq / ngày giao, hoặc (ngân hàng) dòng đã post ra JournalType khác | Item / dòng đã ghi sổ dưới khóa cũ; tạo event NEW sẽ ghi sổ trùng (§6.2, §6.11.6) | Trang Posting → Unpost theo ComCode + kỳ cũ nêu trong message → Build (gồm kỳ/ComCode mới nếu message ghi) → Post cả ComCode cũ và mới |
| Import lỗi "Dòng đã ghi sổ (event …, POSTED)…" / "Dòng còn nằm trong AccountingEvent chưa post…" dù dòng không BUILT | Item của dòng còn nằm trong event (đã post hoặc chưa); đổi dữ liệu rồi Build + Post sẽ ghi sổ trùng (§6.1) | Unpost + Unbuild (hoặc chỉ Unbuild nếu chưa post) theo ComCode + kỳ nêu trong message rồi import lại |
| Import PayPal/Stripe/PIPO lỗi "Dòng đã ghi sổ (…, POSTED) và dữ liệu thay đổi → Unpost + Unbuild {DataSource} ComCode X kỳ P trước khi import lại", kể cả ngay sau khi vừa Unbuild | Dòng còn event POSTED: Unbuild không kèm Unpost giữ event đó và giữ dòng BUILT (§6.4, §6.11.6) | Unpost + Unbuild đúng nguồn + ComCode + kỳ nêu trong message → import lại → Build → Post. Message "…chưa post… → Unbuild …" thì chỉ cần Unbuild |
| Import lỗi "Dòng thuộc X kỳ P đã khóa sổ → không nhận" / "Dòng còn nằm trong event … thuộc X kỳ P đã khóa sổ" | Giá trị mới hoặc cũ của dòng (hoặc event chứa nó) thuộc kỳ LOCKED (§6.12) | Dữ liệu về muộn thật: trang Kỳ kế toán → mở khóa (ghi lý do) → Import → Build → Post → khóa lại (§6.12.7) |
| Build/Post báo "bỏ qua … thuộc kỳ đã khóa sổ", `LockedSkipped`/`LockedEvents` > 0, exception INFO `PERIOD_LOCKED` | Phạm vi chạy chứa công ty × kỳ đang LOCKED — bình thường, dữ liệu kỳ đó giữ nguyên | Không cần làm gì; muốn ghi lại thì mở khóa kỳ đó |
| Event ERROR / exception ERROR `PERIOD_LOCKED` | Dòng ở kỳ mở đụng event thuộc kỳ khóa (đổi ngày / đổi cổng ra khỏi kỳ khóa, trùng item) | Mở khóa kỳ nêu trong message → Unpost/Unbuild kỳ đó → Build + Post → khóa lại |
| Unpost / Unbuild "không có gì để làm" dù có dữ liệu | Mọi thứ trong phạm vi thuộc kỳ khóa (`lockedDocuments`/`lockedEvents` > 0) | Mở khóa kỳ đó trước |
| "Xóa dữ liệu test" / `npm run db:clear` báo "Còn N kỳ đang khóa sổ…" | Còn kỳ LOCKED (kể cả kỳ trống) | Mở hết khóa ở trang Kỳ kế toán rồi chạy lại; hoặc `npm run db:reset` (mất cả bảng kỳ) |
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

-- Kỳ đang khóa sổ + lịch sử khóa / mở khóa (§6.12)
SELECT * FROM AccountingPeriod WHERE Status = 'LOCKED' ORDER BY ComCode, Period;
SELECT ID, CreatedAt, ComCode, Period, Action, ActorName, Reason FROM AccountingPeriodLog ORDER BY ID DESC LIMIT 50;

-- Phần bị bỏ qua vì kỳ khóa (tóm tắt INFO) và các chỗ bị chặn (ERROR)
SELECT BatchType, BatchID, Severity, ComCode, Period, SourceKey, Message
FROM ExceptionLog WHERE ExceptionType = 'PERIOD_LOCKED' ORDER BY Severity, ComCode, Period;

-- Event / dòng GL của 1 kỳ (cùng cách so khớp với notLocked)
SELECT PostStatus, count(*) FROM AccountingEvent
WHERE upper(trim(coalesce(ComCode,''))) || '|' || trim(coalesce(Period,'')) = 'ZENIROXPAY|202511' GROUP BY PostStatus;
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
- **Giả định của 3 nguồn ngoài Orders (2026-09-21)** — xem §6.11.8 cho danh sách master data đã thêm, tất cả cũng phải đưa vào Google Sheet:
  - Tài khoản GL của thẻ MasterCard (`11202091`) là **tài khoản mới do dự án đặt**, không có trong CoA gốc.
  - PIPO dùng `JournalType` của `DataSource = PIPO` mới thêm, với `BankAccount = 11202061`. Tài liệu §5.1 coi PIPO là DataSource riêng nhưng master chưa có dòng nào.
  - `PostingDate` của Stripe lấy cột `Date` (ngày balance transaction), không phải `Created (UTC)` hay `Available On (UTC)` — tài liệu không nói rõ.
  - 1 dòng PayPal `General Currency Conversion` (`PP_GENERAL_CURRENCY_CONVERSION`) **cố ý để lỗi** `MISSING_JOURNAL_TYPE`: master chỉ có `PP_USER_INITIATED_CURRENCY_CONVERSION`. Chưa tự suy diễn vì là quyết định nghiệp vụ — thêm dòng JournalType vào sheet nếu muốn ghi sổ dòng này.
- **Khóa sổ (§6.12), quy ước dự án tự chốt theo nghiên cứu:** khóa theo công ty × tháng dương lịch; kỳ của dữ liệu = kỳ `FulfilledAt` (Orders) / `PostingDate` (3 nguồn kia) — trùng `AccountingEvent.Period`. Đổi cổng sang công ty có kỳ đã khóa thì event chưa post của công ty cũ bị xóa còn draft công ty mới bị bỏ qua → đơn tạm không có event tới khi mở khóa (chỉ báo `LockedSkipped` + INFO) — cần nghiệp vụ xác nhận.

### 13.2 Hạn chế kỹ thuật
- Tài khoản trên event là bản copy lúc Build; rule/tỷ giá/CoA đọc lúc Post.
- `hasAccount` trả true nếu CoA rỗng.
- `loadMasterIndex` đọc toàn bộ master mỗi lần gọi (không cache).
- Build lọc ComCode trong JS (load hết raw theo kỳ); Post load hết candidate vào bộ nhớ; export và `listMaster` (trừ partners) load toàn bộ → chưa tối ưu cho dữ liệu lớn. Đo lại 2026-09-24 trên `order-data.csv` (55.111 dòng → 156.233 event → 3.397 chứng từ): Import ~78s (CSV mang ngày dạng chuỗi nên `normalizeOrderRow` phải chạy vòng thử 8 format của dayjs cho từng cột ngày — đây mới là nút cổ chai, không phải khâu parse CSV vốn chỉ ~0,5s); Build lần đầu ~23s; Build khi phải replace toàn bộ 50–78s; Post ~6s; RSS 4–10GB; Export Excel toàn bộ AccountingEvent 4–5 phút. Build/Post chạy đồng bộ trong request → chặn server Next trong lúc chạy; nên Build theo kỳ + ComCode.
- **Nguồn ngoài Orders chạy cùng kiểu đồng bộ, không chunk** (lựa chọn có ý thức khi làm §6.11). Đo lại 2026-09-24 trên `Bank_Paypal.csv` (142.659 dòng): import ~47s, Build ~30s (198k event), Post ~8s; RSS đỉnh ~6,5 GB. `npm run dev`/`start`/`test` đã bọc sẵn `cross-env NODE_OPTIONS=--max-old-space-size=12288` — bỏ ra là dễ OOM. Nếu vẫn OOM thì hướng sửa là đọc/ghi theo lô ~5.000 dòng trong `importSourceFile` và `runBuildSource`.
- Unbuild theo ComCode cũng reset raw có `ComCode` null; lọc kỳ bỏ qua raw không có `FulfilledAt`.
- `runBuildSource` lọc kỳ bằng so sánh chuỗi `PostingDate` với `YYYY-MM-01`…`YYYY-MM-31` (không dùng `periodOfDateColumn`) → dòng không có `PostingDate` bị bỏ khi có lọc kỳ.
- Unpost không reset event `SKIPPED` / `ERROR` giai đoạn POST.
- Không audit log thao tác (ngoài lịch sử khóa/mở khóa kỳ `AccountingPeriodLog`), không auth. Giới hạn của khóa sổ: §6.12.8.
- SQLite 1 process; không phù hợp nhiều instance.
- `INVALID_FULFILLED_DATE` chưa dùng.
- Chưa có test trình duyệt trong repo.

### 13.3 Bug / rủi ro đã biết (chưa sửa)

Phát hiện khi rà soát tài liệu với code. Khi sửa, thêm test tái hiện và xóa dòng tương ứng ở đây. Số thứ tự giữ nguyên để không lệch tham chiếu (đã sửa: #3, #4, #13 – xem §6.2; #12 – `TYPE_DOCS` đã có `UNKNOWN_AMOUNT_SOURCE`; #21 – Unbuild ngân hàng chỉ reset dòng raw không còn event, Import chặn dòng đổi nội dung còn event, Build chặn dòng đã post bị phân loại lại – xem §6.4, §6.11.6; cùng lần đó: Unbuild để trống ô nguồn nay reset cả raw ngân hàng không còn event – §6.4 bước 5).

| # | Vấn đề | Vị trí | Hướng sửa gợi ý |
|---|---|---|---|
| 1 | File .xlsx có ô tiêu đề trống giữa các cột → `canonicalHeaders` gọi `.trim()` trên phần tử undefined → HTTP 500 (đã tái hiện) | `src/lib/io/read-table.ts` (`headerOf` dùng `.map` trên mảng thưa), `src/lib/orders/normalize.ts` (`canonicalHeaders`) | Dùng `Array.from(values, ...)` hoặc `h ?? ""` trước khi trim |
| 2 | Body JSON hỏng / `postBatchId` không phải số → `/api/unpost`, `/api/unbuild` chạy thật trên toàn bộ dữ liệu | `src/lib/api.ts` (`jsonBody`, `int`, `bool`) | Ném `BadRequestError` khi JSON hỏng hoặc tham số sai kiểu |
| 5 | Bulk post bổ sung sinh chứng từ mới trùng `PostingGroupKey` | `src/lib/engine/post.ts` | Chấp nhận (mỗi batch 1 chứng từ) hoặc gom vào chứng từ cũ |
| 6 | `hasAccount` không xét `CoA.Status` (TK inactive vẫn qua) | `src/lib/engine/masters.ts` | Chỉ nạp TK `Status = Active` |
| 7 | `NegativeMode` lạ → SIGNED; `RateType` khác `DIV` → MUL, không báo lỗi | `src/lib/engine/post.ts`, `src/lib/engine/resolve-fx.ts` | Validate khi parse master |
| 8 | Unbuild lọc raw theo `RawOrders.ComCode` đã lưu (+ item của event bị xóa), Build lọc theo mapping hiện tại → dòng raw có ComCode lưu cũ mà không có event nào có thể không được reset khi mapping đổi (không gây ghi sổ trùng: import vẫn báo "Unbuild trước", Build vẫn build lại) | `src/lib/services/clear.ts`, `src/lib/services/build.ts` | Thống nhất 1 cách xác định ComCode |
| 9 | Exception POST mồ côi sau rebuild/Unbuild; Unbuild có scope không xóa exception ComCode/Period null | `src/lib/services/build.ts`, `src/lib/services/clear.ts` | Xóa exception theo event bị xóa |
| 10 | `parseDate` fallback lỏng đổi ISO có `Z` sang giờ máy chủ (có thể lệch ngày); không hỗ trợ `DD/MM/YYYY`. *(Đã sửa phần nguy hiểm nhất: chuỗi 5–6 chữ số nay hiểu là serial Excel — trước đây `"46023.43107"` rơi vào fallback lỏng ra **năm 4602** mà không báo lỗi.)* | `src/lib/engine/parse.ts` | Parse UTC cho chuỗi có timezone; thêm tùy chọn định dạng khi import |
| 11 | `/api/orders`, `/api/exceptions` không validate/uppercase `comCode`, kỳ | route tương ứng | Dùng `parseScope` |
| 14 | Build/Post/Export chạy đồng bộ trong request: Build toàn bộ file thật khi phải replace 50–78s, chặn mọi request khác; bấm Build 2 lần chạy chồng | `src/lib/services/build.ts`, `src/app/api/build/route.ts` | Chạy nền (job + polling), khóa 1 Build/Post tại 1 thời điểm; bỏ qua replace event không đổi |
| 15 | Tiến trình bị kill giữa Build/Post → `BuildBatch`/`PostingBatch` kẹt `RUNNING` mãi (dữ liệu vẫn rollback đúng) | `src/lib/services/build.ts`, `src/lib/services/post.ts` | Đánh dấu batch RUNNING cũ là FAILED khi khởi động |
| 16 | Export Excel toàn bộ AccountingEvent (156k dòng) mất 4–5 phút, RSS tới ~7.8GB | `src/lib/services/export.ts` | Dùng ExcelJS streaming writer hoặc CSV |
| 17 | Dòng `FULFILLED` nhưng trống `FulfilledAt` chỉ bị bỏ qua với exception INFO `NOT_FULFILLED` (lẫn trong hàng nghìn dòng UNFULFILLED bình thường) | `src/lib/engine/build-orders.ts` | Tách mức WARNING/ERROR riêng cho FULFILLED thiếu ngày |
| 18 | `storeNameMatches` không nhận tiền tố `VICBEA-` (`Lausan` ≠ `VICBEA-Lausan`) và dùng `endsWith(" " + store)` nên `ACZ` khớp nhầm cả `FFT-OLD ACZ`. Hệ quả: 2.385/2.388 event `MISSING_PARTNER` của Orders là do so tên, không phải thiếu partner. Ở nguồn ngân hàng, `resolvePartnerByCode` khi mơ hồ chỉ cảnh báo WARNING `MISSING_PARTNER` (`…|AMBIGUOUS`, gom nhóm) rồi **vẫn ghi sổ với partner đầu tiên có TaxID**, có thể sai store. Vd store Lausan của `vicbeamanager@gmail.com` ra `FFT-PMH-InfluencePick` | `src/lib/engine/resolve-partner.ts` | So bằng tuyệt đối sau khi bỏ `^(FFT\|WFF\|VICBEA\|MESI PAY)-` ở PartnerName và `FFT ` đầu ở cả hai phía — xem [`BA_PREFILL_SOURCES.md`](BA_PREFILL_SOURCES.md) §2.5, §6.3 |
| 19 | `resolveSeller` bước 1 tra cột `TaxID` của order trên **mọi loại** partner, nhưng cột này là mã thuế người mua tự gõ (13/55.111 dòng, vd `Norway`, `I dont have one`); người mua gõ `TAX`/`PAYPAL` sẽ khớp nhầm partner OTHER. Nhánh lỗi còn ghi `PartnerTaxID = TaxID người mua` lên event | `src/lib/engine/resolve-partner.ts`, `src/lib/engine/build-orders.ts` | Bỏ bước này; thay bằng mã store (`StoreId`) khi export có cột đó, chỉ tra trong partner loại Seller |
| 20 | Dòng master `PP_PROTECTION_BONUS_PAYOUT` có tên gốc gộp 3 mô tả ngăn bằng dấu phẩy, `jtByNativeType` dùng nguyên chuỗi làm khóa nên fallback theo `Description` không bao giờ khớp mã này | `src/lib/engine/masters.ts` | Tách alias theo `,` và trim từng phần |
| 22 | Dòng raw chưa có ComCode (cổng chưa map; file ngân hàng trống ComCode) không thuộc công ty nào → Import vẫn nhận dù ngày thuộc kỳ khóa. Build sau khi bổ sung mapping vẫn bị chặn (Orders so cả ComCode theo mapping hiện tại) nên không ghi được vào kỳ khóa, nhưng dòng nằm chờ trong raw và trang Kỳ kế toán chỉ cảnh báo `RAW_NO_COMCODE` | `src/lib/services/import-orders.ts`, `src/lib/services/import-source.ts` | Từ chối (hoặc cảnh báo riêng) dòng không xác định công ty khi cùng kỳ có công ty đang khóa |
| 23 | `npm run db:reset` xóa file DB → mất `AccountingPeriod` + `AccountingPeriodLog` (trạng thái khóa và lịch sử), không cảnh báo, không có bản export | `scripts/reset-db.ts` | Từ chối/cảnh báo khi còn kỳ LOCKED, hoặc export 2 bảng kỳ trước khi xóa |
| 24 | Người khóa / mở khóa là tên gõ tay (nhớ ở `localStorage`), không xác thực; ai mở được trang đều mở khóa được | `src/app/periods/page.tsx`, `src/lib/services/periods.ts` | Gắn với đăng nhập + phân quyền (tài liệu gốc §20) |

---

## 14. Thuật ngữ

| Thuật ngữ | Nghĩa |
|---|---|
| **ComCode** | Mã công ty ghi sổ (ở đây = cổng thanh toán) |
| **FncCurr / InputCurr** | Tiền hạch toán của công ty / tiền giao dịch nguyên tệ |
| **DataSource** | Nguồn dữ liệu: ORDERS, PAYPAL, STRIPE, PIPO |
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
| **Kỳ kế toán / khóa sổ** | Công ty × tháng (`ComCode`, `YYYYMM`) trong `AccountingPeriod`; `LOCKED` = không Import/Build/Post/Unpost/Unbuild dữ liệu kỳ đó (§6.12) |
| **ChecksSnapshot** | JSON việc dở của kỳ (raw chưa build/lỗi, event NEW/ERROR, GL, Σ Nợ/Có) lưu kèm mỗi lần khóa / mở khóa |

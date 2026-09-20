# Sky Finance – Accounting Engine (luồng Orders)

Web kế toán thử nghiệm: **file order thô → AccountingEvent → PostingBatch → GLTrans (sổ cái) + Export Excel**.
Next.js 16 (FE + API) · antd 6 · SQLite (file `data/finance.db`) · không có đăng nhập.

> Tài liệu kỹ thuật chi tiết (kiến trúc, từng tính năng, API, cách mở rộng, debug): [docs/DEVELOPER_GUIDE.md](docs/DEVELOPER_GUIDE.md)

## Chạy

```bash
npm install
npm run dev          # http://localhost:3000
```

Lần chạy đầu tự tạo DB và nạp master data từ `data/seed/*.csv` (snapshot Google Sheet).

Thử nhanh: Dashboard → **Import file order mẫu** → **Chạy full cycle** → trang **4. GLTrans** → **Export Excel**.

| Lệnh | Tác dụng |
|---|---|
| `npm test` | Unit test engine + test tích hợp cả luồng trên DB tạm |
| `npm run db:reset` | Xóa file DB (lần chạy sau tạo lại) |
| `npm run db:seed` | Nạp lại master data từ `data/seed` |
| `npm run db:generate` | Sinh migration khi sửa `src/lib/db/schema.ts` |

## Luồng xử lý

```
File order ──(1) Import──► RawOrders ──(2) Build──► AccountingEvent ──(3) Post──► GLTrans
                              │                      (PostStatus=NEW)        │
                         ImportBatch             BuildBatch + Exception    PostingBatch
```

- **AccountingEvent** – "event nghiệp vụ chuẩn hóa": 1 dòng = 1 giao dịch × 1 JournalLineRule. Có sẵn ngày, kỳ, số tiền, TK, partner nhưng **chưa tách Nợ/Có**. Dùng để kiểm tra lỗi (thiếu seller, thiếu rule…) và build lại mà không đụng sổ cái.
- **PostingBatch** – nhật ký 1 lần bấm Post (phạm vi, Single/Bulk, trạng thái, số dòng GL). Mỗi dòng GL có `PostBatchID` để truy vết/Unpost theo lô.
- **GLTrans** – mỗi dòng là 1 vế Nợ hoặc Có; các dòng cùng `DocNum` luôn cân.

### Build Orders

1. Chỉ lấy `ItemStatus = FULFILLED` có `FulfilledAt` (còn lại ghi exception `NOT_FULFILLED`).
2. `ComCode` = cổng thanh toán: `PaymentGatewayName` → bảng **GatewayCompanyMapping** (sửa ở trang Master). `FncCurr` lấy từ **Company**, `InputCurr` = USD.
3. `PostingDate = FulfilledAt`, `Period = YYYYMM`; gom theo `ComCode + OrderId + PostingDate`.
4. Mỗi nghiệp vụ sinh 1 event (amount = 0 thì bỏ qua):

| JournalTypeCode | Amount | Nợ | Có | Partner |
|---|---|---|---|---|
| ORD_REV_PRODUCT_FULFILLED | Σ Quantity × UnitPrice | 13122001 | 51112001 | INDIVIDUALS |
| ORD_REV_SHIPADD_FULFILLED | Σ ShippingFee + AdditionalCost | 13122001 | 51131001 | INDIVIDUALS |
| ORD_REV_TAX_FULFILLED | Σ TaxFee | 13122001 | 33302001 | INDIVIDUALS |
| ORD_SELLER_PROFIT_FULFILLED | Σ Profit | 63202001 | 33102001 | Seller |

Seller được map theo thứ tự: `TaxID` = `Partners.PartnerTaxID` → `SellerEmail` = `Partners.PartnerCode` (1 email nhiều store thì lọc `PartnerName` = `FFT-{StoreName}` / `FFT-FFT {StoreName}`) → không thấy thì event `ERROR` + exception `MISSING_PARTNER`.

### Post

Join rule theo `JournalTypeCode + RuleSeq = EventSeq` → TK theo `NormalDr/CrAccountSource` → `Amount × AmountFactor` → NegativeMode (SIGNED / REVERSE / ERROR) → tỷ giá (cùng tiền = 1, khác tiền tra bảng Exrate theo kỳ, MUL/DIV).

- **Single**: mỗi event 1 chứng từ, `DocNum = ASI-{yyyyMMdd}-{AccountingEventID}`.
- **Bulk** (toàn bộ Orders): gom theo `PostingGroupKey = ComCode|JournalTypeCode|yyyyMMdd|InputCurr|FncCurr|PARTNER|TaxID|BankAccount` rồi cộng theo TK, `DocNum = ASB-{yyyyMMdd}-{AccountingEventID nhỏ nhất}`.

Giải thích từng cột GLTrans có ở tooltip tiêu đề bảng và mục "Giải nghĩa các cột GLTrans" trên trang GL (`src/lib/field-docs.ts`).

### Kết quả mong đợi với file order mẫu (64 dòng)

60 dòng fulfilled → **174 event** (60 PRODUCT + 58 SHIPADD + 56 SELLER_PROFIT) → Post Bulk **21 chứng từ / 42 dòng GL**, tổng Nợ = tổng Có = **6,339.70**.

### Điều chỉnh

- **Unpost**: xóa GL, event về NEW (theo phạm vi hoặc theo batch).
- **Unbuild**: xóa event chưa post, raw về NOT_BUILT.
- **Unpost + Unbuild**: cả hai. Mọi thao tác có preview số dòng trước khi chạy.
- Import lại file: dòng không đổi → bỏ qua; đổi mà chưa build → thay thế; đổi mà đã build → báo lỗi, phải Unbuild trước.

## Giả định đang dùng (cần xác nhận)

- Bulk GL để trống `ReferenceTxnID/OrderID/RefNum`, `Description = MemoTemplate | {n} events` (sheet GlTrans mẫu chỉ có dòng Single).
- `PartnerTaxID` trên GL lấy từ bảng Partners (với INDIVIDUALS là `INDIVIDUALS`).
- File order không có cột tiền tệ → InputCurr = USD.
- Header cột 6 sheet JournalType đang ghi nhầm `11202052` → đọc như `ContraAccount`.

## Cấu trúc

```
data/seed/            snapshot master data (partners, JournalType, JournalLineRule, CoA, Exrate, MappingBankAccount)
data/samples/         file order mẫu (.csv/.xlsx) + mẫu GlTrans/AccountingEvent/PostingBatch để đối chiếu
drizzle/              migration SQL
src/lib/engine/       logic thuần (không đụng DB): parse, build-orders, post, resolve-partner, resolve-fx, keys
src/lib/services/     điều phối DB: import, build, post, unpost/unbuild, query, export, master sync
src/app/api/          Route Handlers (backend)
src/app/*/page.tsx    màn hình: Dashboard, Raw Orders, AccountingEvent, Posting, GLTrans, Exceptions, Master
tests/                vitest
```

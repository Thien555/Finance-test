# Hướng dẫn mapping chi tiết: File order thô → RawOrders → AccountingEvent → GLTrans

> Tài liệu giải thích **từng bước biến đổi dữ liệu** của nguồn `ORDERS` trong Sky Finance, kèm **số liệu thật** do chính code của repo sinh ra.
> Mục tiêu: đọc xong, bạn tự lần được bất kỳ dòng GLTrans nào về đúng dòng order gốc, và hiểu vì sao nó ra Nợ/Có như vậy.
>
> Tài liệu kỹ thuật tổng quát: [`DEVELOPER_GUIDE.md`](../DEVELOPER_GUIDE.md). Yêu cầu nghiệp vụ gốc: [`tai lieu du an.md`](../../tai%20lieu%20du%20an.md).

---

## Mục lục

- [Phần 0 — Số liệu trong tài liệu lấy từ đâu](#phần-0--số-liệu-trong-tài-liệu-lấy-từ-đâu)
- [Phần 1 — Kiến thức kế toán tối thiểu](#phần-1--kiến-thức-kế-toán-tối-thiểu)
- [Phần 2 — Bức tranh toàn cảnh](#phần-2--bức-tranh-toàn-cảnh)
- [Phần 3 — Master data mà luồng Orders dùng](#phần-3--master-data-mà-luồng-orders-dùng)
- [Phần 4 — Bước 1: Import (file → RawOrders)](#phần-4--bước-1-import-file--raworders)
- [Phần 5 — Bước 2: Build (RawOrders → AccountingEvent)](#phần-5--bước-2-build-raworders--accountingevent)
- [Phần 6 — Bước 3: Post (AccountingEvent → GLTrans)](#phần-6--bước-3-post-accountingevent--gltrans)
- [Phần 7 — Truy vết ngược: từ 1 dòng GL về order gốc](#phần-7--truy-vết-ngược-từ-1-dòng-gl-về-order-gốc)
- [Phần 8 — Ví dụ 2: gom Bulk theo seller (4 đơn → 1 chứng từ)](#phần-8--ví-dụ-2-gom-bulk-theo-seller-4-đơn--1-chứng-từ)
- [Phần 9 — Ví dụ 3: dòng bị loại và khoản tiền bằng 0](#phần-9--ví-dụ-3-dòng-bị-loại-và-khoản-tiền-bằng-0)
- [Phần 10 — Các tình huống mô phỏng (Single, nhiều item, số âm, tỷ giá, lỗi mapping)](#phần-10--các-tình-huống-mô-phỏng)
- [Phần 11 — Kết quả toàn bộ file mẫu và ý nghĩa kế toán](#phần-11--kết-quả-toàn-bộ-file-mẫu-và-ý-nghĩa-kế-toán)
- [Phần 12 — Bảng tra nhanh: cột nào đến từ đâu](#phần-12--bảng-tra-nhanh-cột-nào-đến-từ-đâu)
- [Phần 13 — Từ điển thuật ngữ](#phần-13--từ-điển-thuật-ngữ)
- [Phần 14 — Tự kiểm chứng lại số liệu](#phần-14--tự-kiểm-chứng-lại-số-liệu)

---

## Phần 0 — Số liệu trong tài liệu lấy từ đâu

Toàn bộ số liệu **không phải số minh họa tự nghĩ ra**. Chúng được tạo bằng cách chạy đúng code của repo trên một database SQLite trống:

1. `importOrders(data/samples/orders-sample.csv)`: import file order mẫu 64 dòng — **file này đã gỡ khỏi repo**, số liệu dưới đây giữ nguyên làm ví dụ đã kiểm chứng. Baseline hiện tại (toàn bộ `order-data.csv`) xem `docs/DEVELOPER_GUIDE.md` §10.2.
2. `runBuildOrders()`: build toàn bộ, không giới hạn phạm vi.
3. `runPost("All")`: post Single rồi Bulk.
4. Master data: snapshot `data/seed/*.csv`, kể cả Company và GatewayCompanyMapping (`company.csv`, `gateway-company-mapping.csv`).

Kết quả khớp baseline của dự án: **64 dòng raw → 174 AccountingEvent → 21 chứng từ / 42 dòng GLTrans, Σ Nợ = Σ Có = 6,339.70**.

Lưu ý khi đối chiếu trên máy bạn:

- Các ID tự tăng (`RawOrderID`, `AccountingEventID`, `ID` của GL, `PostBatchID`...) chỉ **giống hệt** tài liệu khi bạn làm trên DB trống và import file mẫu đúng 1 lần. Nếu đã import hay build nhiều lần, ID sẽ khác nhưng số tiền, tài khoản và cấu trúc khóa vẫn giống.
- Các cột thời điểm (`AddDate`, `PostedAt`, `StartedAt`...) là giờ lúc chạy, nên sẽ khác.
- Các mục ghi **"MÔ PHỎNG"** (Phần 10) là kết quả chạy **hàm engine thật** trên dữ liệu đã sửa một chút (VD đổi Classify, đổi dấu số tiền). Chúng không có trong file mẫu, nhưng output vẫn do code sinh ra.

---

## Phần 1 — Kiến thức kế toán tối thiểu

Phần này chỉ gồm những khái niệm cần để đọc hiểu các phần sau.

### 1.1. Bút toán kép: mọi nghiệp vụ đều có vế Nợ và vế Có

Kế toán không ghi kiểu "doanh thu +34.99". Mỗi nghiệp vụ được ghi thành **ít nhất 2 dòng**:

```
Nợ  13122001  34.99
    Có  51112001  34.99
```

- **Nợ** (Debit, Dr) là cột bên trái, **Có** (Credit, Cr) là cột bên phải.
- Trong một chứng từ, **tổng Nợ luôn bằng tổng Có**. Nếu lệch là sai.
- Trong `GLTrans` của hệ thống này, **mỗi dòng là một vế**. Dòng Nợ có `BalanceImpact = Debit` và số tiền nằm ở `InputDr/AccountedDr`. Dòng Có có `BalanceImpact = Credit` và số tiền nằm ở `InputCr/AccountedCr`.

### 1.2. "Nợ" và "Có" không có nghĩa là nợ nần

Đây chỉ là tên hai cột. Ghi vào cột nào thì tài khoản tăng hay giảm phụ thuộc **loại tài khoản**. Cột `AccountType` trong bảng `CoA` có 5 giá trị:

| AccountType (CoA) | Nghĩa | Tăng thì ghi | Giảm thì ghi | Số dư bình thường (`BalanceSide`) |
|---|---|---|---|---|
| `A` | Asset: **Tài sản** (tiền, ví PayPal, khoản phải thu...) | **Nợ** | Có | Dr |
| `Exp` | Expense: **Chi phí** (giá vốn, phí...) | **Nợ** | Có | Dr |
| `L` | Liability: **Nợ phải trả** (phải trả seller, thuế phải nộp...) | **Có** | Nợ | Cr |
| `R` | Revenue: **Doanh thu** | **Có** | Nợ | Cr |
| `E` | Equity: **Vốn chủ sở hữu** | **Có** | Nợ | Cr |

Mẹo nhớ: **Tài sản và Chi phí tăng thì ghi Nợ. Nợ phải trả, Doanh thu và Vốn tăng thì ghi Có.**

### 1.3. Sáu tài khoản mà luồng Orders dùng (lấy từ bảng CoA thật)

| AccountCode | AccountName (nguyên văn trong CoA) | AccountType | BalanceSide | ARAP | Vai trò trong luồng Orders |
|---|---|---|---|---|---|
| `13122001` | Người mua trả tiền trước - Global/CA | A | Dr | AR (Advances from Customers) | Tài khoản trung gian chứa tiền khách đã trả, chờ giao hàng |
| `51112001` | Doanh thu bán hàng - Global (từ nền tảng) | R | Cr | – | Doanh thu tiền hàng |
| `51131001` | Doanh thu dịch vụ - Shipping cost | R | Cr | – | Doanh thu phí ship và phụ phí |
| `33302001` | Thuế phải nộp CA (GST/HST/Payroll tax nếu phát sinh) | L | Cr | – | Thuế thu hộ, phải nộp nhà nước |
| `33102001` | Phải trả Seller - Share profit/Payout | L | Cr | AP (Payable to Suppliers) | Khoản công ty đang nợ seller |
| `63202001` | Giá vốn - SellerCost (chia sẻ cho Seller) | Exp | Dr | – | Chi phí phần lợi nhuận chia cho seller |

`ARAP` cho biết tài khoản có theo dõi công nợ theo từng đối tượng hay không: `AR` là phải thu (Accounts Receivable), `AP` là phải trả (Accounts Payable). Với các tài khoản này, mỗi dòng sổ cần biết **đối tượng là ai**, nên GLTrans có cột `PartnerCode` và `PartnerTaxID`.

(Code **không đọc** cột `ARAP`. Partner được gắn lên dòng GL theo cờ `ApplyPartnerToDrLine/CrLine` của JournalLineRule. Với Orders cả hai cờ đều là 1, nên dòng doanh thu và chi phí cũng có partner.)

### 1.4. Ghi nhận doanh thu khi giao hàng, không phải khi nhận tiền

Theo kế toán dồn tích (accrual), công ty chỉ được coi là "đã có doanh thu" khi **hoàn thành nghĩa vụ**, tức là đã giao hàng. Lúc khách vừa trả tiền, số tiền đó vẫn là "tiền khách ứng trước": nếu khách hủy thì phải trả lại.

Hệ thống thể hiện điều này qua 2 điểm:

- Build chỉ lấy dòng order có `ItemStatus = FULFILLED` và có `FulfilledAt`.
- Ngày ghi sổ `PostingDate` là `FulfilledAt` (ngày giao), không phải `PaidAt` (ngày thanh toán).

### 1.5. Tài khoản trung gian `13122001` nối nguồn thanh toán với nguồn đơn hàng

Công ty (ở đây là cổng thanh toán ZeniroxPay) nhận tiền của khách qua PayPal/Stripe, còn hàng do seller bán. Cấu hình trong master data (đã có trong seed, nhưng **code mới làm nguồn Orders**, chưa làm PayPal) cho thấy vai trò của `13122001`:

```
(Nguồn PAYPAL, ví dụ JournalType PP_EXPRESS_CHECKOUT_PAYMENT, rule BANK_CONTRA, chưa được code)
   Khách trả tiền     :  Nợ 11202051 PayPal - Available (USD)   /  Có 13122001 Người mua trả tiền trước

(Nguồn ORDERS, đã code, là nội dung tài liệu này)
   Đơn đã giao hàng   :  Nợ 13122001 Người mua trả tiền trước   /  Có 51112001, 51131001 (doanh thu), 33302001 (thuế)
```

`13122001` bị ghi Có lúc nhận tiền và ghi Nợ lúc giao hàng. Nếu hai nguồn khớp nhau, số dư còn lại là **tiền đã thu nhưng hàng chưa giao**. Đây là con số đối soát quan trọng giữa nguồn thanh toán và nguồn đơn hàng.

> **Lưu ý về `13122001`: đây là tài khoản lưỡng tính, đừng áp máy móc bảng 1.2.** CoA xếp nó là `A`/`Dr` (nhóm 131 "phải thu khách hàng"), nhưng ở đây nó được dùng làm **"người mua trả tiền trước"**. Theo kế toán Việt Nam, nhóm 131 là tài khoản lưỡng tính, có thể dư Nợ hoặc dư Có:
> - **Dư Có** là tiền khách đã trả mà hàng chưa giao. Bản chất là khoản khách ứng trước, tức một khoản **nợ phải trả** của công ty.
> - **Dư Nợ** là số đã ghi nhận doanh thu/thuế lớn hơn số tiền đã thu: hoặc khách còn phải trả, hoặc số liệu/công thức cần xem lại (VD dư Nợ 3.00 ở [11.4](#114-toàn-bộ-vòng-đời-kế-toán-của-một-đơn-bức-tranh-lớn)).
>
> Vì vậy lúc khách trả tiền ghi **Có** (khoản ứng trước tăng), lúc giao hàng ghi **Nợ** (khoản ứng trước được cấn trừ). Khi chỉ chạy nguồn Orders (chưa có PayPal), tài khoản này chỉ có phát sinh Nợ nên đang hiện dư Nợ.

### 1.6. Seller profit: công ty ghi chi phí và một khoản nợ phải trả seller

Seller là người bán trên nền tảng. Mỗi đơn giao xong, seller được hưởng một phần lợi nhuận (cột `Profit`). Công ty ghi:

```
Nợ 63202001 Giá vốn - SellerCost    (chi phí của công ty tăng)
    Có 33102001 Phải trả Seller      (khoản công ty nợ seller tăng, theo dõi theo từng seller)
```

Sau này khi thực trả tiền cho seller (nguồn ngân hàng, **chưa code**), khoản `33102001` sẽ được ghi Nợ để giảm xuống.

### 1.7. Nguyên tệ, tiền hạch toán và tỷ giá

- **InputCurr** (nguyên tệ): tiền của giao dịch. Với Orders, code cố định là `USD`.
- **FncCurr** (functional currency, tiền hạch toán): tiền mà công ty dùng để lập sổ, lấy từ `Company.FunctionalCurrency`. `ZENIROXPAY` (công ty của file mẫu) và `MESSIPAY` là `USD`, `ONTARIO` là `CAD`, `VICBEA` là `VND`.
- Nếu hai loại tiền khác nhau thì phải quy đổi: `Accounted = Input × XRate` (`RateType = MUL`) hoặc `Input ÷ XRate` (`DIV`). Cùng tiền thì `XRate = 1`.

### 1.8. Chứng từ, sổ cái, kỳ

- **Chứng từ** (voucher, document): một bộ dòng Nợ/Có cân nhau, định danh bằng `DocNum`.
- **Sổ cái** (General Ledger): bảng `GLTrans`, nơi chứa mọi dòng Nợ/Có đã ghi.
- **Kỳ kế toán** (Period): tháng, dạng `YYYYMM`, VD `202511`.

---

## Phần 2 — Bức tranh toàn cảnh

### 2.1. Ba bước và các bảng

```
 FILE ORDER (.csv/.xlsx)
      │
      │ (1) IMPORT  ─ src/lib/services/import-orders.ts
      ▼
 ┌──────────────┐        log: ImportBatch
 │  RawOrders   │  1 dòng file = 1 dòng RawOrders (khóa ItemCode)
 └──────┬───────┘
        │ (2) BUILD  ─ src/lib/engine/build-orders.ts + src/lib/services/build.ts
        ▼
 ┌──────────────────┐   log: BuildBatch + ExceptionLog(BUILD)
 │ AccountingEvent  │  1 nhóm (ComCode+OrderId+ngày giao) × 1 nghiệp vụ = 1 event
 └──────┬───────────┘  (đã có số tiền, tài khoản, partner; CHƯA tách Nợ/Có)
        │ (3) POST   ─ src/lib/engine/post.ts + src/lib/services/post.ts
        ▼
 ┌──────────────┐        log: PostingBatch + ExceptionLog(POST)
 │   GLTrans    │  mỗi dòng = 1 vế Nợ hoặc Có; các dòng cùng DocNum luôn cân
 └──────────────┘
```

### 2.2. Quan hệ số lượng giữa các tầng

| Từ | Sang | Quan hệ | Quy tắc |
|---|---|---|---|
| Dòng file | RawOrders | 1 → 1 | Khóa là `ItemCode` (mã dòng hàng, VD `QVAJV-191125-Q1Z3V-1`) |
| RawOrders | Nhóm order | n → 1 | Các dòng cùng `ComCode + OrderId + FulfilledAt` được cộng dồn |
| Nhóm order | AccountingEvent | 1 → tối đa 4 | 1 event cho mỗi nghiệp vụ PRODUCT / SHIPADD / TAX / SELLER_PROFIT có số tiền khác 0 |
| AccountingEvent | Chứng từ (DocNum) | n → 1 | Bulk: các event cùng `PostingGroupKey`. Single: 1 event = 1 chứng từ |
| Chứng từ | Dòng GLTrans | 1 → 2 (với Orders) | 1 dòng Nợ + 1 dòng Có |

Với file mẫu:

```
64 dòng file ─► 64 RawOrders ─► 60 dòng FULFILLED = 60 nhóm order ─► 174 event ─► 21 chứng từ ─► 42 dòng GL
                   (4 dòng UNFULFILLED bị bỏ qua)     (240 khả năng − 66 khoản bằng 0)
```

Danh sách đủ 18 bảng (vai trò, khóa, bước ghi): [`BA_ACCOUNTING_ENGINE.md` mục 21](../Docs-BA/BA_ACCOUNTING_ENGINE.md#21-bảng-dữ-liệu).

### 2.3. Ví dụ xuyên suốt

Phần 4 → 7 bám theo **một đơn thật**: `QVAJV-191125-Q1Z3V`, store `JJC`, seller `nqcuong.0525@gmail.com`, giao ngày 21/11/2025. Đơn này được chọn vì:

- có `AdditionalCost = 3` (dòng duy nhất trong file có giá trị này), nên thấy rõ công thức SHIPADD;
- có `TaxFee = 0`, nên thấy cơ chế bỏ qua khoản bằng 0;
- seller có trong bảng Partners, nên thấy trọn chuỗi tra partner;
- sau khi post, 3 event của nó rơi vào 3 chứng từ khác nhau: 2 chứng từ gom 23 đơn và 1 chứng từ riêng của seller.

---

## Phần 3 — Master data mà luồng Orders dùng

Master data là **bảng cấu hình**. Engine không viết cứng tài khoản hay chiều Nợ/Có, mà đọc từ các bảng dưới đây. Mỗi lần Build/Post, service load lại toàn bộ master (`loadMasterIndex`), nên sửa master có hiệu lực ngay lần chạy sau. Mọi phép so khớp mã đều theo kiểu **trim + UPPERCASE**, trừ mã tài khoản CoA chỉ trim.

### 3.1. `GatewayCompanyMapping`: cổng thanh toán → công ty

| ID | PaymentGatewayName | ComCode | IsActive |
|---|---|---|---|
| 1 | `ZeniroxPay Inc.` | `ZENIROXPAY` | 1 |
| 2 | `ZeniroxPay - Stripe` | `ZENIROXPAY` | 1 |

Cột `PaymentGatewayName` của file order được tra ở đây để ra `ComCode`. Khóa tra là **tên** cổng (không phải `PaymentGatewayId`). Bảng trên chỉ liệt kê 2 cổng mà file order mẫu dùng; snapshot `data/seed/gateway-company-mapping.csv` có 24 cổng (ZeniroxPay và Ontario các loại key). Bảng này không có trong Google Sheet: sửa ở trang Master rồi xuất ra `data/seed` bằng `npm run db:export-seed`.

### 3.2. `Company`: công ty ghi sổ

| ComCode | CompanyName | FunctionalCurrency | IsActive |
|---|---|---|---|
| `MESSIPAY` | MessiPay Partner | USD | 1 |
| `ONTARIO` | Ontario Operations | CAD | 1 |
| `VICBEA` | Vicbea Operations | VND | 1 |
| `ZENIROXPAY` | Zenibox PayPal Partner — ZeniroxPay | USD | 1 |

`FunctionalCurrency` trở thành `FncCurr` của event.

### 3.3. `JournalType`: "header" của nghiệp vụ

Mỗi dòng trả lời 4 câu hỏi: nghiệp vụ tên gì, **4 vai trò tài khoản** gắn với tài khoản cụ thể nào, partner lấy từ đâu, và post kiểu Single hay Bulk.

| JournalTypeID | DataSource | JournalType (tên) | JournalTypeCode | BankAccount | ContraAccount | TransAccount | FeeAccount | Partner | Classify | GroupRule |
|---|---|---|---|---|---|---|---|---|---|---|
| 33 | ORDERS | Orders Fulfilled Product Revenue | `ORD_REV_PRODUCT_FULFILLED` | NULL | `13122001` | `51112001` | NULL | `Fixed = Individuals` | Bulk | PostingDate,Currency,CompanyCode,JournalType |
| 34 | ORDERS | Orders Fulfilled ShipAdd Revenue | `ORD_REV_SHIPADD_FULFILLED` | NULL | `13122001` | `51131001` | NULL | `Fixed = Individuals` | Bulk | PostingDate,Currency,CompanyCode,JournalType |
| 35 | ORDERS | Orders Fulfilled Tax Payable | `ORD_REV_TAX_FULFILLED` | NULL | `13122001` | `33302001` | NULL | `Fixed = Individuals` | Bulk | PostingDate,Currency,CompanyCode,JournalType |
| 36 | ORDERS | Orders Fulfilled Seller Profit | `ORD_SELLER_PROFIT_FULFILLED` | NULL | `33102001` | `63202001` | NULL | `From Source` | Bulk | PostingDate,Currency,CompanyCode,JournalType,Partner |

Giải thích cột:

| Cột | Ý nghĩa | Code dùng thế nào |
|---|---|---|
| `DataSource` + `JournalTypeCode` | Khóa tra cứu | `index.journalType("ORDERS", jtc)` |
| `JournalType` | Tên nghiệp vụ dạng chữ | Copy vào `AccountingEvent.Description` |
| `BankAccount` | Vai trò **tài khoản tiền** (ngân hàng/ví) | Copy vào `Event.BankGLAccount`. Orders để NULL vì không đụng tiền |
| `ContraAccount` | Vai trò **tài khoản đối ứng** (thường là tài khoản công nợ, trung gian) | Copy vào `Event.ContraAccount` |
| `TransAccount` | Vai trò **tài khoản nghiệp vụ** (doanh thu, chi phí, thuế) | Copy vào `Event.TransAccount` |
| `FeeAccount` | Vai trò **tài khoản phí** | Copy vào `Event.FeeAccount`. Orders để NULL |
| `Partner` | `Fixed = X` thì luôn dùng partner X. `From Source` thì lấy seller từ dữ liệu order | Xem [5.6](#56-bước-2e--xác-định-partner) |
| `Classify` | `Single` = mỗi event 1 chứng từ, `Bulk` = gom nhiều event | Đọc **lúc Post** |
| `GroupRule` | Mô tả cách gom | **Chỉ để mô tả**, code không đọc. Khóa gom thật nằm trong `postingGroupKey()` |

> Quan trọng: `JournalType` chỉ nói "nghiệp vụ này dùng tài khoản nào cho từng **vai trò**". Nó **không** nói vai trò nào nằm bên Nợ, vai trò nào nằm bên Có. Việc đó do `JournalLineRule` quyết định.

> File Google Sheet ghi nhầm header cột thứ 6 của JournalType thành `11202052`. Parser đọc cột này **theo vị trí** làm `ContraAccount` (`src/lib/master/parse-master.ts`).

### 3.4. `JournalLineRule`: quy tắc sinh cặp Nợ/Có

| ID | JournalTypeCode | RuleSeq | PairCode | NormalDrAccountSource | NormalCrAccountSource | AmountSource | AmountFactor | NegativeMode | SkipIfDrAccountNull | SkipIfCrAccountNull | SkipIfAmountZero | PartnerMode | FixedPartner | ApplyPartnerToDrLine | ApplyPartnerToCrLine | MemoTemplate | IsActive |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 97 | `ORD_REV_PRODUCT_FULFILLED` | 20 | CONTRA_TRANS | `CONTRA_ACCOUNT` | `TRANS_ACCOUNT` | `PRODUCT` | 1 | SIGNED | 1 | 1 | 1 | HEADER | NULL | 1 | 1 | Orders Fulfilled Product Revenue Bulk \| CONTRA_TRANS | 1 |
| 98 | `ORD_REV_SHIPADD_FULFILLED` | 20 | CONTRA_TRANS | `CONTRA_ACCOUNT` | `TRANS_ACCOUNT` | `SHIPADD` | 1 | SIGNED | 1 | 1 | 1 | HEADER | NULL | 1 | 1 | Orders Fulfilled ShipAdd Revenue Bulk \| CONTRA_TRANS | 1 |
| 99 | `ORD_REV_TAX_FULFILLED` | 20 | CONTRA_TRANS | `CONTRA_ACCOUNT` | `TRANS_ACCOUNT` | `TAX` | 1 | SIGNED | 1 | 1 | 1 | HEADER | NULL | 1 | 1 | Orders Fulfilled Tax Payable Bulk \| CONTRA_TRANS | 1 |
| 100 | `ORD_SELLER_PROFIT_FULFILLED` | 20 | CONTRA_TRANS | **`TRANS_ACCOUNT`** | **`CONTRA_ACCOUNT`** | `SELLER_PROFIT` | 1 | SIGNED | 1 | 1 | 1 | HEADER | NULL | 1 | 1 | Orders Fulfilled Seller Profit Bulk \| CONTRA_TRANS | 1 |

(Cột `ReverseIfNegative = 0` ở cả 4 dòng. Đây là cột cũ, chỉ dùng khi `NegativeMode` trống.)

Giải thích cột:

| Cột | Ý nghĩa | Dùng ở bước |
|---|---|---|
| `JournalTypeCode` + `RuleSeq` | 1 nghiệp vụ có thể có nhiều rule (VD PayPal có 3 rule: 10, 20, 30). Mỗi rule sinh **1 event**. `RuleSeq` được lưu vào `Event.EventSeq` để lúc Post join lại đúng rule | Build, Post |
| `PairCode` | Tên cặp vai trò: `CONTRA_TRANS` là cặp Contra với Trans. Tên này **không** cho biết chiều Nợ/Có | Build (copy vào event), Post (khóa cộng dòng Bulk) |
| `NormalDrAccountSource` | Vai trò tài khoản nằm **bên Nợ** khi số tiền dương | Build (chỉ kiểm tra TK có NULL không để bỏ qua rule), Post (chọn TK Nợ) |
| `NormalCrAccountSource` | Vai trò tài khoản nằm **bên Có** khi số tiền dương | Build (chỉ kiểm tra TK có NULL không để bỏ qua rule), Post (chọn TK Có) |
| `AmountSource` | Lấy số tiền nào của nhóm order: `PRODUCT`, `SHIPADD`, `TAX`, `SELLER_PROFIT` (hoặc `PROFIT`) | Build |
| `AmountFactor` | Hệ số nhân (VD `-1` để đổi dấu). Orders đều là 1 | **Post** (Build lưu Amount chưa nhân) |
| `NegativeMode` | Khi số tiền âm: `SIGNED` giữ dấu âm, `REVERSE` đảo Nợ/Có và lấy trị tuyệt đối, `ERROR` báo lỗi | Post |
| `SkipIfDrAccountNull` / `SkipIfCrAccountNull` | Nếu tài khoản vai trò đó bị NULL thì bỏ qua rule, không coi là lỗi | Build và Post |
| `SkipIfAmountZero` | Nếu số tiền = 0 thì bỏ qua | Build và Post |
| `PartnerMode` / `FixedPartner` | `HEADER` = dùng partner của event. `FIXED` = dùng mã `FixedPartner` | Post |
| `ApplyPartnerToDrLine` / `ApplyPartnerToCrLine` | 1 = ghi partner lên dòng Nợ/Có, 0 = để trống | Post |
| `MemoTemplate` | Diễn giải của dòng GL (dùng nguyên văn, không thay biến) | Post |
| `IsActive` | Chỉ rule active mới được dùng | Build, Post |

### 3.5. Ghép JournalType với JournalLineRule ra bút toán

```
ORD_REV_PRODUCT_FULFILLED
  JournalType :  ContraAccount = 13122001 ,  TransAccount = 51112001
  LineRule    :  Nợ = CONTRA_ACCOUNT       ,  Có = TRANS_ACCOUNT
                         ▼
                 Nợ 13122001  /  Có 51112001

ORD_REV_SHIPADD_FULFILLED    →  Nợ 13122001  /  Có 51131001
ORD_REV_TAX_FULFILLED        →  Nợ 13122001  /  Có 33302001

ORD_SELLER_PROFIT_FULFILLED
  JournalType :  ContraAccount = 33102001 ,  TransAccount = 63202001
  LineRule    :  Nợ = TRANS_ACCOUNT        ,  Có = CONTRA_ACCOUNT      ← đảo so với 3 nghiệp vụ trên
                         ▼
                 Nợ 63202001  /  Có 33102001
```

**Vì sao seller profit đảo chiều?** "Contra" và "Trans" chỉ là **vai trò**, không phải bên Nợ hay Có. Chiều ghi phụ thuộc bản chất tài khoản (xem [1.2](#12-nợ-và-có-không-có-nghĩa-là-nợ-nần)):

| Nghiệp vụ | Tài khoản Contra | Tài khoản Trans | Kết quả |
|---|---|---|---|
| Doanh thu | `13122001` (khách ứng trước, tài khoản lưỡng tính, xem lưu ý ở [1.5](#15-tài-khoản-trung-gian-13122001-nối-nguồn-thanh-toán-với-nguồn-đơn-hàng)): đã ghi **Có** lúc khách trả tiền, khi giao hàng khoản ứng trước được cấn trừ → ghi **Nợ** | `51112001` (R): doanh thu **tăng** → ghi **Có** | Nợ Contra / Có Trans |
| Seller profit | `33102001` (L): nợ seller **tăng** → ghi **Có** | `63202001` (Exp): chi phí **tăng** → ghi **Nợ** | Nợ Trans / Có Contra |

### 3.6. `Partners`: đối tượng

Hai loại partner mà Orders dùng:

**Partner cố định `INDIVIDUALS`** (khách lẻ, dùng cho doanh thu và thuế):

| PartnerID | PartnerType | PartnerTaxID | PartnerCode | PartnerName | IsActive |
|---|---|---|---|---|---|
| 1922 | OTHER | `INDIVIDUALS` | `INDIVIDUALS` | `INDIVIDUALS` | 1 |

**Seller**:
- `PartnerCode` là email seller.
- `PartnerName` phần lớn có dạng `FFT-{Store}` hoặc `FFT-FFT {Store}`. 43/1,879 dòng seller dùng tiền tố khác như `VICBEA-`, `WFF-`, `MESI PAY-`; các tên này thường **không lọc được theo store** khi một email có nhiều store, xem 5.6.
- `PartnerTaxID` là mã định danh của seller/store, dùng để theo dõi công nợ. Cột không có ràng buộc unique. Snapshot có 7 giá trị bị trùng (17 dòng), nhưng tất cả thuộc partner loại `Supplier`; 1,867 dòng `Seller` từ sheet có TaxID không trùng nhau; 12 seller bổ sung ngày 2026-09-17 (PartnerID 1931–1942, lấy từ file order thật) để `PartnerTaxID` NULL vì chưa có nguồn mã seller.

Ví dụ seller của đơn xuyên suốt:

| PartnerID | PartnerType | PartnerTaxID | PartnerCode | PartnerName | BankType | IsActive |
|---|---|---|---|---|---|---|
| 15 | Seller | `0C1NIIRHX770DPREZ0L` | `nqcuong.0525@gmail.com` | `FFT-JJC` | PingPong | 1 |

Một email có thể sở hữu nhiều store. VD `bettamax001@gmail.com` có 8 dòng Partners (8 store, 8 TaxID khác nhau). Xem [10.6](#106-mô-phỏng--resolve-seller-khi-một-email-có-nhiều-store).

### 3.7. `Exrate`: tỷ giá

Bảng có 63 dòng: 18 dòng từ sheet (`ReportCurrency = USD`) và 45 dòng bổ sung ngày 2026-09-17 cho kỳ 202501–202608: `CAD/USD MUL` cho ONTARIO (Bank of Canada bình quân tháng), `VND/USD MUL` cho VICBEA (Vietcombank bình quân tháng của (mua chuyển khoản + bán)/2), nối thêm `USD/CAD DIV` 202604–202608 (xem guide §13.1). Dòng USD/CAD của kỳ 202511:

| ExrateID | Period | ExrateDate | ReportCurrency (= FncCurr) | TransCurrency (= InputCurr) | RateType | Exrate | IsActive |
|---|---|---|---|---|---|---|---|
| 11 | 202511 | 2025-11-01 | USD | CAD | DIV | 1.4055 | 1 |

Orders là USD → USD nên **không cần tra bảng này** (`XRate = 1`, `MUL`). Ví dụ có quy đổi xem [10.5](#105-mô-phỏng--tỷ-giá).

### 3.8. `CoA`: danh mục tài khoản

Xem bảng ở [1.3](#13-sáu-tài-khoản-mà-luồng-orders-dùng-lấy-từ-bảng-coa-thật). Lúc Post, engine kiểm tra tài khoản Nợ/Có có trong CoA không (`hasAccount`). Không có thì báo lỗi `ACCOUNT_NOT_IN_COA`.

---

## Phần 4 — Bước 1: Import (file → RawOrders)

**Code:** `src/lib/services/import-orders.ts`, `src/lib/io/read-table.ts`, `src/lib/orders/normalize.ts`, `src/lib/orders/columns.ts`, `src/lib/engine/parse.ts`.
**Trên web:** trang **1. Raw Orders** → kéo file vào.

### 4.1. Đọc file

- `.csv`/`.txt`: đọc bằng papaparse dạng UTF-8, bỏ BOM, bỏ dòng trống, trim tên cột. **Mọi giá trị đọc ra đều là chuỗi.**
- `.xlsx`: đọc bằng exceljs, chọn sheet đầu tiên có cột `OrderId`, header ở dòng 1. Ô ngày giữ nguyên kiểu Date, ô công thức lấy kết quả.
- Đuôi khác: báo lỗi 400.

Tên cột được so khớp **không phân biệt hoa thường và khoảng trắng** với 46 tên chuẩn trong `ORDER_COLUMNS` (VD `Order Id` khớp `OrderId`). Nếu thiếu 1 trong 6 cột bắt buộc `OrderId, ItemCode, ItemStatus, Quantity, UnitPrice, PaymentGatewayName` thì cả file bị từ chối (ImportBatch `FAILED`, không ghi dòng nào).

### 4.2. Dòng thô của đơn ví dụ và kết quả sau chuẩn hóa

Mỗi cột có một **kiểu** (`text`, `number`, `date`, `datetime`) và được chuẩn hóa theo kiểu đó. Bảng dưới là **đủ 46 cột** của đơn `QVAJV-191125-Q1Z3V`: giá trị đọc từ CSV, giá trị lưu vào `RawOrders`, và cột đó có được Build dùng hay không.

| # | Cột | Kiểu | Giá trị thô trong CSV | Giá trị trong RawOrders | Build dùng? |
|---|---|---|---|---|---|
| 1 | `OrderId` | text | `QVAJV-191125-Q1Z3V` | `QVAJV-191125-Q1Z3V` | ✅ khóa nhóm, TransactionID |
| 2 | `ItemCode` | text | `QVAJV-191125-Q1Z3V-1` | `QVAJV-191125-Q1Z3V-1` | ✅ khóa dòng raw, SourceHash |
| 3 | `SKU` | text | `s8TzO9o9` | `s8TzO9o9` | – |
| 4 | `ProductSKU` | text | `B000011660` | `B000011660` | – |
| 5 | `VariantName` | text | `Soothe Soles (Buy 1/8 - 9)` | (giữ nguyên) | – |
| 6 | `Domain` | text | `https://soothesoles.store/products/sooothesoles` | (giữ nguyên) | – |
| 7 | `Quantity` | number | `1` | `1` | ✅ PRODUCT |
| 8 | `StoreName` | text | `JJC` | `JJC` | ✅ lọc store khi seller có nhiều store |
| 9 | `ItemStatus` | text | `FULFILLED` | `FULFILLED` | ✅ điều kiện build |
| 10 | `LastUpdatedAt` | datetime | `11-20-2025 18:27:04` | `2025-11-20 18:27:04` | – |
| 11 | `PaidAt` | datetime | `11-19-2025 5:32:37` | `2025-11-19 05:32:37` | – |
| 12 | `LastUpdatedDateAt` | date | `11-20-2025` | `2025-11-20` | – |
| 13 | `PaidDateAt` | date | `11-19-2025` | `2025-11-19` | – |
| 14 | `LastUpdatedTimeAt` | text | `18:27:04` | `18:27:04` | – |
| 15 | `PaidTimeAt` | text | `5:32:37` | `5:32:37` | – |
| 16 | `FulfilledAt` | date | `11/21/2025` | `2025-11-21` | ✅ điều kiện build, PostingDate, Period |
| 17 | `TrackingNumber` | text | `YT2532400707212358` | (giữ nguyên) | – |
| 18 | `Carrier` | text | `YUNEXPRESS` | `YUNEXPRESS` | – |
| 19 | `UnitPrice` | number | `34,99` | `34.99` | ✅ PRODUCT |
| 20 | `ShippingFee` | number | `4,99` | `4.99` | ✅ SHIPADD |
| 21 | `TotalPrice` | number | `39,98` | `39.98` | ❌ không dùng |
| 22 | `BuyerName` | text | `Annik Hilbig` | `Annik Hilbig` | – |
| 23 | `BuyerEmail` | text | `annik.hilbig@googlemail.com` | (giữ nguyên) | – |
| 24 | `BuyerAddress1` | text | `Ruhrstr. 5` | `Ruhrstr. 5` | – |
| 25 | `BuyerAddress2` | text | (trống) | `NULL` | – |
| 26 | `BuyerPhone` | text | (trống) | `NULL` | – |
| 27 | `BuyerCity` | text | `Witten` | `Witten` | – |
| 28 | `BuyerProvince` | text | (trống) | `NULL` | – |
| 29 | `BuyerCountry` | text | `DE` | `DE` | – |
| 30 | `BuyerZip` | text | `58452` | `58452` | – |
| 31 | `BuyerCountryCode` | text | `DE` | `DE` | – |
| 32 | `BuyerProvinceCode` | text | (trống) | `NULL` | – |
| 33 | `SellerEmail` | text | `nqcuong.0525@gmail.com` | (giữ nguyên) | ✅ tra seller |
| 34 | `TransactionId` | text | `47A55695KF474200T` | (giữ nguyên) | ❌ (mã giao dịch PayPal, chưa dùng) |
| 35 | `Profit` | number | `19,32` | `19.32` | ✅ SELLER_PROFIT |
| 36 | `TaxID` | text | (trống) | `NULL` | ✅ tra seller (ưu tiên 1) |
| 37 | `PlatformProductSKU` | text | `B000011660` | `B000011660` | – |
| 38 | `Group` | text | (trống) | `NULL` | – |
| 39 | `GroupQuantity` | number | `1` | `1` | – |
| 40 | `SupplierCost` | number | `11,66` | `11.66` | ❌ không dùng |
| 41 | `PaymentGatewayId` | text | `591` | `591` | ❌ không dùng (tra theo tên) |
| 42 | `PaymentGatewayName` | text | `ZeniroxPay Inc.` | `ZeniroxPay Inc.` | ✅ tra ComCode |
| 43 | `GatewayType` | text | `PAYPAL` | `PAYPAL` | – |
| 44 | `FulfillmentCost` | number | `17,66` | `17.66` | ❌ không dùng |
| 45 | `AdditionalCost` | number | `3` | `3` | ✅ SHIPADD |
| 46 | `TaxFee` | number | `0` | `0` | ✅ TAX |

Tóm lại, Build chỉ dùng **14 cột**: `OrderId, ItemCode, ItemStatus, FulfilledAt, Quantity, UnitPrice, ShippingFee, AdditionalCost, TaxFee, Profit, SellerEmail, TaxID, StoreName, PaymentGatewayName`. 32 cột còn lại chỉ được lưu để tra cứu và tham gia `RowHash`.

Ngoài 46 cột, `RawOrders` có thêm 6 cột hệ thống:

| Cột | Giá trị của đơn ví dụ | Nguồn |
|---|---|---|
| `RawOrderID` | `54` | Tự tăng (bản ghi thứ 54 của file; số dòng vật lý trong CSV lớn hơn vì có ô `VariantName` xuống dòng) |
| `ImportBatchID` | `1` | Lần import |
| `ComCode` | `ZENIROXPAY` | `GatewayCompanyMapping["ZeniroxPay Inc."]`, tra ngay lúc import và **ghi lại lúc build** |
| `BuildStatus` | `NOT_BUILT` | Mặc định khi mới import |
| `BuildMessage` | `NULL` | |
| `RowHash` | `6DF39D22FED4D2692107F1666FD8B88AD572E1E8121AB2E603B031D57228AF26` | SHA-256 (chữ hoa) của 46 cột **sau chuẩn hóa** |

### 4.3. Quy tắc chuẩn hóa chi tiết

**Số (`parseNumber`)**

| Đầu vào | Kết quả | Quy tắc |
|---|---|---|
| `34,99` | 34.99 | Chỉ có **một dấu phẩy** thì coi là dấu thập phân (file xuất từ Google Sheet locale VN) |
| `3` | 3 | |
| `1.234,56` | 1234.56 | Có cả `,` và `.` thì ký tự **đứng sau cùng** là dấu thập phân |
| `1,234.56` | 1234.56 | |
| `1,234,567` | 1234567 | Nhiều dấu phẩy thì là dấu phân cách nghìn |
| `(3,20)` | -3.2 | Cả chuỗi nằm trong ngoặc thì là số âm |
| `$ 12.5` | 12.5 | Bỏ ký tự không phải số |
| trống / `NULL` | `NULL` | |

> Cẩn thận: `1,439` sẽ thành **1.439** chứ không phải 1439. File dùng dấu phẩy phân cách nghìn kiểu Mỹ phải có phần thập phân (`1,439.00`) hoặc dùng .xlsx.

Import **không làm tròn** số. Làm tròn 2 chữ số chỉ xảy ra ở Build/Post.

**Ngày (`parseDate` / `parseDateTime`)**

Chuỗi được thử **chặt** lần lượt theo các định dạng: `M/D/YYYY`, `M/D/YYYY H:mm:ss`, `M/D/YYYY H:mm`, `M-D-YYYY`, `M-D-YYYY H:mm:ss`, `M-D-YYYY H:mm`, `YYYY-MM-DD`, `YYYY-MM-DD HH:mm:ss`, `YYYY-MM-DDTHH:mm:ss`, `YYYY/MM/DD`.

Nếu không khớp định dạng nào, engine thử tiếp cách parse **lỏng** của dayjs/`Date`. Kết quả chỉ được nhận khi chuỗi có 4 chữ số liền nhau. Vì vậy `Nov 21, 2025`, `2025.11.21`, `20251121`, `05/11/2025` vẫn được nhận. Chuỗi có múi giờ như `2025-11-21T10:00:00Z` bị đổi sang giờ máy chủ (VD `2025-11-21 17:00:00` ở UTC+7).

- `11/21/2025` khớp `M/D/YYYY` → `2025-11-21`.
- `11-19-2025 5:32:37` khớp `M-D-YYYY H:mm:ss` → `2025-11-19 05:32:37`.
- **Không có định dạng ngày-trước-tháng**: chuỗi `D/M/YYYY` luôn bị hiểu là tháng/ngày.
  - Ngày > 12 (VD `21/11/2025`): không parse được. Với `FulfilledAt` đây là **lỗi dòng**.
  - Ngày ≤ 12 (VD `05/11/2025`): **không báo lỗi**, bị lưu thành `2025-05-11`, tức sai ngày và sai kỳ. File xuất theo locale ngày-trước-tháng phải đổi sang tháng/ngày hoặc `YYYY-MM-DD` trước khi import.
- Cột kiểu `text` giữ nguyên chuỗi, VD `PaidTimeAt = 5:32:37` không được thêm số 0.

**Chuỗi:** trim khoảng trắng. Chuỗi rỗng hoặc `NULL` (mọi kiểu hoa thường) đều thành `NULL`.

**Lỗi dòng** (dòng không được ghi, nằm trong `ImportBatch.ErrorDetails`): thiếu `OrderId`, thiếu `ItemCode`, `FulfilledAt` có giá trị nhưng không parse được, `ItemCode` trùng trong cùng file.

### 4.4. Ghi vào RawOrders, và khi import lại

Với từng dòng hợp lệ, tra `ItemCode` trong `RawOrders`:

| Tình huống | Xử lý | Đếm vào |
|---|---|---|
| `ItemCode` chưa có | Insert, `BuildStatus = NOT_BUILT` | `InsertedRows` |
| Đã có, `RowHash` giống hệt | Không làm gì | `SkippedRows` |
| Đã có, `RowHash` khác, dòng cũ `BUILT` | **Từ chối**: "Dòng đã build thành AccountingEvent và dữ liệu thay đổi → Unbuild trước khi import lại" | `ErrorRows` |
| Đã có, `RowHash` khác, dòng cũ chưa `BUILT` nhưng ItemCode **còn nằm trong AccountingEvent** (VD gateway bị gỡ mapping rồi Build → dòng thành `ERROR`, event POSTED được giữ; kể cả sau khi Unpost event thành NEW) | **Từ chối**: "Dòng đã ghi sổ (event …, POSTED) … → Unpost + Unbuild ComCode X kỳ P trước khi import lại" hoặc "Dòng còn nằm trong AccountingEvent chưa post … → Unbuild ComCode X kỳ P trước khi import lại" (chống ghi sổ trùng khi đổi ngày giao/cổng) | `ErrorRows` |
| Đã có, `RowHash` khác, dòng cũ chưa `BUILT`, item chưa ghi sổ | Ghi đè cả dòng, `BuildStatus = NOT_BUILT` | `ReplacedRows` |

`RowHash` tính trên **cả 46 cột**, nên chỉ cần đổi `TrackingNumber` thôi cũng bị coi là "dữ liệu thay đổi".

### 4.5. `ImportBatch` sau khi import file mẫu

| ImportBatchID | DataSource | FileName | Status | TotalRows | SuccessRows | ErrorRows | SkippedRows | ErrorMessage | ErrorDetails |
|---|---|---|---|---|---|---|---|---|---|
| 1 | ORDERS | orders-sample.csv | SUCCESS | 64 | 64 | 0 | 0 | NULL | NULL |

`Status`: `SUCCESS` nếu không có lỗi, `PARTIAL` nếu có lỗi nhưng vẫn có dòng thành công hoặc bỏ qua, `FAILED` nếu toàn lỗi hoặc thiếu cột bắt buộc.

Import file mẫu lần thứ 2 cho kết quả `InsertedRows = 0, SkippedRows = 64`.

---

## Phần 5 — Bước 2: Build (RawOrders → AccountingEvent)

**Code:** engine `src/lib/engine/build-orders.ts` (thuần logic), service `src/lib/services/build.ts` (đọc/ghi DB), `src/lib/engine/resolve-partner.ts`, `src/lib/engine/keys.ts`.
**Trên web:** trang **2. AccountingEvent** → nút **Build Orders**, hoặc Dashboard → **Chạy full cycle**.

### 5.1. AccountingEvent là gì và vì sao cần tầng này

Một AccountingEvent là **"event nghiệp vụ đã chuẩn hóa"**: 1 giao dịch nguồn × 1 quy tắc (JournalLineRule). Event đã có đủ ngày, kỳ, số tiền, các tài khoản theo vai trò và partner, nhưng **chưa quyết định dòng Nợ, dòng Có** và **chưa gom chứng từ**.

Tầng này tồn tại để:

- **Kiểm soát trước khi ghi sổ:** event lỗi (VD không tìm được seller) nằm ở trạng thái `ERROR`, không làm bẩn sổ cái.
- **Giữ chi tiết từng đơn:** sổ cái Bulk chỉ có số tổng, còn event vẫn giữ từng đơn để truy vết.
- **Build lại an toàn:** event chưa post được thay thế thoải mái, event đã post được bảo vệ.

### 5.2. Bước 2a — Lọc dòng đủ điều kiện

Với mỗi dòng RawOrders (khi không chọn phạm vi thì build tất cả, bất kể `BuildStatus` hiện tại):

```
ItemStatus (trim, UPPER) = "FULFILLED"   VÀ   FulfilledAt có giá trị
```

- **Không đạt:** dòng → `BuildStatus = SKIPPED`, ghi exception `NOT_FULFILLED` (INFO). Xem [Phần 9](#phần-9--ví-dụ-3-dòng-bị-loại-và-khoản-tiền-bằng-0).
- **Đơn ví dụ:** `ItemStatus = FULFILLED`, `FulfilledAt = 2025-11-21` → **đạt**.

> Code **không** có bộ lọc riêng cho đơn test (`BuyerName` bắt đầu bằng `ORDER_TEST`, store `Test FFT`). Trong file mẫu, cả 3 đơn test đều `UNFULFILLED` nên tình cờ bị loại ở bước này.

### 5.3. Bước 2b — Xác định công ty và tiền hạch toán

```
ComCode = GatewayCompanyMapping[ UPPER(TRIM(PaymentGatewayName)) ].ComCode
        = GatewayCompanyMapping["ZENIROXPAY INC."]  →  "ZENIROXPAY"

Company = Company["ZENIROXPAY"] (IsActive = 1)  →  FunctionalCurrency = "USD"  →  FncCurr = "USD"
InputCurr = "USD" (hằng số ORDER_INPUT_CURRENCY, vì file order không có cột tiền tệ)
```

- Không map được gateway: dòng → `BuildStatus = ERROR`, exception `MISSING_COMCODE`.
- Có ComCode nhưng không có Company (hoặc Company inactive): dòng → `ERROR`, exception `MISSING_COMPANY`.

### 5.4. Bước 2c — Ngày ghi sổ, kỳ, nhóm và số tiền

```
PostingDate = FulfilledAt           = "2025-11-21"
Period      = YYYYMM(PostingDate)   = "202511"
Khóa nhóm   = ComCode|OrderId|PostingDate = "ZENIROXPAY|QVAJV-191125-Q1Z3V|2025-11-21"
```

Mọi dòng RawOrders có cùng khóa nhóm được **cộng dồn** bằng `decimal.js` (ô trống tính là 0):

| AmountSource | Công thức | Tính cho đơn ví dụ | Kết quả |
|---|---|---|---|
| `PRODUCT` | Σ `Quantity × UnitPrice` | 1 × 34.99 | **34.99** |
| `SHIPADD` | Σ `ShippingFee + AdditionalCost` | 4.99 + 3 | **7.99** |
| `TAX` | Σ `TaxFee` | 0 | **0** |
| `SELLER_PROFIT` | Σ `Profit` | 19.32 | **19.32** |

Seller (`SellerEmail`, `TaxID`, `StoreName`) lấy từ **dòng đầu tiên** của nhóm.

Tại sao ngày giao nằm trong khóa nhóm? Một đơn có thể giao từng phần vào các ngày khác nhau. Mỗi ngày giao là một lần ghi nhận doanh thu riêng, có thể thuộc kỳ khác nhau.

> ⚠️ **Điểm cần xác nhận nghiệp vụ về `AdditionalCost`.** Code cộng `AdditionalCost` vào doanh thu SHIPADD theo tài liệu yêu cầu §7.3 bước 5.
>
> Dữ liệu mẫu lại gợi ý điều ngược lại. Cả 57 dòng có `Profit` đều thỏa `Profit = TotalPrice − FulfillmentCost − AdditionalCost`, nhưng 56 dòng trong số đó có `AdditionalCost = 0` nên không phân biệt được dấu của khoản này. Chỉ đơn ví dụ, dòng duy nhất có `AdditionalCost = 3`, là kiểm chứng được:
> - 39.98 − 17.66 − 3 = 19.32 = `Profit`.
> - `TotalPrice` = 34.99 + 4.99 = 39.98, không chứa khoản 3.
>
> Như vậy, dựa trên một dòng dữ liệu này, `AdditionalCost` hành xử như **một khoản chi phí**, không phải khoản khách trả thêm. Hệ quả với đơn này: tổng ghi Nợ `13122001` = 34.99 + 7.99 = **42.98**, lớn hơn `TotalPrice` = 39.98 đúng 3.00. Nên hỏi kế toán xem `AdditionalCost` có đúng là doanh thu không.

> `TotalPrice` **không được dùng**. Có dòng mẫu `15196-191125-PVXFS-1` bị lệch: `1 × 59.99 + 4.99 = 64.98` nhưng `TotalPrice = 199.96`. Engine vẫn tính PRODUCT = 59.99 theo công thức.

### 5.5. Bước 2d — Duyệt 4 nghiệp vụ × các rule active

Với mỗi nhóm order, engine duyệt cố định 4 mã theo thứ tự `ORD_REV_PRODUCT_FULFILLED`, `ORD_REV_SHIPADD_FULFILLED`, `ORD_REV_TAX_FULFILLED`, `ORD_SELLER_PROFIT_FULFILLED`. Với mỗi mã:

```
1. jt    = JournalType("ORDERS", jtc)            → không có: exception MISSING_JOURNAL_TYPE, bỏ mã này
2. rules = JournalLineRule active của jtc (theo RuleSeq)  → rỗng: exception MISSING_RULE, bỏ mã này
3. Với từng rule:
   a. amount = số tiền nhóm theo rule.AmountSource   → không nhận ra: UNKNOWN_AMOUNT_SOURCE
   b. amount = làm tròn 2 số lẻ (ROUND_HALF_UP)
   c. amount = 0 và SkipIfAmountZero = 1             → exception AMOUNT_ZERO (INFO), KHÔNG tạo event
   d. Copy 4 tài khoản từ JournalType
      TK Nợ = tài khoản theo NormalDrAccountSource, TK Có = theo NormalCrAccountSource
      Nếu TK bị NULL và rule có cờ SkipIf...Null     → exception MISSING_ACCOUNT (WARNING), KHÔNG tạo event
   e. Xác định partner (5.6)
   f. Tạo event (5.7)
```

Áp dụng cho đơn ví dụ (mỗi mã có đúng 1 rule, `RuleSeq = 20`):

| JournalTypeCode | Rule | AmountSource | amount | Kiểm tra | Kết quả |
|---|---|---|---|---|---|
| `ORD_REV_PRODUCT_FULFILLED` | 97 | PRODUCT | 34.99 | ≠ 0; Contra 13122001 & Trans 51112001 không NULL | ✅ Tạo event **142** |
| `ORD_REV_SHIPADD_FULFILLED` | 98 | SHIPADD | 7.99 | ≠ 0; 13122001 & 51131001 | ✅ Tạo event **143** |
| `ORD_REV_TAX_FULFILLED` | 99 | TAX | 0.00 | = 0 và `SkipIfAmountZero = 1` | ❌ Bỏ qua → exception `AMOUNT_ZERO` |
| `ORD_SELLER_PROFIT_FULFILLED` | 100 | SELLER_PROFIT | 19.32 | ≠ 0; Trans 63202001 & Contra 33102001 | ✅ Tạo event **144** |

Exception do TAX sinh ra (dòng thật trong `ExceptionLog`):

| ID | BatchType | BatchID | DataSource | ComCode | Period | Severity | ExceptionType | SourceKey | Message |
|---|---|---|---|---|---|---|---|---|---|
| 60 | BUILD | 1 | ORDERS | ZENIROXPAY | 202511 | INFO | AMOUNT_ZERO | `ORD-QVAJV-191125-Q1Z3V-20251121\|ORD_REV_TAX_FULFILLED` | TAX = 0 → bỏ qua (SkipIfAmountZero) |

### 5.6. Bước 2e — Xác định partner

Đọc cột `JournalType.Partner`:

| Giá trị | Chế độ | Cách resolve |
|---|---|---|
| `Fixed = Individuals` | FIXED, mã `INDIVIDUALS` (tự uppercase) | Tìm Partners có `PartnerCode = INDIVIDUALS`. Thấy thì lấy `PartnerCode/PartnerTaxID/PartnerName` của dòng đó, không thấy thì dùng mã `INDIVIDUALS` với TaxID/Name NULL |
| `From Source` | FROM_SOURCE | Tra seller theo dữ liệu order (thuật toán dưới) |
| Khác / trống | NONE | Partner để NULL |

**Doanh thu và thuế (Fixed = Individuals)** → `PartnerCode = INDIVIDUALS`, `PartnerTaxID = INDIVIDUALS`, `PartnerName = INDIVIDUALS` (dòng PartnerID 1922).

**Seller profit (From Source): thuật toán `resolveSeller`**

```
Bước 1: Order có TaxID?  → tìm Partners active có PartnerTaxID = TaxID
        Có ≥ 1 dòng      → lấy dòng đầu, matchedBy = TAX_ID, KẾT THÚC
Bước 2: Order không có SellerEmail → LỖI "Order không có SellerEmail/TaxID để map seller"
Bước 3: Ứng viên = Partners active có PartnerCode = SellerEmail
        (nếu trong đó có PartnerType = Seller thì chỉ giữ Seller)
Bước 4: 0 ứng viên → LỖI "Không tìm thấy seller ... trong Partners"
        1 ứng viên → lấy luôn, matchedBy = EMAIL
Bước 5: Nhiều ứng viên → giữ dòng có PartnerName (không phân biệt hoa thường) bằng:
        "FFT-{Store}"  |  "FFT-FFT {Store}"  |  "{Store}"  |  kết thúc bằng " {Store}"
        Còn đúng 1 → matchedBy = EMAIL_STORE
        Khác       → LỖI "Seller ... có N store trong Partners, không xác định được store ..."
```

Áp dụng cho đơn ví dụ:

```
TaxID     = NULL                        → bỏ qua bước 1
SellerEmail = nqcuong.0525@gmail.com    → Partners có 1 dòng (PartnerID 15, PartnerType Seller)
→ matchedBy = EMAIL
→ PartnerCode = nqcuong.0525@gmail.com, PartnerTaxID = 0C1NIIRHX770DPREZ0L, PartnerName = FFT-JJC
```

(Kiểm tra chéo: `PartnerName = FFT-JJC` khớp `StoreName = JJC`. Thuật toán không cần đến vì email chỉ có 1 store.)

Trong file mẫu, cột `TaxID` trống ở cả 64 dòng. 11 cặp seller+store fulfilled đều khớp theo `EMAIL` với đúng 1 ứng viên.

**Khi không tìm được seller:** event **vẫn được tạo** nhưng có `PostStatus = ERROR`, `ErrorStage = BUILD`, `PartnerCode = SellerEmail`, `PartnerTaxID = TaxID` của order, `PartnerName = NULL`, kèm exception `MISSING_PARTNER`. Post sẽ **không** lấy event này. Xem [10.7](#107-mô-phỏng--không-tìm-thấy-seller).

### 5.7. Bước 2f — Tạo event: mapping từng cột

Bảng dưới là **toàn bộ 39 cột** của `AccountingEvent` cho 3 event của đơn ví dụ, ở trạng thái **ngay sau Build** (chưa post).

| Cột | Nguồn / công thức | Event 142 (PRODUCT) | Event 143 (SHIPADD) | Event 144 (SELLER_PROFIT) |
|---|---|---|---|---|
| `AccountingEventID` | Tự tăng khi insert | 142 | 143 | 144 |
| `ComCode` | Bước 2b | ZENIROXPAY | ZENIROXPAY | ZENIROXPAY |
| `DataSource` | Hằng `ORDERS` | ORDERS | ORDERS | ORDERS |
| `JournalTypeCode` | `JournalType.JournalTypeCode` | ORD_REV_PRODUCT_FULFILLED | ORD_REV_SHIPADD_FULFILLED | ORD_SELLER_PROFIT_FULFILLED |
| `TransactionID` | `ORD-{OrderId}-{yyyyMMdd(PostingDate)}` | ORD-QVAJV-191125-Q1Z3V-20251121 | (giống) | (giống) |
| `EventSeq` | `JournalLineRule.RuleSeq` | 20 | 20 | 20 |
| `LineSeq` | Luôn 1 | 1 | 1 | 1 |
| `PairCode` | `JournalLineRule.PairCode` | CONTRA_TRANS | CONTRA_TRANS | CONTRA_TRANS |
| `AmountSource` | `JournalLineRule.AmountSource` | PRODUCT | SHIPADD | SELLER_PROFIT |
| `PostingDate` | `FulfilledAt` | 2025-11-21 | 2025-11-21 | 2025-11-21 |
| `Period` | `YYYYMM(PostingDate)` | 202511 | 202511 | 202511 |
| `OrderID` | `OrderId` | QVAJV-191125-Q1Z3V | (giống) | (giống) |
| `RefNum` | `OrderId` | QVAJV-191125-Q1Z3V | (giống) | (giống) |
| `SourceID` | `{OrderId}\|{yyyyMMdd}` | QVAJV-191125-Q1Z3V\|20251121 | (giống) | (giống) |
| `InputCurr` | Hằng `USD` | USD | USD | USD |
| `FncCurr` | `Company.FunctionalCurrency` | USD | USD | USD |
| **`Amount`** | Số tiền nhóm theo AmountSource, làm tròn 2 số lẻ, **chưa nhân AmountFactor** | **34.99** | **7.99** | **19.32** |
| `BankAccountNumber` | Orders luôn NULL | NULL | NULL | NULL |
| `BankGLAccount` | Copy `JournalType.BankAccount` | NULL | NULL | NULL |
| `ContraAccount` | Copy `JournalType.ContraAccount` | 13122001 | 13122001 | **33102001** |
| `TransAccount` | Copy `JournalType.TransAccount` | 51112001 | 51131001 | **63202001** |
| `FeeAccount` | Copy `JournalType.FeeAccount` | NULL | NULL | NULL |
| `PartnerCode` | Bước 2e | INDIVIDUALS | INDIVIDUALS | **nqcuong.0525@gmail.com** |
| `PartnerTaxID` | Bước 2e | INDIVIDUALS | INDIVIDUALS | **0C1NIIRHX770DPREZ0L** |
| `PartnerName` | Bước 2e | INDIVIDUALS | INDIVIDUALS | **FFT-JJC** |
| `Description` | `JournalType.JournalType` | Orders Fulfilled Product Revenue | Orders Fulfilled ShipAdd Revenue | Orders Fulfilled Seller Profit |
| `BalanceImpact` | Không dùng ở event | NULL | NULL | NULL |
| `PostStatus` | `NEW` (hoặc `ERROR` nếu seller lỗi) | NEW | NEW | NEW |
| `PostedDocNum` | Điền lúc Post | NULL | NULL | NULL |
| `PostingGroupKey` | Điền lúc Post (Bulk) | NULL | NULL | NULL |
| `PostBatchID` | Điền lúc Post | NULL | NULL | NULL |
| `PostedAt` | Điền lúc Post | NULL | NULL | NULL |
| `ErrorStage` | `BUILD` nếu seller lỗi | NULL | NULL | NULL |
| `ErrorMessage` | Lý do lỗi | NULL | NULL | NULL |
| `SourceHash` | SHA-256 (5.8) | 12CE6436…4BA6620 | 2790B9ED…3AAECE6 | F139BE72…4B27A5B |
| `ItemCodes` | JSON các ItemCode tạo nên event (sort) — dùng chống ghi sổ trùng (5.9) | ["QVAJV-191125-Q1Z3V-1"] | (giống) | (giống) |
| `BuildBatchID` | Lần build | 1 | 1 | 1 |
| `AddDate` | Thời điểm insert | 2026-09-14 12:13:27 | (giống) | (giống) |
| `ModifiedDate` | Thời điểm sửa gần nhất | NULL | NULL | NULL |

Những điểm cần nhớ:

- **Tài khoản và partner trên event là bản copy tại thời điểm Build.** Sửa tài khoản trong JournalType, hoặc sửa Partners, sau đó thì phải Build lại để event nhận giá trị mới.
- **Đọc lúc Post:** tỷ giá, CoA, và các cột rule quyết định cách ghi (`NormalDr/CrAccountSource`, `AmountFactor`, `NegativeMode`, `PartnerMode`/`FixedPartner`, `ApplyPartnerToDr/CrLine`, `MemoTemplate`).
- **Rule nhưng phải Build lại:** các cột đã dùng khi Build (`IsActive`, `RuleSeq`, `AmountSource`, `SkipIfAmountZero`, `SkipIfDr/CrAccountNull`), xem bảng 3.4.
- Event **không có cột Nợ/Có**. Nó chỉ lưu "tài khoản vai trò Contra là gì, vai trò Trans là gì". Lúc Post, rule mới quyết định vai trò nào ra bên Nợ.
- ID 142 → 143 → 144 liên tiếp vì TAX bị bỏ qua nên không chiếm ID. Engine tạo event theo thứ tự nhóm (theo thứ tự dòng raw), trong mỗi nhóm theo thứ tự 4 mã nghiệp vụ.

### 5.8. `SourceHash`: dấu vân tay dữ liệu nguồn

```
SourceHash = UPPER( SHA256( JSON.stringify({
   comCode, orderId, postingDate, jtc, ruleSeq, amount (dạng "0.00"), partner {PartnerCode, PartnerTaxID, PartnerName}, items (ItemCode đã sort)
})))
```

Chuỗi JSON thật của event 144:

```json
{"comCode":"ZENIROXPAY","orderId":"QVAJV-191125-Q1Z3V","postingDate":"2025-11-21","jtc":"ORD_SELLER_PROFIT_FULFILLED","ruleSeq":20,"amount":"19.32","partner":{"PartnerCode":"nqcuong.0525@gmail.com","PartnerTaxID":"0C1NIIRHX770DPREZ0L","PartnerName":"FFT-JJC"},"items":["QVAJV-191125-Q1Z3V-1"]}
```

→ `F139BE72FF65B2AA06BD553A48AABB26D9ECA34312DDB0A1DED3EC1D04B27A5B`

Công dụng: khi **build lại**, engine `reconcileEvents` (`src/lib/engine/reconcile-events.ts`) so `SourceHash` của event `POSTED` cùng khóa với hash mới. Khác nhau nghĩa là nguồn đã đổi (số tiền, partner, danh sách item...). Khi đó event POSTED vẫn được giữ nguyên và có cảnh báo `POSTED_SOURCE_CHANGED` (WARNING); service `build.ts` ghi cảnh báo vào ExceptionLog. Việc chặn ghi sổ trùng khi khóa đổi dựa trên cột `ItemCodes`, xem 5.9. `SourceHash` **không phải khóa duy nhất** và không chứa các cột tài khoản.

### 5.9. Bước 2g — Ghi vào database

**Khóa duy nhất của event** (`UX_AccountingEvent_Key`):

```
ComCode | DataSource | JournalTypeCode | TransactionID | EventSeq
VD: ZENIROXPAY|ORDERS|ORD_SELLER_PROFIT_FULFILLED|ORD-QVAJV-191125-Q1Z3V-20251121|20
```

Trong một transaction, service load event hiện có, rồi engine `reconcileEvents` (`src/lib/engine/reconcile-events.ts`) quyết định cách ghi:

1. Load mọi event (mọi ComCode, mọi PostStatus) của các `OrderID` đang build, chia theo `SourceID`:
   - SourceID đang build → đối chiếu ở bước 2–3;
   - SourceID **đã chết** (không còn dòng raw nào, VD mọi dòng của ngày giao đó đã đổi sang ngày khác) → cũng đối chiếu ở bước 2–3 như event cũ không còn sinh lại;
   - SourceID còn dòng raw nhưng ngoài phạm vi build → chỉ lấy event POSTED để phát hiện item đã ghi sổ.
2. Với từng event mới sinh:

   | Tình huống | Xử lý | Đếm |
   |---|---|---|
   | Chưa có event cùng khóa | Insert | `EventsCreated` |
   | Có, đang `POSTED` | **Giữ nguyên** (không ghi đè sổ đã ghi). Nếu `SourceHash` khác thì thêm cảnh báo `POSTED_SOURCE_CHANGED` | `EventsUnchangedPosted` |
   | Có, chưa POSTED (`NEW`/`ERROR`/`SKIPPED`) | Ghi đè toàn bộ, xóa thông tin post cũ | `EventsReplaced` |
   | **Item của event đã POSTED dưới khóa khác** trong cùng đơn (VD đổi GatewayCompanyMapping sang ComCode khác — kể cả chỉ 1 cổng của đơn nhiều cổng, đổi RuleSeq, đổi ngày giao — kể cả khi ngày cũ vẫn còn item khác) | Vẫn ghi event nhưng `PostStatus = ERROR`, `ErrorStage = BUILD` → Post **không** lấy, tránh ghi sổ trùng. Exception `POSTED_KEY_CHANGED` (ERROR) nêu event, chứng từ, ComCode + kỳ cần Unpost | `EventsBlocked` (đồng thời tính vào `EventsCreated` hoặc `EventsReplaced`) |

3. Event cũ (của SourceID đang build hoặc SourceID đã chết) mà lần này **không sinh lại**:
   - chưa POSTED (VD số tiền về 0, hoặc event ngày giao cũ sau khi đã Unpost): **xóa** (`EventsRemoved`);
   - đã POSTED và không có event mới nào thay chỗ: **giữ nguyên** + cảnh báo `POSTED_SOURCE_CHANGED` (WARNING).

   Khi Build theo 1 ComCode, hệ thống build **trọn đơn** (OrderId + ngày giao) liên quan tới ComCode đó, gồm cả phần của ComCode khác trong đơn nhiều cổng và các đơn đang có event của ComCode đó nhưng đã chuyển công ty. Nhờ vậy không bỏ sót event cũ.
4. Cập nhật `RawOrders`: `BuildStatus`, `BuildMessage`, `ComCode`. Đơn ví dụ → `BUILT`.
5. Xóa exception BUILD cũ trùng khóa, rồi ghi exception mới.

**`BuildBatch` thật sau khi build file mẫu:**

| BuildBatchID | DataSource | ComCodeList | PeriodFrom | PeriodTo | Status | SourceRows | EventsCreated | EventsReplaced | EventsError | SkippedRows | ErrorMessage |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | ORDERS | NULL | NULL | NULL | SUCCESS | 64 | 174 | 0 | 0 | 4 | NULL |

**Tóm tắt trả về khi bấm Build (`BuildSummary`):** `SourceRows 64 · FulfilledRows 60 · SkippedRows 4 · ErrorRows 0 · EventsCreated 174 · EventsReplaced 0 · EventsUnchangedPosted 0 · EventsRemoved 0 · EventsBlocked 0 · EventsError 0 · ZeroAmountSkipped 66 · Exceptions 70`.

Build lại lần 2 khi chưa post cho `EventsCreated 0 · EventsReplaced 174`, tức là thay thế chứ không nhân đôi. Build lại sau khi đã post cho `EventsUnchangedPosted 174`.

---

## Phần 6 — Bước 3: Post (AccountingEvent → GLTrans)

**Code:** engine `src/lib/engine/post.ts`, `src/lib/engine/resolve-fx.ts`, `src/lib/engine/keys.ts`, service `src/lib/services/post.ts`.
**Trên web:** trang **3. Posting** → **Post tất cả** / **Post Single** / **Post Bulk**.

### 6.1. Bước 3a — Chọn event và chia Single/Bulk

```
Ứng viên = AccountingEvent trong phạm vi có
           PostStatus = NEW   HOẶC   (PostStatus = ERROR VÀ ErrorStage = POST)
Classify = JournalType(DataSource, JournalTypeCode).Classify   → "Single" | "Bulk"
```

- Event `ERROR/BUILD` **không** được lấy. Thiếu seller (`MISSING_PARTNER`): sửa master rồi Build lại. Bị chặn vì `POSTED_KEY_CHANGED`: Unpost theo ComCode + kỳ cũ nêu trong ErrorMessage → Build → Post; chỉ Build lại mà chưa Unpost thì event vẫn bị chặn.
- **Chốt chặn ghi sổ trùng** (`src/lib/engine/post-guard.ts`): trước khi post, ứng viên được so với mọi event cùng `OrderID`. Một item chỉ thuộc 1 ngày giao và 1 công ty, nên ứng viên có item trùng với event **POSTED** hoặc event **cũng đang chờ post** mà khác `SourceID` hoặc khác `ComCode` sẽ bị giữ lại (`ERROR/POST` + exception `DUPLICATE_ITEM`); event Orders chưa có `ItemCodes` (tạo trước khi có cột) cũng bị giữ. Với dữ liệu bình thường Build đã xử lý hết nên bước này không giữ event nào (file mẫu: 0). Xử lý: Build lại rồi Post.
- Event `ERROR/POST` được lấy lại mỗi lần Post (thử lại sau khi sửa rule, tỷ giá hoặc CoA).
- JournalType không có Classify hợp lệ thì event **không bao giờ** được post.

"Post tất cả" = chạy **Post Single** rồi **Post Bulk**. Mỗi lượt là một `PostingBatch` riêng. Với file mẫu:

| Lượt | Ứng viên | Kết quả |
|---|---|---|
| Single | 0 (4 nghiệp vụ Orders đều Bulk) | `NOTHING_TO_POST`, **không tạo** PostingBatch |
| Bulk | 174 | `SUCCESS`, PostBatchID = 1, 174 event POSTED, 21 chứng từ, 42 dòng GL |

### 6.2. Bước 3b — "Nở" mỗi event thành 1 dòng Nợ + 1 dòng Có (`expandEvent`)

Engine kiểm tra lần lượt, gặp lỗi đầu tiên thì dừng:

| # | Việc | Công thức | Lỗi nếu hỏng |
|---|---|---|---|
| 1 | Join rule | `JournalLineRule` active có `JournalTypeCode = Event.JournalTypeCode` và `RuleSeq = Event.EventSeq` | `MISSING_RULE` |
| 2 | Lấy TK Nợ và TK Có | Nợ = cột tài khoản **trên event** ứng với `NormalDrAccountSource`, Có tương tự (`BANK_ACCOUNT`→`BankGLAccount`, `CONTRA_ACCOUNT`→`ContraAccount`, `TRANS_ACCOUNT`→`TransAccount`, `FEE_ACCOUNT`→`FeeAccount`) | `MISSING_ACCOUNT` (INFO + SKIPPED nếu có cờ Skip, ngược lại ERROR) |
| 3 | Kiểm tra CoA | Cả 2 TK phải có trong CoA | `ACCOUNT_NOT_IN_COA` |
| 4 | Số tiền | `amount = Event.Amount × AmountFactor`, làm tròn 2 số lẻ. Bằng 0 và `SkipIfAmountZero` thì bỏ qua | `AMOUNT_ZERO` (INFO, SKIPPED) |
| 5 | Số âm | Theo `NegativeMode`: SIGNED giữ âm, REVERSE đảo TK và lấy trị tuyệt đối, ERROR báo lỗi | `NEGATIVE_AMOUNT` |
| 6 | Partner của dòng | `PartnerMode = FIXED` → partner `FixedPartner`, ngược lại partner của event. Gắn lên dòng Nợ nếu `ApplyPartnerToDrLine = 1`, lên dòng Có nếu `ApplyPartnerToCrLine = 1` | – |
| 7 | Tỷ giá | InputCurr = FncCurr thì `XRate 1, MUL`. Khác thì tra `Exrate` active theo `Period` + `ReportCurrency = FncCurr` + `TransCurrency = InputCurr` (Exrate > 0, lấy dòng `ExrateDate` mới nhất). Xem [3.7](#37-exrate-tỷ-giá) và [10.5](#105-mô-phỏng--tỷ-giá) | `MISSING_FX` |
| 8 | Diễn giải | `memo = MemoTemplate ?? Event.Description ?? JournalTypeCode` | – |

Áp dụng cho 3 event của đơn ví dụ:

| Bước | Event 142 | Event 143 | Event 144 |
|---|---|---|---|
| 1. Rule | ID 97 (RuleSeq 20) | ID 98 | ID 100 |
| 2. Nguồn Nợ → TK | CONTRA_ACCOUNT → `ContraAccount` = **13122001** | CONTRA_ACCOUNT → **13122001** | TRANS_ACCOUNT → `TransAccount` = **63202001** |
| 2. Nguồn Có → TK | TRANS_ACCOUNT → `TransAccount` = **51112001** | TRANS_ACCOUNT → **51131001** | CONTRA_ACCOUNT → `ContraAccount` = **33102001** |
| 3. CoA | có cả 2 | có cả 2 | có cả 2 |
| 4. amount | 34.99 × 1 = **34.99** | 7.99 × 1 = **7.99** | 19.32 × 1 = **19.32** |
| 5. Âm? | Không | Không | Không |
| 6. Partner dòng | HEADER → INDIVIDUALS / INDIVIDUALS, gắn cả 2 dòng | INDIVIDUALS, cả 2 dòng | HEADER → nqcuong.0525@gmail.com / 0C1NIIRHX770DPREZ0L, cả 2 dòng |
| 7. Tỷ giá | USD = USD → XRate 1, MUL, Accounted = 34.99 | 1, MUL, 7.99 | 1, MUL, 19.32 |
| 8. memo | Orders Fulfilled Product Revenue Bulk \| CONTRA_TRANS | Orders Fulfilled ShipAdd Revenue Bulk \| CONTRA_TRANS | Orders Fulfilled Seller Profit Bulk \| CONTRA_TRANS |

Kết quả "nở" (chưa gom):

| Event | Dòng | AccountCode | Partner | Input | Accounted | XRate/RateType |
|---|---|---|---|---|---|---|
| 142 | Debit | 13122001 | INDIVIDUALS | 34.99 | 34.99 | 1 / MUL |
| 142 | Credit | 51112001 | INDIVIDUALS | 34.99 | 34.99 | 1 / MUL |
| 143 | Debit | 13122001 | INDIVIDUALS | 7.99 | 7.99 | 1 / MUL |
| 143 | Credit | 51131001 | INDIVIDUALS | 7.99 | 7.99 | 1 / MUL |
| 144 | Debit | 63202001 | nqcuong.0525@gmail.com | 19.32 | 19.32 | 1 / MUL |
| 144 | Credit | 33102001 | nqcuong.0525@gmail.com | 19.32 | 19.32 | 1 / MUL |

Nếu là **Single**, 6 dòng này đi thẳng thành 3 chứng từ (xem [10.1](#101-mô-phỏng--nếu-orders-được-cấu-hình-single)). Vì Orders là **Bulk**, còn thêm bước gom.

### 6.3. Bước 3c — Gom Bulk theo `PostingGroupKey`

```
PostingGroupKey = ComCode | JournalTypeCode | yyyyMMdd(PostingDate) | InputCurr | FncCurr
                | UPPER(PartnerCode) | PartnerTaxID | BankAccountNumber
```

(Phần NULL thành chuỗi rỗng. Partner ở đây là **partner của event**.)

| Event | PostingGroupKey |
|---|---|
| 142 | `ZENIROXPAY\|ORD_REV_PRODUCT_FULFILLED\|20251121\|USD\|USD\|INDIVIDUALS\|INDIVIDUALS\|` |
| 143 | `ZENIROXPAY\|ORD_REV_SHIPADD_FULFILLED\|20251121\|USD\|USD\|INDIVIDUALS\|INDIVIDUALS\|` |
| 144 | `ZENIROXPAY\|ORD_SELLER_PROFIT_FULFILLED\|20251121\|USD\|USD\|NQCUONG.0525@GMAIL.COM\|0C1NIIRHX770DPREZ0L\|` |

Ý nghĩa: các event **cùng công ty, cùng nghiệp vụ, cùng ngày, cùng tiền tệ, cùng đối tượng, cùng tài khoản ngân hàng** được gom thành **1 chứng từ**.

- Doanh thu có partner cố định `INDIVIDUALS`, nên **mọi đơn cùng ngày** gom chung. Event 142 rơi vào nhóm có **23 event** (23 đơn giao ngày 21/11).
- Seller profit có partner là seller, nên **mỗi seller mỗi ngày** một chứng từ riêng. Công ty cần biết nợ **từng seller** bao nhiêu. Seller `nqcuong.0525@gmail.com` chỉ có 1 đơn ngày 21/11, nên event 144 đứng một mình.

**Trong một nhóm, cộng dòng theo khóa:**

```
PairCode | Debit/Credit | AccountCode | PartnerCode | PartnerTaxID | XRate | RateType
```

Các dòng trùng khóa này được cộng `Input` với `Input` và `Accounted` với `Accounted` (đã làm tròn từng event). Với Orders, mỗi nhóm luôn ra **đúng 2 dòng**: 1 Nợ, 1 Có.

**Số chứng từ:**

```
DocNum (Bulk) = "ASB-" + yyyyMMdd(PostingDate) + "-" + AccountingEventID NHỎ NHẤT trong nhóm
```

**Nhóm của event 142: `ASB-20251121-106` (23 event, doanh thu tiền hàng ngày 21/11)**

| AccountingEventID | TransactionID | Raw item | Quantity × UnitPrice | Amount |
|---|---|---|---|---|
| **106** ← nhỏ nhất | ORD-15196-191125-I6G72-20251121 | 15196-191125-I6G72-1 | 1 × 64.99 | 64.99 |
| 109 | ORD-G2A22-191125-1L0O8-20251121 | G2A22-191125-1L0O8-1 | 1 × 36.95 | 36.95 |
| 112 | ORD-MTLYD-191125-4NSHG-20251121 | MTLYD-191125-4NSHG-1 | 1 × 68.98 | 68.98 |
| 115 | ORD-O9UBC-191125-N755A-20251121 | O9UBC-191125-N755A-1 | 1 × 54.99 | 54.99 |
| 118 | ORD-MTUBV-191125-RQ191-20251121 | MTUBV-191125-RQ191-1 | 1 × 34.99 | 34.99 |
| 121 | ORD-IL57A-191125-NBBHG-20251121 | IL57A-191125-NBBHG-1 | 1 × 19.95 | 19.95 |
| 124 | ORD-MTLYD-191125-LS9EA-20251121 | MTLYD-191125-LS9EA-1 | 1 × 68.98 | 68.98 |
| 127 | ORD-O9UBC-191125-M1V31-20251121 | O9UBC-191125-M1V31-1 | 1 × 34.99 | 34.99 |
| 130 | ORD-O9UBC-191125-M7O7L-20251121 | O9UBC-191125-M7O7L-1 | 1 × 54.99 | 54.99 |
| 133 | ORD-MTUBV-191125-346NF-20251121 | MTUBV-191125-346NF-1 | **2** × 66.99 | 133.98 |
| 136 | ORD-BT6P5-191125-E1D1K-20251121 | BT6P5-191125-E1D1K-1 | 1 × 32.96 | 32.96 |
| 139 | ORD-MTUBV-191125-IT7JI-20251121 | MTUBV-191125-IT7JI-1 | 1 × 49.88 | 49.88 |
| **142** ← đơn ví dụ | ORD-QVAJV-191125-Q1Z3V-20251121 | QVAJV-191125-Q1Z3V-1 | 1 × 34.99 | **34.99** |
| 145 | ORD-O9UBC-191125-J9DNS-20251121 | O9UBC-191125-J9DNS-1 | 1 × 34.99 | 34.99 |
| 148 | ORD-ZAAIC-191125-E38C3-20251121 | ZAAIC-191125-E38C3-1 | 1 × 59.99 | 59.99 |
| 151 | ORD-MTUBV-191125-W48AL-20251121 | MTUBV-191125-W48AL-1 | 1 × 49.88 | 49.88 |
| 154 | ORD-15196-191125-PVXFS-20251121 | 15196-191125-PVXFS-1 | 1 × 59.99 | 59.99 |
| 157 | ORD-ZAAIC-191125-75A3R-20251121 | ZAAIC-191125-75A3R-1 | 1 × 104.99 | 104.99 |
| 160 | ORD-ZAAIC-191125-JM39S-20251121 | ZAAIC-191125-JM39S-1 | 1 × 59.99 | 59.99 |
| 163 | ORD-ZAAIC-191125-20N71-20251121 | ZAAIC-191125-20N71-1 | 1 × 59.99 | 59.99 |
| 166 | ORD-ZAAIC-191125-NJ399-20251121 | ZAAIC-191125-NJ399-1 | 1 × 59.99 | 59.99 |
| 169 | ORD-ZLD2B-191125-2F5GC-20251121 | ZLD2B-191125-2F5GC-1 | 1 × 14.98 | 14.98 |
| 172 | ORD-MTUBV-191125-2JPIN-20251121 | MTUBV-191125-2JPIN-1 | 1 × 49.88 | 49.88 |
| | | | **Σ 23 event** | **1,246.29** |

**Nhóm của event 143: `ASB-20251121-107` (23 event, phí ship và phụ phí ngày 21/11)**

Cũng 23 đơn đó (event 107, 110, …, 173). `SHIPADD` của 21 đơn là 4.99, đơn `ZLD2B-191125-2F5GC` là 5.95, và **đơn ví dụ là 7.99** (4.99 + AdditionalCost 3):

```
21 × 4.99 + 5.95 + 7.99 = 104.79 + 5.95 + 7.99 = 118.73
```

**Nhóm của event 144: `ASB-20251121-144` (1 event)** → Amount 19.32.

### 6.4. Bước 3d — Sinh dòng GLTrans (đủ 33 cột)

Mapping cột GL cho **Bulk**:

| Cột GLTrans | Nguồn (Bulk) | Nguồn (Single, để so sánh) |
|---|---|---|
| `ID` | Tự tăng | Tự tăng |
| `ComCode`, `DataSource`, `JournalTypeCode` | Event **đầu tiên** (ID nhỏ nhất) của nhóm | Event |
| `DocNum` | `ASB-{yyyyMMdd}-{min EventID}` | `ASI-{yyyyMMdd}-{EventID}` |
| `PostingGroupKey` | Khóa nhóm | NULL |
| `PostBatchID` | PostingBatch của lượt post | (giống) |
| `ReferenceTxnID` | **NULL** (1 dòng gom nhiều giao dịch) | `Event.TransactionID` |
| `OrderID`, `RefNum` | **NULL** | `Event.OrderID`, `Event.RefNum` |
| `TransDate`, `DocDate` | `Event.PostingDate` | (giống) |
| `Period` | `Event.Period` | (giống) |
| `AccountCode` | TK Nợ (dòng Debit) / TK Có (dòng Credit) từ bước 3b | (giống) |
| `BankAccountNumber` | `Event.BankAccountNumber` (Orders: NULL) | (giống) |
| `PartnerCode`, `PartnerTaxID` | Partner dòng (bước 3b.6) | (giống) |
| `InputCurr`, `FncCurr` | Event | (giống) |
| `InputDr` / `InputCr` | Dòng Debit: `InputDr` = Σ input, `InputCr` = 0. Dòng Credit ngược lại | Số tiền của event |
| `XRate`, `RateType` | Tỷ giá dòng | (giống) |
| `AccountedDr` / `AccountedCr` | Như Input nhưng là số đã quy đổi | (giống) |
| `Description` | `{memo} \| {số event trong nhóm} events` | `{memo} \| {TransactionID}` |
| `BalanceImpact` | `Debit` / `Credit` | (giống) |
| `IsReversal`, `ReverseID`, `IsReval`, `Segment` | NULL (dự phòng, chưa dùng) | NULL |
| `AddDate` | Thời điểm post | (giống) |
| `ModifiedDate` | NULL | NULL |

**6 dòng GLTrans thật chứa số liệu của đơn ví dụ:**

| Cột | GL ID 19 | GL ID 20 | GL ID 21 | GL ID 22 | GL ID 37 | GL ID 38 |
|---|---|---|---|---|---|---|
| `ComCode` | ZENIROXPAY | ZENIROXPAY | ZENIROXPAY | ZENIROXPAY | ZENIROXPAY | ZENIROXPAY |
| `DataSource` | ORDERS | ORDERS | ORDERS | ORDERS | ORDERS | ORDERS |
| `JournalTypeCode` | ORD_REV_PRODUCT_FULFILLED | ORD_REV_PRODUCT_FULFILLED | ORD_REV_SHIPADD_FULFILLED | ORD_REV_SHIPADD_FULFILLED | ORD_SELLER_PROFIT_FULFILLED | ORD_SELLER_PROFIT_FULFILLED |
| `DocNum` | ASB-20251121-106 | ASB-20251121-106 | ASB-20251121-107 | ASB-20251121-107 | ASB-20251121-144 | ASB-20251121-144 |
| `PostingGroupKey` | ZENIROXPAY\|ORD_REV_PRODUCT_FULFILLED\|20251121\|USD\|USD\|INDIVIDUALS\|INDIVIDUALS\| | (giống) | ZENIROXPAY\|ORD_REV_SHIPADD_FULFILLED\|20251121\|USD\|USD\|INDIVIDUALS\|INDIVIDUALS\| | (giống) | ZENIROXPAY\|ORD_SELLER_PROFIT_FULFILLED\|20251121\|USD\|USD\|NQCUONG.0525@GMAIL.COM\|0C1NIIRHX770DPREZ0L\| | (giống) |
| `PostBatchID` | 1 | 1 | 1 | 1 | 1 | 1 |
| `ReferenceTxnID` | NULL | NULL | NULL | NULL | NULL | NULL |
| `OrderID` | NULL | NULL | NULL | NULL | NULL | NULL |
| `RefNum` | NULL | NULL | NULL | NULL | NULL | NULL |
| `TransDate` | 2025-11-21 | 2025-11-21 | 2025-11-21 | 2025-11-21 | 2025-11-21 | 2025-11-21 |
| `DocDate` | 2025-11-21 | 2025-11-21 | 2025-11-21 | 2025-11-21 | 2025-11-21 | 2025-11-21 |
| `Period` | 202511 | 202511 | 202511 | 202511 | 202511 | 202511 |
| **`AccountCode`** | **13122001** | **51112001** | **13122001** | **51131001** | **63202001** | **33102001** |
| `BankAccountNumber` | NULL | NULL | NULL | NULL | NULL | NULL |
| `PartnerCode` | INDIVIDUALS | INDIVIDUALS | INDIVIDUALS | INDIVIDUALS | nqcuong.0525@gmail.com | nqcuong.0525@gmail.com |
| `PartnerTaxID` | INDIVIDUALS | INDIVIDUALS | INDIVIDUALS | INDIVIDUALS | 0C1NIIRHX770DPREZ0L | 0C1NIIRHX770DPREZ0L |
| `InputCurr` | USD | USD | USD | USD | USD | USD |
| `FncCurr` | USD | USD | USD | USD | USD | USD |
| **`InputDr`** | **1246.29** | 0 | **118.73** | 0 | **19.32** | 0 |
| **`InputCr`** | 0 | **1246.29** | 0 | **118.73** | 0 | **19.32** |
| `XRate` | 1 | 1 | 1 | 1 | 1 | 1 |
| `RateType` | MUL | MUL | MUL | MUL | MUL | MUL |
| `AccountedDr` | 1246.29 | 0 | 118.73 | 0 | 19.32 | 0 |
| `AccountedCr` | 0 | 1246.29 | 0 | 118.73 | 0 | 19.32 |
| `Description` | Orders Fulfilled Product Revenue Bulk \| CONTRA_TRANS \| 23 events | (giống) | Orders Fulfilled ShipAdd Revenue Bulk \| CONTRA_TRANS \| 23 events | (giống) | Orders Fulfilled Seller Profit Bulk \| CONTRA_TRANS \| 1 events | (giống) |
| **`BalanceImpact`** | **Debit** | **Credit** | **Debit** | **Credit** | **Debit** | **Credit** |
| `IsReversal` / `ReverseID` / `IsReval` / `Segment` | NULL | NULL | NULL | NULL | NULL | NULL |
| `AddDate` | 2026-09-14 12:13:27 | (giống) | (giống) | (giống) | (giống) | (giống) |
| `ModifiedDate` | NULL | NULL | NULL | NULL | NULL | NULL |

Cách đọc:

- `PostingGroupKey` viết hoa email (`NQCUONG.0525@GMAIL.COM`), còn `PartnerCode` trên dòng GL giữ nguyên chữ thường. Khóa chỉ dùng để gom.
- `Description` luôn có chữ "Bulk | CONTRA_TRANS" vì đó là nguyên văn `MemoTemplate`. Phần `| 23 events` do code thêm vào.
- Vì là Bulk, **không dòng GL nào chứa `OrderID`**. Muốn biết 34.99 của đơn ví dụ nằm ở đâu thì phải đi qua AccountingEvent (Phần 7).

### 6.5. Bước 3e — Kiểm tra cân, ghi DB, cập nhật event

1. `assertBalanced`: với **từng DocNum**, Σ `AccountedDr` phải bằng Σ `AccountedCr` (so bằng Decimal). Lệch thì cả lượt post thất bại:
   - không ghi GLTrans, không đổi trạng thái event, không xóa hay ghi exception;
   - chỉ dòng `PostingBatch` (đã tạo trước với `Status = RUNNING`) được chuyển sang `FAILED`, kèm `ErrorMessage` "Chứng từ ... không cân: Nợ ... ≠ Có ...".
2. Transaction:
   - Insert GLTrans (gán `PostBatchID`, `AddDate`).
   - Event post được → `PostStatus = POSTED`, `PostedDocNum`, `PostingGroupKey`, `PostBatchID`, `PostedAt`, xóa `ErrorStage/ErrorMessage`, `ModifiedDate = now`.
   - Event lỗi → `ERROR` + `ErrorStage = POST` + `ErrorMessage`. Event bị bỏ qua → `SKIPPED` + `ErrorStage = POST`.
   - Xóa exception POST cũ của các ứng viên (khóa `EventID {id} | {TransactionID}`) rồi ghi exception mới.
   - PostingBatch → `SUCCESS` + các bộ đếm.

**3 event của đơn ví dụ sau khi post** (các cột khác giữ nguyên như 5.7):

| Cột | Event 142 | Event 143 | Event 144 |
|---|---|---|---|
| `PostStatus` | POSTED | POSTED | POSTED |
| `PostedDocNum` | ASB-20251121-106 | ASB-20251121-107 | ASB-20251121-144 |
| `PostingGroupKey` | ZENIROXPAY\|ORD_REV_PRODUCT_FULFILLED\|20251121\|USD\|USD\|INDIVIDUALS\|INDIVIDUALS\| | ZENIROXPAY\|ORD_REV_SHIPADD_FULFILLED\|20251121\|USD\|USD\|INDIVIDUALS\|INDIVIDUALS\| | ZENIROXPAY\|ORD_SELLER_PROFIT_FULFILLED\|20251121\|USD\|USD\|NQCUONG.0525@GMAIL.COM\|0C1NIIRHX770DPREZ0L\| |
| `PostBatchID` | 1 | 1 | 1 |
| `PostedAt` | 2026-09-14 12:13:27 | (giống) | (giống) |
| `ModifiedDate` | 2026-09-14 12:13:27 | (giống) | (giống) |

**`PostingBatch` thật:**

| PostBatchID | DataSource | Classify | JournalTypeCode | ComCodeList | PeriodFrom | PeriodTo | Status | InsertedRows | PostedEvents | ErrorEvents | SkippedEvents | ErrorMessage |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | NULL | Bulk | NULL | ZENIROXPAY | 202511 | 202511 | SUCCESS | 42 | 174 | 0 | 0 | NULL |

- `DataSource = NULL` vì lúc post không chọn nguồn.
- `ComCodeList`, `PeriodFrom/To` lấy từ các event ứng viên khi không chọn phạm vi.
- `PostingBatch` là **nhật ký của một lần bấm Post**, không phải chứng từ. Unpost theo batch sẽ xóa các dòng GL có `PostBatchID` đó và đưa event về `NEW`.

---

## Phần 7 — Truy vết ngược: từ 1 dòng GL về order gốc

Không có foreign key. Liên kết đi qua **giá trị**:

```
GLTrans.DocNum ─────────────► AccountingEvent.PostedDocNum
AccountingEvent.OrderID  ─┐
AccountingEvent.PostingDate┴► RawOrders.OrderId + RawOrders.FulfilledAt
RawOrders.ImportBatchID ────► ImportBatch.ImportBatchID
```

Ví dụ: dòng GL `ID 19` (Nợ 13122001, 1,246.29), đã có trong nhóm ở mục 6.3:

```sql
-- 1. Dòng GL
SELECT DocNum, AccountCode, InputDr FROM GLTrans WHERE ID = 19;
--    ASB-20251121-106 | 13122001 | 1246.29

-- 2. Các event tạo nên chứng từ đó (23 dòng, Σ Amount = 1246.29)
SELECT AccountingEventID, OrderID, PostingDate, Amount
FROM AccountingEvent WHERE PostedDocNum = 'ASB-20251121-106';

-- 3. Dòng raw của từng event
SELECT r.* FROM RawOrders r
JOIN AccountingEvent e ON r.OrderId = e.OrderID AND r.FulfilledAt = e.PostingDate
WHERE e.AccountingEventID = 142;
--    QVAJV-191125-Q1Z3V-1 | FULFILLED | 1 × 34.99 | ...
```

Trên web: trang **4. GLTrans** → click dòng GL → Drawer chứng từ hiện các dòng GL, các event và raw order. Hoặc trang **2. AccountingEvent** → click event → Drawer hiện rule sẽ áp dụng, raw order và dòng GL.

---

## Phần 8 — Ví dụ 2: gom Bulk theo seller (4 đơn → 1 chứng từ)

Seller `trangpukin0911@gmail.com` (store `KVC`) có 4 đơn giao ngày 21/11/2025.

**Dữ liệu raw (các cột Build dùng):**

| RawOrderID | ItemCode | Quantity | UnitPrice | ShippingFee | AdditionalCost | TaxFee | Profit | StoreName |
|---|---|---|---|---|---|---|---|---|
| 45 | O9UBC-191125-N755A-1 | 1 | 54.99 | 4.99 | 0 | 0 | 44.27 | KVC |
| 49 | O9UBC-191125-M1V31-1 | 1 | 34.99 | 4.99 | 0 | 0 | 28.94 | KVC |
| 50 | O9UBC-191125-M7O7L-1 | 1 | 54.99 | 4.99 | 0 | 0 | 44.27 | KVC |
| 55 | O9UBC-191125-J9DNS-1 | 1 | 34.99 | 4.99 | 0 | 0 | 28.94 | KVC |

**Resolve seller:** email có 1 dòng Partners → `EMAIL` → `PartnerTaxID = RLE5L5W2XLMGH9DESPHO`, `PartnerName = FFT-FFT KVC`.

**Build ra 12 event** (4 đơn × 3 nghiệp vụ; TAX = 0 bị bỏ qua). Riêng seller profit:

| AccountingEventID | TransactionID | Amount | PartnerCode | PartnerTaxID |
|---|---|---|---|---|
| 117 | ORD-O9UBC-191125-N755A-20251121 | 44.27 | trangpukin0911@gmail.com | RLE5L5W2XLMGH9DESPHO |
| 129 | ORD-O9UBC-191125-M1V31-20251121 | 28.94 | trangpukin0911@gmail.com | RLE5L5W2XLMGH9DESPHO |
| 132 | ORD-O9UBC-191125-M7O7L-20251121 | 44.27 | trangpukin0911@gmail.com | RLE5L5W2XLMGH9DESPHO |
| 147 | ORD-O9UBC-191125-J9DNS-20251121 | 28.94 | trangpukin0911@gmail.com | RLE5L5W2XLMGH9DESPHO |

(Event PRODUCT và SHIPADD của 4 đơn này nằm trong 2 nhóm 23 event ở mục 6.3.)

**Cả 4 event có cùng PostingGroupKey:**

```
ZENIROXPAY|ORD_SELLER_PROFIT_FULFILLED|20251121|USD|USD|TRANGPUKIN0911@GMAIL.COM|RLE5L5W2XLMGH9DESPHO|
```

**Gom:** 4 dòng Debit 63202001 cùng khóa dòng nên cộng lại, 4 dòng Credit 33102001 cũng vậy.

```
44.27 + 28.94 + 44.27 + 28.94 = 146.42
DocNum = ASB-20251121-117   (117 là ID nhỏ nhất)
```

**GLTrans:**

| ID | DocNum | AccountCode | PartnerCode | PartnerTaxID | InputDr | InputCr | Description | BalanceImpact |
|---|---|---|---|---|---|---|---|---|
| 29 | ASB-20251121-117 | 63202001 | trangpukin0911@gmail.com | RLE5L5W2XLMGH9DESPHO | 146.42 | 0 | Orders Fulfilled Seller Profit Bulk \| CONTRA_TRANS \| 4 events | Debit |
| 30 | ASB-20251121-117 | 33102001 | trangpukin0911@gmail.com | RLE5L5W2XLMGH9DESPHO | 0 | 146.42 | Orders Fulfilled Seller Profit Bulk \| CONTRA_TRANS \| 4 events | Credit |

Ý nghĩa: ngày 21/11/2025, công ty ghi nhận **đang nợ store KVC 146.42 USD** tiền chia lợi nhuận của 4 đơn. Khi thanh toán cho seller, kế toán đối chiếu `33102001` theo `PartnerTaxID = RLE5L5W2XLMGH9DESPHO`.

---

## Phần 9 — Ví dụ 3: dòng bị loại và khoản tiền bằng 0

### 9.1. Bốn dòng `UNFULFILLED` bị bỏ qua

| RawOrderID | ItemCode | ItemStatus | FulfilledAt | BuyerName | StoreName | UnitPrice | TaxFee | Profit |
|---|---|---|---|---|---|---|---|---|
| 1 | JFSMZ-191125-R1F4R-1 | UNFULFILLED | NULL | ORDER_TEST John Smith | Test FFT | 8.35 | 0 | NULL |
| 3 | XFJKR-211125-JXAT9-1 | UNFULFILLED | NULL | ORDER_TEST Nguyễn Việt | PTI | 52.99 | 0 | NULL |
| 5 | RF6A2-231125-5D4HD-1 | UNFULFILLED | NULL | ORDER_TEST Yil Bka | TQZ | 35.99 | 0 | NULL |
| 8 | G2A22-171125-1IM2M-1 | UNFULFILLED | NULL | Alius Estinvil | DWF | 36.95 | **2.94** | 28.49 |

Kết quả Build cho mỗi dòng:

- `RawOrders.BuildStatus = SKIPPED`, `BuildMessage = "ItemStatus=UNFULFILLED, FulfilledAt trống → không ghi nhận doanh thu"`. `ComCode` vẫn được ghi là `ZENIROXPAY`.
- 1 exception, ví dụ dòng thật:

| ID | BatchType | ComCode | Period | Severity | ExceptionType | SourceKey | Message |
|---|---|---|---|---|---|---|---|
| 1 | BUILD | ZENIROXPAY | NULL | INFO | NOT_FULFILLED | JFSMZ-191125-R1F4R-1 | ItemStatus=UNFULFILLED, FulfilledAt trống → không ghi nhận doanh thu |

- **Không** sinh event nào. Dòng `G2A22-171125-1IM2M-1` là dòng duy nhất trong file có `TaxFee ≠ 0`, nhưng vì chưa giao nên nghiệp vụ TAX ra 0 event trong baseline.

### 9.2. Các dòng "Extra Fee": khoản bằng 0 bị bỏ qua

Seller `vallary.sp@gmail.com` (store `Extra Fee`) có 4 dòng phụ phí đã FULFILLED nhưng **cột Profit trống**:

| RawOrderID | ItemCode | VariantName | FulfilledAt | Quantity × UnitPrice | ShippingFee | AdditionalCost | Profit |
|---|---|---|---|---|---|---|---|
| 2 | RP1RH-211125-4DTTX-1 | Extra Fee $19 ($19) | 2025-11-24 | 1 × 19 | 1 | 0 | NULL |
| 4 | RP1RH-211125-74CK8-1 | Extra Fee $19 ($19) | 2025-11-24 | 1 × 19 | 1 | 0 | NULL |
| 6 | RP1RH-241125-6U45W-1 | Extra Fee $19 ($19) | 2025-11-26 | 1 × 19 | 0 | 0 | NULL |
| 7 | RP1RH-251125-WX0YU-1 | Extra Fee $20 ($20) | 2025-11-27 | 1 × 20 | 0 | 0 | NULL |

Tính toán từng nhóm (Profit NULL tính là 0):

| Đơn | PRODUCT | SHIPADD | TAX | SELLER_PROFIT | Event sinh ra |
|---|---|---|---|---|---|
| RP1RH-211125-4DTTX (24/11) | 19 → event **1** | 1 → event **2** | 0 → bỏ | 0 → bỏ | 2 |
| RP1RH-211125-74CK8 (24/11) | 19 → event **3** | 1 → event **4** | 0 → bỏ | 0 → bỏ | 2 |
| RP1RH-241125-6U45W (26/11) | 19 → event **5** | 0 → bỏ | 0 → bỏ | 0 → bỏ | 1 |
| RP1RH-251125-WX0YU (27/11) | 20 → event **6** | 0 → bỏ | 0 → bỏ | 0 → bỏ | 1 |

Mỗi khoản bị bỏ sinh 1 exception `AMOUNT_ZERO` (INFO), ví dụ `SourceKey = ORD-RP1RH-241125-6U45W-20251126|ORD_REV_SHIPADD_FULFILLED`, `Message = "SHIPADD = 0 → bỏ qua (SkipIfAmountZero)"`.

Các dòng này nằm ở đầu file (RawOrderID 2, 4, 6, 7, xen kẽ với các dòng UNFULFILLED), nên là những nhóm đầu tiên sinh event và nhận ID 1 → 6. Kết quả GL:

| DocNum | Nợ | Có | Số tiền | Số event |
|---|---|---|---|---|
| ASB-20251124-1 | 13122001 | 51112001 | 38.00 | 2 (event 1, 3) |
| ASB-20251124-2 | 13122001 | 51131001 | 2.00 | 2 (event 2, 4) |
| ASB-20251126-5 | 13122001 | 51112001 | 19.00 | 1 |
| ASB-20251127-6 | 13122001 | 51112001 | 20.00 | 1 |

### 9.3. Đếm đủ 66 khoản bằng 0 của file mẫu

```
60 nhóm fulfilled × 4 nghiệp vụ = 240 khả năng
  − TAX = 0 ở cả 60 nhóm                 → 60
  − SHIPADD = 0 (2 dòng Extra Fee)       →  2
  − SELLER_PROFIT = 0 (4 dòng Extra Fee) →  4
                                          ─────
                                            66 AMOUNT_ZERO
240 − 66 = 174 event  (PRODUCT 60 + SHIPADD 58 + TAX 0 + SELLER_PROFIT 56)
Exception BUILD = 66 AMOUNT_ZERO + 4 NOT_FULFILLED = 70 (đều INFO)
```

---

## Phần 10 — Các tình huống mô phỏng

> **MÔ PHỎNG:** các kết quả dưới đây được sinh bằng cách gọi **hàm engine thật** (`postEvents`, `expandEvent`, `buildOrderEvents`, `resolveSeller`) trên dữ liệu của đơn ví dụ **đã sửa một chút**. Chúng không có trong file mẫu và không ghi vào DB.

### 10.1. MÔ PHỎNG — Nếu Orders được cấu hình Single

Đổi `JournalType.Classify` của 4 nghiệp vụ ORDERS thành `Single`, rồi post 3 event 142/143/144:

| DocNum | AccountCode | InputDr | InputCr | PostingGroupKey | ReferenceTxnID | OrderID | RefNum | Description | BalanceImpact |
|---|---|---|---|---|---|---|---|---|---|
| ASI-20251121-142 | 13122001 | 34.99 | 0 | NULL | ORD-QVAJV-191125-Q1Z3V-20251121 | QVAJV-191125-Q1Z3V | QVAJV-191125-Q1Z3V | Orders Fulfilled Product Revenue Bulk \| CONTRA_TRANS \| ORD-QVAJV-191125-Q1Z3V-20251121 | Debit |
| ASI-20251121-142 | 51112001 | 0 | 34.99 | NULL | (giống) | (giống) | (giống) | (giống) | Credit |
| ASI-20251121-143 | 13122001 | 7.99 | 0 | NULL | (giống) | (giống) | (giống) | Orders Fulfilled ShipAdd Revenue Bulk \| CONTRA_TRANS \| ORD-QVAJV-191125-Q1Z3V-20251121 | Debit |
| ASI-20251121-143 | 51131001 | 0 | 7.99 | NULL | (giống) | (giống) | (giống) | (giống) | Credit |
| ASI-20251121-144 | 63202001 | 19.32 | 0 | NULL | (giống) | (giống) | (giống) | Orders Fulfilled Seller Profit Bulk \| CONTRA_TRANS \| ORD-QVAJV-191125-Q1Z3V-20251121 | Debit |
| ASI-20251121-144 | 33102001 | 0 | 19.32 | NULL | (giống) | (giống) | (giống) | (giống) | Credit |

So với Bulk:

- `DocNum` là `ASI-{yyyyMMdd}-` + ID của **chính event** (VD `ASI-20251121-142`), thay vì ID event nhỏ nhất của nhóm như Bulk (`ASB-{yyyyMMdd}-{min EventID}`). Tiền tố `ASI` dùng cho Single, `ASB` dùng cho Bulk.
- Có `ReferenceTxnID/OrderID/RefNum`, nên nhìn dòng GL là biết ngay đơn nào.
- `Description` kết thúc bằng `TransactionID` thay vì `N events`. Chữ "Bulk" vẫn còn vì nó nằm cứng trong `MemoTemplate`.
- 6 dòng / 3 chứng từ cho 1 đơn. Toàn file mẫu sẽ thành 174 chứng từ / 348 dòng thay vì 21 / 42.

### 10.2. MÔ PHỎNG — Một đơn có nhiều item

Thêm vào đơn ví dụ một dòng thứ 2 cùng `OrderId` và cùng `FulfilledAt`: `ItemCode = QVAJV-191125-Q1Z3V-2`, `Quantity 2`, `UnitPrice 12.5`, `ShippingFee 0`, `AdditionalCost 1.2`, `TaxFee 0.8`, `Profit 6.1`.

| AmountSource | Item -1 | Item -2 | Tổng nhóm = Amount event |
|---|---|---|---|
| PRODUCT | 1 × 34.99 | 2 × 12.5 = 25 | **59.99** |
| SHIPADD | 4.99 + 3 | 0 + 1.2 | **9.19** |
| TAX | 0 | 0.8 | **0.80** → lần này **có event TAX** |
| SELLER_PROFIT | 19.32 | 6.1 | **25.42** |

Kết quả: **4 event** (không phải 8). Mỗi event có `rawOrderIds = [54, 9001]` và `items` trong SourceHash gồm cả 2 ItemCode. Event TAX ra bút toán `Nợ 13122001 / Có 33302001` 0.80: phần thuế khách trả **không phải doanh thu** mà là khoản phải nộp nhà nước.

> Seller của cả nhóm lấy từ dòng **đầu tiên**. Nếu 2 item của cùng một đơn có seller khác nhau (hiếm), item sau vẫn bị tính cho seller của item đầu.

### 10.3. MÔ PHỎNG — Số tiền âm với 3 chế độ NegativeMode

Đổi `Amount` của event 144 (seller profit) thành **−12.50**, ví dụ khi có điều chỉnh giảm lợi nhuận seller:

| NegativeMode | Kết quả `expandEvent` |
|---|---|
| **SIGNED** (cấu hình thật của Orders) | Nợ **63202001** = **−12.50** / Có **33102001** = **−12.50** (giữ tài khoản, ghi số âm cả 2 vế) |
| REVERSE (mô phỏng đổi rule) | Nợ **33102001** = 12.50 / Có **63202001** = 12.50 (đảo tài khoản, lấy trị tuyệt đối) |
| ERROR (mô phỏng đổi rule) | Không ra dòng GL. Lỗi `NEGATIVE_AMOUNT`: "Amount âm (-12.50) với NegativeMode=ERROR" |

SIGNED và REVERSE cho **cùng ảnh hưởng số dư** (chi phí giảm 12.50, nợ seller giảm 12.50). Khác nhau ở cách thể hiện:

- SIGNED hợp với Bulk vì trong cùng nhóm, số âm **tự bù trừ** với số dương thành 1 dòng ròng.
- REVERSE ra dòng dương, dễ đọc hơn khi post từng giao dịch (cấu hình PayPal và Stripe trong seed dùng REVERSE).

Tài liệu yêu cầu cũng nói rõ: *hệ thống không tự đảo Nợ/Có chỉ vì amount âm*; mọi thứ theo `NegativeMode`.

### 10.4. MÔ PHỎNG — AmountFactor

Orders đều có `AmountFactor = 1`. Nếu rule có `AmountFactor = -1` (VD rule phí PayPal `FEE_BANK`), lúc Post `amount = Event.Amount × (−1)`. Event vẫn lưu số **chưa nhân**. Đó là lý do cột `Amount` trên event được mô tả là "chưa nhân AmountFactor".

### 10.5. MÔ PHỎNG — Tỷ giá

Đổi `InputCurr` của event 142 thành `CAD` (FncCurr vẫn USD, kỳ 202511):

```
Tra Exrate: IsActive = 1, Period = "202511", ReportCurrency = "USD" (=FncCurr), TransCurrency = "CAD" (=InputCurr), Exrate > 0
   → ExrateID 11: Exrate = 1.4055, RateType = DIV   (nhiều dòng thì lấy ExrateDate mới nhất)
AccountedDr = 34.99 ÷ 1.4055 = 24.89505...  → làm tròn 2 số lẻ (ROUND_HALF_UP) = 24.90
```

| Dòng | AccountCode | InputDr/Cr | XRate | RateType | AccountedDr/Cr |
|---|---|---|---|---|---|
| Debit | 13122001 | 34.99 | 1.4055 | DIV | 24.90 |
| Credit | 51112001 | 34.99 | 1.4055 | DIV | 24.90 |

- `RateType = MUL` thì `Accounted = Input × XRate`. Mọi giá trị khác `DIV` đều bị coi là MUL.
- Đổi `InputCurr` thành `EUR`: không có dòng tỷ giá → lỗi `MISSING_FX` "Thiếu tỷ giá EUR→USD kỳ 202511", event → `ERROR/POST`, sẽ được thử lại ở lần Post sau.
- Code hiện chỉ tra tỷ giá **theo kỳ** (tháng). Chưa có tỷ giá theo ngày và bảng ExchangeRateResolveRule như tài liệu yêu cầu §11.

### 10.6. MÔ PHỎNG — Resolve seller khi một email có nhiều store

`bettamax001@gmail.com` có 8 dòng Partners (đều `PartnerType = Seller`):

| PartnerID | PartnerTaxID | PartnerName |
|---|---|---|
| 130 | 3RGM9K3S9IUS5HXK0QS | FFT-Test 05 |
| 156 | 4R94PYMQ2I4KXCOTLO5Y | FFT-Test FFT |
| 234 | 7CJFRW8KFKLDKYTL3G6 | FFT-GG ADS 02 |
| 696 | GKV1IRJHITEBERWWWLKE | FFT-Test 02 |
| 1308 | QO7EDWSX1SUTKKCZAV6U | FFT-BettaMax001 |
| 1482 | TK0CJVQBDB2EIMXR0UIR | FFT-Test 03 |
| 1513 | U7DITQDACBV6JEMYQBI9 | FFT-GG ADS 01 |
| 1766 | YSETXVUWELZXIXCLKJN | FFT-BettaMax |

| Đầu vào | Kết quả |
|---|---|
| email + `StoreName = "Test FFT"` | ✅ `EMAIL_STORE` → PartnerTaxID `4R94PYMQ2I4KXCOTLO5Y`, `FFT-Test FFT` (khớp mẫu `FFT-{Store}`) |
| email + `StoreName` trống | ❌ "Seller bettamax001@gmail.com có 8 store trong Partners, không xác định được store """ |
| email + `StoreName = "KHONGCO"` | ❌ "... có 8 store trong Partners, không xác định được store "KHONGCO"" |
| `TaxID = VA4ZH4IIFMUTCFCXF1GY` + email sai `email-sai@example.com` | ✅ `TAX_ID` → `cong2672000@gmail.com`, `FFT-FFT ARG` (TaxID được ưu tiên hơn email) |
| Không có TaxID, không có email | ❌ "Order không có SellerEmail/TaxID để map seller" |

### 10.7. MÔ PHỎNG — Không tìm thấy seller

Đổi `SellerEmail` của đơn ví dụ thành `khong-ton-tai@example.com`, rồi Build:

| JournalTypeCode | PostStatus | ErrorStage | PartnerCode | PartnerTaxID | PartnerName | ErrorMessage |
|---|---|---|---|---|---|---|
| ORD_REV_PRODUCT_FULFILLED | NEW | NULL | INDIVIDUALS | INDIVIDUALS | INDIVIDUALS | NULL |
| ORD_REV_SHIPADD_FULFILLED | NEW | NULL | INDIVIDUALS | INDIVIDUALS | INDIVIDUALS | NULL |
| ORD_SELLER_PROFIT_FULFILLED | **ERROR** | **BUILD** | khong-ton-tai@example.com | NULL | NULL | Không tìm thấy seller khong-ton-tai@example.com trong Partners |

Exception: `MISSING_PARTNER` (ERROR), `SourceKey = ORD-QVAJV-191125-Q1Z3V-20251121|ORD_SELLER_PROFIT_FULFILLED`.

- Doanh thu **vẫn post được**. Chỉ phần seller profit bị giữ lại.
- Dòng raw vẫn `BUILT` (lỗi nằm ở event, không phải ở dòng raw).
- Cách xử lý: bổ sung seller vào Partners (Sync Google Sheet), rồi Build lại. Event ERROR được thay bằng event NEW, sau đó Post.

### 10.8. MÔ PHỎNG — Cổng thanh toán chưa được map

Đổi `PaymentGatewayName` thành `NewPay LLC`, rồi Build:

- Dòng raw → `BuildStatus = ERROR`, `ComCode = NULL`, `BuildMessage = Chưa map PaymentGatewayName "NewPay LLC" sang ComCode (Master → GatewayCompanyMapping)`.
- Exception `MISSING_COMCODE` (ERROR), `SourceKey = QVAJV-191125-Q1Z3V-1`.
- **Không sinh event nào**, vì không biết ghi sổ cho công ty nào.

---

## Phần 11 — Kết quả toàn bộ file mẫu và ý nghĩa kế toán

### 11.1. 21 chứng từ

| DocNum | JournalTypeCode | Số event | Nợ | Có | Partner | Số tiền |
|---|---|---|---|---|---|---|
| ASB-20251124-1 | ORD_REV_PRODUCT_FULFILLED | 2 | 13122001 | 51112001 | INDIVIDUALS | 38.00 |
| ASB-20251124-2 | ORD_REV_SHIPADD_FULFILLED | 2 | 13122001 | 51131001 | INDIVIDUALS | 2.00 |
| ASB-20251126-5 | ORD_REV_PRODUCT_FULFILLED | 1 | 13122001 | 51112001 | INDIVIDUALS | 19.00 |
| ASB-20251127-6 | ORD_REV_PRODUCT_FULFILLED | 1 | 13122001 | 51112001 | INDIVIDUALS | 20.00 |
| ASB-20251120-7 | ORD_REV_PRODUCT_FULFILLED | 33 | 13122001 | 51112001 | INDIVIDUALS | 2,230.66 |
| ASB-20251120-8 | ORD_REV_SHIPADD_FULFILLED | 33 | 13122001 | 51131001 | INDIVIDUALS | 164.67 |
| ASB-20251120-9 | ORD_SELLER_PROFIT_FULFILLED | 5 | 63202001 | 33102001 | lyndylutz@gmail.com | 145.00 |
| ASB-20251120-12 | ORD_SELLER_PROFIT_FULFILLED | 11 | 63202001 | 33102001 | cong2672000@gmail.com | 397.04 |
| ASB-20251120-48 | ORD_SELLER_PROFIT_FULFILLED | 17 | 63202001 | 33102001 | nguyenthang5356@gmail.com | 1,027.68 |
| ASB-20251121-106 | ORD_REV_PRODUCT_FULFILLED | 23 | 13122001 | 51112001 | INDIVIDUALS | 1,246.29 |
| ASB-20251121-107 | ORD_REV_SHIPADD_FULFILLED | 23 | 13122001 | 51131001 | INDIVIDUALS | 118.73 |
| ASB-20251121-108 | ORD_SELLER_PROFIT_FULFILLED | 2 | 63202001 | 33102001 | levantai290296@gmail.com | 135.01 |
| ASB-20251121-111 | ORD_SELLER_PROFIT_FULFILLED | 1 | 63202001 | 33102001 | lyndylutz@gmail.com | 27.65 |
| ASB-20251121-114 | ORD_SELLER_PROFIT_FULFILLED | 2 | 63202001 | 33102001 | quangtrung95dhcn@gmail.com | 94.74 |
| ASB-20251121-117 | ORD_SELLER_PROFIT_FULFILLED | 4 | 63202001 | 33102001 | trangpukin0911@gmail.com | 146.42 |
| ASB-20251121-120 | ORD_SELLER_PROFIT_FULFILLED | 5 | 63202001 | 33102001 | cong2672000@gmail.com | 212.66 |
| ASB-20251121-123 | ORD_SELLER_PROFIT_FULFILLED | 1 | 63202001 | 33102001 | nguyendev1105@gmail.com | 15.49 |
| ASB-20251121-138 | ORD_SELLER_PROFIT_FULFILLED | 1 | 63202001 | 33102001 | dangthanh1231996@gmail.com | 27.48 |
| ASB-20251121-144 | ORD_SELLER_PROFIT_FULFILLED | 1 | 63202001 | 33102001 | nqcuong.0525@gmail.com | 19.32 |
| ASB-20251121-150 | ORD_SELLER_PROFIT_FULFILLED | 5 | 63202001 | 33102001 | nguyenthang5356@gmail.com | 238.59 |
| ASB-20251121-171 | ORD_SELLER_PROFIT_FULFILLED | 1 | 63202001 | 33102001 | mastur007@gmail.com | 13.27 |
| | | **174** | | | **Σ** | **6,339.70** |

Chú ý: `lyndylutz@gmail.com`, `cong2672000@gmail.com` và `nguyenthang5356@gmail.com` mỗi người có **2 chứng từ** (ngày 20 và ngày 21) vì ngày nằm trong `PostingGroupKey`.

### 11.2. Tổng hợp theo tài khoản (bảng cân đối phát sinh thu nhỏ)

| AccountCode | Tên | Loại | Phát sinh Nợ | Phát sinh Có | Số dòng GL |
|---|---|---|---|---|---|
| 13122001 | Người mua trả tiền trước | A | 3,839.35 | 0 | 8 |
| 51112001 | Doanh thu bán hàng | R | 0 | 3,553.95 | 5 |
| 51131001 | Doanh thu dịch vụ - Shipping | R | 0 | 285.40 | 3 |
| 63202001 | Giá vốn - SellerCost | Exp | 2,500.35 | 0 | 13 |
| 33102001 | Phải trả Seller | L | 0 | 2,500.35 | 13 |
| | **Tổng** | | **6,339.70** | **6,339.70** | **42** |

Đọc bảng này theo ngôn ngữ kinh doanh (tháng 11/2025, công ty ZENIROXPAY, chỉ tính các đơn trong file mẫu):

- **Doanh thu ghi nhận:** 3,553.95 (hàng) + 285.40 (ship và phụ phí) = **3,839.35 USD**.
- **Tiền khách ứng trước đã được dùng:** 3,839.35 (Nợ `13122001`). Luôn bằng tổng doanh thu cộng thuế (thuế đang = 0).
- **Phần chia seller:** chi phí **2,500.35**, đồng thời công ty **nợ các seller 2,500.35**, chi tiết theo từng `PartnerTaxID`.
- **Doanh thu trừ phần chia seller:** 3,839.35 − 2,500.35 = **1,339.00 USD**. Đây chưa phải lợi nhuận, vì các chi phí khác (fulfillment, phí cổng thanh toán...) không đi qua nguồn Orders.

### 11.3. Theo ngày

| TransDate | Nghiệp vụ | Số chứng từ | Số tiền |
|---|---|---|---|
| 2025-11-20 | PRODUCT | 1 | 2,230.66 |
| 2025-11-20 | SHIPADD | 1 | 164.67 |
| 2025-11-20 | SELLER_PROFIT | 3 | 1,569.72 |
| 2025-11-21 | PRODUCT | 1 | 1,246.29 |
| 2025-11-21 | SHIPADD | 1 | 118.73 |
| 2025-11-21 | SELLER_PROFIT | 10 | 930.63 |
| 2025-11-24 | PRODUCT | 1 | 38.00 |
| 2025-11-24 | SHIPADD | 1 | 2.00 |
| 2025-11-26 | PRODUCT | 1 | 19.00 |
| 2025-11-27 | PRODUCT | 1 | 20.00 |

### 11.4. Toàn bộ vòng đời kế toán của một đơn (bức tranh lớn)

Chỉ bước ② đã được code. Bước ① và ③ dựa trên cấu hình có sẵn trong seed và được ghi lại để bạn thấy các tài khoản nối nhau thế nào.

```
① Khách trả 39.98 USD qua PayPal (19/11)          [nguồn PAYPAL – CHƯA CODE, theo cấu hình seed]
      Nợ 11202051 PayPal - Available        39.98
          Có 13122001 Người mua trả tiền trước    39.98
      (phí PayPal: Nợ 64202010 Phí cổng thanh toán / Có 11202051)

② Đơn giao xong (21/11)                            [nguồn ORDERS – ĐÃ CODE, tài liệu này]
      Nợ 13122001 Người mua trả tiền trước  34.99  +  7.99
          Có 51112001 Doanh thu bán hàng           34.99
          Có 51131001 Doanh thu dịch vụ ship         7.99
      Nợ 63202001 Giá vốn - SellerCost      19.32
          Có 33102001 Phải trả Seller (FFT-JJC)    19.32

③ Trả tiền cho seller                              [nguồn ngân hàng/AccountingSource – CHƯA CODE]
      Nợ 33102001 Phải trả Seller (FFT-JJC)  19.32
          Có 11202xxx Tiền ngân hàng/ví            19.32
```

Giả sử nguồn PayPal sau này ghi Có `13122001` đúng bằng số khách trả (`TotalPrice` = 39.98). Khi đó `13122001` của đơn này còn **dư Nợ 3.00** (ghi Nợ 42.98 − ghi Có 39.98), đúng bằng `AdditionalCost`. Đây chính là điểm cần xác nhận ở [5.4](#54-bước-2c--ngày-ghi-sổ-kỳ-nhóm-và-số-tiền). `33102001` của seller JJC về 0 sau bước ③.

---

## Phần 12 — Bảng tra nhanh: cột nào đến từ đâu

### 12.1. Chuỗi tra cứu master

```
RawOrders.PaymentGatewayName ──► GatewayCompanyMapping ──► ComCode
ComCode                      ──► Company               ──► FncCurr (FunctionalCurrency)
"ORDERS" + JournalTypeCode   ──► JournalType           ──► 4 tài khoản vai trò, Partner rule, Classify, Description
JournalTypeCode              ──► JournalLineRule       ──► RuleSeq, AmountSource, NormalDr/Cr, NegativeMode, Skip…, Memo
TaxID / SellerEmail+StoreName──► Partners              ──► PartnerCode, PartnerTaxID, PartnerName
AccountCode                  ──► CoA                   ──► kiểm tra tồn tại (lúc Post)
Period + FncCurr + InputCurr ──► Exrate                ──► XRate, RateType (khi khác tiền)
```

### 12.2. Nguồn gốc của từng cột GLTrans (Bulk, Orders)

| Cột GLTrans | ← AccountingEvent | ← RawOrders / Master |
|---|---|---|
| `ComCode` | `ComCode` | `GatewayCompanyMapping(PaymentGatewayName)` |
| `DataSource` | `DataSource` | hằng `ORDERS` |
| `JournalTypeCode` | `JournalTypeCode` | `JournalType.JournalTypeCode` |
| `DocNum` | `ASB-` + yyyyMMdd(`PostingDate`) + `-` + min(`AccountingEventID`) | `FulfilledAt` |
| `PostingGroupKey` | ghép `ComCode, JournalTypeCode, PostingDate, InputCurr, FncCurr, PartnerCode, PartnerTaxID, BankAccountNumber` | – |
| `PostBatchID` | – | PostingBatch |
| `ReferenceTxnID` / `OrderID` / `RefNum` | NULL (Single: `TransactionID` / `OrderID` / `RefNum`) | `OrderId` |
| `TransDate` / `DocDate` | `PostingDate` | `FulfilledAt` |
| `Period` | `Period` | YYYYMM(`FulfilledAt`) |
| `AccountCode` | cột TK theo `NormalDr/CrAccountSource` (`ContraAccount` / `TransAccount`...) | `JournalType.*Account` (copy lúc Build) + `JournalLineRule` (đọc lúc Post) |
| `BankAccountNumber` | `BankAccountNumber` | Orders: NULL |
| `PartnerCode` / `PartnerTaxID` | `PartnerCode` / `PartnerTaxID` (PartnerMode HEADER) | `Partners` qua `Fixed = Individuals` hoặc `SellerEmail`/`TaxID`/`StoreName` |
| `InputCurr` / `FncCurr` | `InputCurr` / `FncCurr` | hằng USD / `Company.FunctionalCurrency` |
| `InputDr` / `InputCr` | Σ `Amount × AmountFactor` của nhóm, theo vế | Σ `Quantity×UnitPrice` / `ShippingFee+AdditionalCost` / `TaxFee` / `Profit` |
| `XRate` / `RateType` | – | `Exrate` hoặc 1/MUL |
| `AccountedDr` / `AccountedCr` | Σ (Input quy đổi, làm tròn từng event) | – |
| `Description` | – | `JournalLineRule.MemoTemplate` + ` \| N events` |
| `BalanceImpact` | – | vế Debit/Credit do rule quyết định |

### 12.3. Công thức khóa

```
RowHash         = SHA256(46 cột RawOrders sau chuẩn hóa)
TransactionID   = "ORD-" + OrderId + "-" + yyyyMMdd(FulfilledAt)
SourceID        = OrderId + "|" + yyyyMMdd(FulfilledAt)
Period          = yyyyMM(FulfilledAt)
Event key (duy nhất) = ComCode|DataSource|JournalTypeCode|TransactionID|EventSeq
SourceHash      = SHA256({comCode, orderId, postingDate, jtc, ruleSeq, amount, partner, items})
PostingGroupKey = ComCode|JournalTypeCode|yyyyMMdd|InputCurr|FncCurr|UPPER(PartnerCode)|PartnerTaxID|BankAccountNumber
Bulk line key   = PairCode|Debit/Credit|AccountCode|PartnerCode|PartnerTaxID|XRate|RateType
DocNum Bulk     = "ASB-" + yyyyMMdd + "-" + MIN(AccountingEventID trong nhóm)
DocNum Single   = "ASI-" + yyyyMMdd + "-" + AccountingEventID
Exception POST SourceKey = "EventID " + AccountingEventID + " | " + TransactionID
```

### 12.4. Trạng thái

| Bảng.Cột | Giá trị | Nghĩa |
|---|---|---|
| `RawOrders.BuildStatus` | NOT_BUILT | Mới import / đã Unbuild |
| | BUILT | Đã dùng để sinh event (kể cả khi mọi khoản = 0, hoặc seller lỗi) |
| | SKIPPED | Không FULFILLED hoặc thiếu FulfilledAt |
| | ERROR | Không map được ComCode hoặc Company |
| `AccountingEvent.PostStatus` | NEW | Chờ post |
| | ERROR + ErrorStage BUILD | Lỗi lúc build (thiếu seller; hoặc bị chặn vì nghiệp vụ đã POSTED dưới khóa khác). Post **không** lấy |
| | ERROR + ErrorStage POST | Lỗi lúc post (thiếu rule/TK/tỷ giá...). Post lần sau **thử lại** |
| | SKIPPED + ErrorStage POST | Bị bỏ qua lúc post theo cờ Skip |
| | POSTED | Đã vào GLTrans |
| `PostingBatch.Status` | RUNNING / SUCCESS / FAILED / UNPOSTED | UNPOSTED = đã gỡ hết dòng GL của batch |

### 12.5. Exception của luồng Orders

| ExceptionType | Bước | Severity | SourceKey | Khi nào |
|---|---|---|---|---|
| NOT_FULFILLED | BUILD | INFO | ItemCode | Dòng chưa giao |
| MISSING_COMCODE | BUILD | ERROR | ItemCode | Gateway chưa map |
| MISSING_COMPANY | BUILD | ERROR | ItemCode | ComCode không có trong Company |
| MISSING_JOURNAL_TYPE | BUILD | ERROR | JournalTypeCode | Thiếu JournalType ORDERS |
| MISSING_RULE | BUILD / POST | ERROR | JTC / EventID… | Thiếu rule active |
| UNKNOWN_AMOUNT_SOURCE | BUILD | ERROR | `{JTC}\|{RuleSeq}` | AmountSource không phải PRODUCT/SHIPADD/TAX/SELLER_PROFIT/PROFIT |
| AMOUNT_ZERO | BUILD / POST | INFO | `{TxnID}\|{JTC}` / EventID… | Số tiền = 0 |
| MISSING_ACCOUNT | BUILD (WARNING) / POST | WARNING / INFO / ERROR | `{TxnID}\|{JTC}` / EventID… | Tài khoản vai trò bị NULL |
| MISSING_PARTNER | BUILD | ERROR | `{TxnID}\|{JTC}` | Không xác định được seller |
| ACCOUNT_NOT_IN_COA | POST | ERROR | EventID… | TK không có trong CoA |
| NEGATIVE_AMOUNT | POST | ERROR | EventID… | Âm với NegativeMode ERROR |
| MISSING_FX | POST | ERROR | EventID… | Thiếu tỷ giá |
| POSTED_SOURCE_CHANGED | BUILD | WARNING | `{TxnID}\|{JTC}` | Build lại, event đã POSTED mà SourceHash đổi, hoặc không còn được sinh ra (số tiền về 0, rule tắt, gateway mất mapping, đổi ngày giao) |
| POSTED_KEY_CHANGED | BUILD | ERROR | `{TxnID}\|{JTC}` | Build lại, item của event đã POSTED dưới khóa khác (đổi mapping ComCode, đổi RuleSeq, đổi ngày giao) → event mới bị giữ ERROR để không ghi sổ trùng |
| DUPLICATE_ITEM | POST | ERROR | EventID… | Post: item đã/đang chờ ghi sổ ở event khác ngày giao hoặc khác ComCode, hoặc event chưa có ItemCodes → không post, Build lại |

---

## Phần 13 — Từ điển thuật ngữ

### 13.1. Thuật ngữ kế toán

| Thuật ngữ | Tiếng Anh | Trong hệ thống này |
|---|---|---|
| Bút toán kép | Double-entry | Mỗi nghiệp vụ có vế Nợ và vế Có bằng nhau |
| Nợ | Debit (Dr) | Cột `InputDr/AccountedDr`, `BalanceImpact = Debit` |
| Có | Credit (Cr) | Cột `InputCr/AccountedCr`, `BalanceImpact = Credit` |
| Tài khoản kế toán | Account | `AccountCode` trong `CoA` |
| Hệ thống tài khoản | Chart of Accounts | Bảng `CoA` |
| Tài sản | Asset | `AccountType = A` |
| Nợ phải trả | Liability | `AccountType = L` |
| Vốn chủ sở hữu | Equity | `AccountType = E` |
| Doanh thu | Revenue | `AccountType = R` |
| Chi phí | Expense | `AccountType = Exp` |
| Tính chất số dư | Balance side | `CoA.BalanceSide` (Dr/Cr) |
| Phải thu | Accounts Receivable (AR) | `CoA.ARAP = AR` |
| Phải trả | Accounts Payable (AP) | `CoA.ARAP = AP` |
| Người mua trả tiền trước | Customer advance | TK `13122001` |
| Giá vốn | Cost of goods sold (COGS) | TK `632…`; ở đây `63202001` là phần chia cho seller |
| Thuế phải nộp | Tax payable | TK `33302001` |
| Đối tượng công nợ | Partner / Counterparty | `PartnerCode`, `PartnerTaxID` |
| Chứng từ | Voucher / Document | `DocNum` |
| Sổ cái | General Ledger (GL) | Bảng `GLTrans` |
| Ghi sổ / hạch toán | Posting | Bước Post |
| Kỳ kế toán | Accounting period | `Period` = YYYYMM |
| Ngày hạch toán | Posting date / Transaction date | `PostingDate` (event), `TransDate` (GL) = `FulfilledAt` |
| Kế toán dồn tích | Accrual accounting | Ghi khi phát sinh nghĩa vụ (giao hàng), không theo dòng tiền |
| Ghi nhận doanh thu | Revenue recognition | Chỉ khi `ItemStatus = FULFILLED` |
| Tài khoản trung gian | Clearing account | `13122001` nối nguồn thanh toán với nguồn đơn hàng |
| Bảng cân đối phát sinh | Trial balance | Tổng Nợ/Có theo tài khoản (11.2) |
| Nguyên tệ | Transaction / input currency | `InputCurr` |
| Tiền hạch toán | Functional currency | `FncCurr` = `Company.FunctionalCurrency` |
| Tỷ giá | Exchange rate | `XRate`, `RateType` MUL/DIV |
| Đối soát | Reconciliation | So số dư tài khoản giữa các nguồn |
| Bút toán đảo | Reversal | Cột `IsReversal`/`ReverseID` (dự phòng, chưa dùng) |

### 13.2. Thuật ngữ riêng của hệ thống

| Thuật ngữ | Nghĩa |
|---|---|
| DataSource | Nguồn dữ liệu: `ORDERS` (đã làm); PAYPAL, STRIPE, PIPO, AccountingSource (chưa làm) |
| RawOrders | Bảng chứa dòng order sau chuẩn hóa, khóa `ItemCode` |
| ImportBatch / BuildBatch / PostingBatch | Nhật ký một lần Import / Build / Post |
| ExceptionLog | Nhật ký ngoại lệ (dòng bị loại, lỗi mapping, lỗi post...) |
| AccountingEvent | Event nghiệp vụ chuẩn hóa: 1 giao dịch × 1 rule; có tài khoản vai trò, chưa tách Nợ/Có |
| JournalType | Cấu hình header nghiệp vụ: tài khoản theo vai trò, partner rule, Single/Bulk |
| JournalTypeCode (JTC) | Mã nghiệp vụ chuẩn, VD `ORD_REV_PRODUCT_FULFILLED` |
| JournalLineRule | Quy tắc sinh 1 cặp Nợ/Có: vai trò nào bên Nợ/Có, lấy tiền nào, xử lý số âm |
| RuleSeq / EventSeq | Thứ tự rule; event lưu `EventSeq = RuleSeq` để lúc Post join lại |
| Vai trò tài khoản | BANK (tiền) / CONTRA (đối ứng, công nợ) / TRANS (nghiệp vụ: doanh thu, chi phí, thuế) / FEE (phí) |
| PairCode | Tên cặp vai trò: `CONTRA_TRANS`, `BANK_CONTRA`, `FEE_BANK` (không cho biết chiều) |
| AmountSource | Lấy số tiền nào: `PRODUCT`, `SHIPADD`, `TAX`, `SELLER_PROFIT` (Orders); `GROSS`, `FEE`, `NET`, `AMOUNT` (nguồn khác) |
| AmountFactor | Hệ số nhân lúc Post |
| NegativeMode | `SIGNED` giữ dấu · `REVERSE` đảo vế khi âm · `ERROR` chặn khi âm |
| Classify | `Single` (1 event 1 chứng từ, DocNum `ASI-`) · `Bulk` (gom nhiều event, DocNum `ASB-`) |
| PostingGroupKey | Khóa gom Bulk |
| INDIVIDUALS | Partner cố định đại diện khách lẻ, dùng cho doanh thu và thuế |
| Seller | Người bán trên nền tảng; `PartnerCode` = email, `PartnerName` = `FFT-{Store}` / `FFT-FFT {Store}` |
| ComCode | Mã công ty ghi sổ; ở đây = cổng thanh toán (`ZENIROXPAY`) |
| RowHash | Dấu vân tay dòng raw, dùng khi import lại |
| SourceHash | Dấu vân tay dữ liệu nguồn của event, dùng khi build lại sau khi đã post |
| Unpost | Xóa dòng GL của chứng từ, event về `NEW` |
| Unbuild | Xóa event chưa post, raw về `NOT_BUILT` |
| Run cycle | Build Orders rồi Post All trong một lệnh |

---

## Phần 14 — Tự kiểm chứng lại số liệu

### 14.1. Tái tạo trên web

1. Tắt dev server, chạy `npm run db:clear` (xóa dữ liệu giao dịch, giữ master), rồi `npm run dev`.
2. Trang **1. Raw Orders** → kéo thả `data/samples/order-data.csv` → Dashboard **Chạy full cycle**.
3. Trang **4. GLTrans** phải hiện: 6.794 dòng, 3.397 chứng từ, Σ Nợ = Σ Có = 4.013.848,04.
4. Lọc DocNum của đơn `QVAJV-191125-Q1Z3V`, click dòng → Drawer liệt kê các event của chứng từ đó.

### 14.2. Câu SQL soi dữ liệu

```sql
-- Đơn ví dụ: raw → event → GL
SELECT RawOrderID, ItemCode, BuildStatus, UnitPrice, ShippingFee, AdditionalCost, TaxFee, Profit
FROM RawOrders WHERE OrderId = 'QVAJV-191125-Q1Z3V';

SELECT AccountingEventID, JournalTypeCode, Amount, ContraAccount, TransAccount,
       PartnerCode, PostStatus, PostedDocNum
FROM AccountingEvent WHERE OrderID = 'QVAJV-191125-Q1Z3V';

SELECT ID, DocNum, AccountCode, PartnerCode, InputDr, InputCr, Description
FROM GLTrans WHERE DocNum IN (
  SELECT PostedDocNum FROM AccountingEvent WHERE OrderID = 'QVAJV-191125-Q1Z3V');

-- Mỗi chứng từ phải cân (kết quả rỗng là đúng)
SELECT DocNum, round(sum(AccountedDr),2) dr, round(sum(AccountedCr),2) cr
FROM GLTrans GROUP BY DocNum HAVING dr <> cr;

-- Σ Amount event của 1 chứng từ = số tiền dòng GL
SELECT e.PostedDocNum, round(sum(e.Amount),2) event_sum,
       (SELECT InputDr FROM GLTrans g WHERE g.DocNum = e.PostedDocNum AND g.BalanceImpact = 'Debit') gl_dr
FROM AccountingEvent e GROUP BY e.PostedDocNum;

-- Bảng cân đối phát sinh
SELECT AccountCode, round(sum(AccountedDr),2) dr, round(sum(AccountedCr),2) cr
FROM GLTrans GROUP BY AccountCode ORDER BY AccountCode;

-- Vì sao thiếu event? xem exception
SELECT ExceptionType, Severity, count(*) FROM ExceptionLog GROUP BY 1, 2;
```

### 14.3. Test tự động giữ các con số này

- `tests/engine/build-orders.test.ts`: 60/4 dòng, 174 event (60/58/0/56), đơn `MTUBV-181125-51MRR`, seller lỗi, gateway lạ, đơn nhiều item.
- `tests/engine/post.test.ts`: 21 chứng từ / 42 dòng / 6,339.70, số liệu ngày 20/11, Single/REVERSE/SIGNED/ERROR/FX.
- `tests/integration/flow.test.ts`: cả luồng trên DB tạm (import, build lại, post, unpost, unbuild).
- `tests/engine/reconcile-events.test.ts` và `tests/integration/gateway-remap.test.ts`: build lại khi đã có event (đổi mapping/RuleSeq sau khi post không ghi sổ trùng, phạm vi Build theo ComCode).

Chạy: `npm test`.

# Stripe: sao kê thô → RawStripe → AccountingEvent → GLTrans

> Giải thích **một dòng sao kê Stripe biến thành những dòng Nợ/Có nào, và vì sao**. Số liệu trong tài liệu
> do chính code của repo sinh ra trên `data/samples/stripe-sample.csv`.
>
> - Kiến thức kế toán cơ bản (Nợ/Có, loại tài khoản, chứng từ): [`MAPPING_ORDERS_TO_GLTRANS.md` Phần 1](MAPPING_ORDERS_TO_GLTRANS.md#phần-1--kiến-thức-kế-toán-tối-thiểu).
> - Chi tiết kỹ thuật: [`DEVELOPER_GUIDE.md` §6.11](DEVELOPER_GUIDE.md). Yêu cầu gốc: `tai lieu du an.md` §7.6.
> - Hai nguồn cùng engine: [PayPal](MAPPING_PAYPAL_TO_GLTRANS.md) · [PingPong](MAPPING_PIPO_TO_GLTRANS.md).

## Mục lục

- [0. Số liệu lấy từ đâu](#0-số-liệu-lấy-từ-đâu)
- [1. Nguồn Stripe là gì](#1-nguồn-stripe-là-gì)
- [2. Import: file → RawStripe](#2-import-file--rawstripe)
- [3. Master data: JournalType và 3 rule](#3-master-data-journaltype-và-3-rule)
- [4. Build: RawStripe → AccountingEvent](#4-build-rawstripe--accountingevent)
- [5. Post: AccountingEvent → GLTrans](#5-post-accountingevent--gltrans)
- [6. Ví dụ lần theo](#6-ví-dụ-lần-theo)
- [7. Dòng bị loại và lỗi](#7-dòng-bị-loại-và-lỗi)
- [8. Kết quả toàn bộ file mẫu](#8-kết-quả-toàn-bộ-file-mẫu)
- [9. Tra nhanh và tự kiểm chứng](#9-tra-nhanh-và-tự-kiểm-chứng)

---

## 0. Số liệu lấy từ đâu

Chạy đúng code của repo trên một DB SQLite trống, master data lấy từ `data/seed/*.csv`:

```
importSourceFile("stripe", stripe-sample.csv)   →  48 dòng RawStripe
runBuildSource("stripe")                        →  71 AccountingEvent
runPost("All", { dataSource: "STRIPE" })        →  42 chứng từ / 106 dòng GLTrans
```

Số tiền và tài khoản sẽ giống hệt trên máy bạn; các ID tự tăng (và phần số trong `DocNum`) chỉ trùng nếu
làm trên DB trống và import đúng 1 lần.

---

## 1. Nguồn Stripe là gì

`Bank_Stripe` là **balance transaction report** của Stripe: mỗi dòng là một lần số dư Stripe thay đổi.
Đây là nguồn đơn giản nhất trong 3 nguồn PSP — chỉ 7 nghiệp vụ.

```
 File sao kê (sheet Bank_Stripe)
      │  (1) IMPORT  ─ src/lib/services/import-source.ts
      ▼
 ┌──────────────┐   1 dòng file = 1 dòng RawStripe (khóa SourceKey = id)
 │  RawStripe   │
 └──────┬───────┘
        │  (2) BUILD  ─ src/lib/engine/build-bank.ts + sources/stripe.ts
        ▼
 ┌──────────────────┐  1 dòng raw × mỗi JournalLineRule active = 1 event
 │ AccountingEvent  │
 └──────┬───────────┘
        │  (3) POST   ─ src/lib/engine/post.ts
        ▼
 ┌──────────────┐
 │   GLTrans    │   mỗi dòng = 1 vế Nợ hoặc Có
 └──────────────┘
```

### Tài khoản mà Stripe dùng

| Tài khoản | Tên trong CoA | Loại | Ý nghĩa |
|---|---|---|---|
| `11202081` | Stripe - Available (USD) | A | **Tiền dùng được** trong tài khoản Stripe |
| `11202082` | Stripe - Pending/Reserve (USD) | A | Tiền Stripe **đang giữ**, chưa cho rút |
| `13122001` | Người mua trả tiền trước - Global/CA | A | Khách đã trả tiền, chờ giao hàng (nối với nguồn Orders) |
| `11301001` | Rút về Bank - đang chuyển | A | Tiền Stripe payout ra ngoài |
| `33102005` | Phải trả PSP / payment gateway | L | Nợ Stripe các khoản phí |
| `64202014` | Chi phí QLDN - Stripe transaction fee | Exp | Phí theo từng giao dịch |
| `64202015` | Chi phí QLDN - Stripe standalone fee | Exp | Phí Stripe thu riêng (phí tháng, phí Radar…) |

---

## 2. Import: file → RawStripe

**Code:** `src/lib/services/import-source.ts`, `src/lib/sources/normalize.ts`.
**Trên web:** trang **Raw → Stripe**.

File có 30 cột (gồm 15 cột `… (metadata)` của Stripe). Build chỉ dùng 9 cột:

| Cột trong file | Dùng làm gì |
|---|---|
| `id` | `SourceKey` và `TransactionID` |
| `Date` | `PostingDate` (nếu trống thì lấy `Created (UTC)`) |
| `Type` | Loại giao dịch gốc — dùng suy ra JournalType khi cột `JournalType` để trống |
| `Currency` | Bộ lọc: **chỉ USD mới ghi sổ** |
| `Amount` | Số tiền chính (`AmountSource = AMOUNT`) |
| `Fee` | Phí (`AmountSource = FEE`) |
| `JournalType` | **Người dùng điền tay** |
| `ComCode` | Công ty ghi sổ |
| `PartnerCode`, `StoreName` / `storeName (metadata)`, `invoiceId (metadata)`, `Source` | Partner, store, `OrderID`, `RefNum` |

`BankAccoutNumber` trống 100% → mặc định `Stripe1`, tra `MappingBankAccount` ra `11202081`.

### `SourceKey`

```
SourceKey = {id}        VD: txn_3SVBh2K3ZXYJSkRp1IOqhT0v
```

Đơn giản nhất trong 3 nguồn: `id` của Stripe duy nhất tuyệt đối, không cần ghép thêm gì.
`SourceKey` **không chứa cột người dùng điền tay**, nên sửa tay `JournalType` rồi import lại sẽ bị chặn
ở tầng Import (*"Unbuild STRIPE trước khi import lại"*) — cơ chế chống ghi sổ trùng.

### Hai quy ước dễ sập bẫy

- **`Currency` trong file viết thường (`usd`).** Normalizer uppercase trước khi so sánh; nếu không,
  bộ lọc USD sẽ loại **sạch 100% dòng** mà không báo lỗi gì rõ ràng.
- **`Fee` mang dấu dương** (`2.7` nghĩa là Stripe thu 2,70). Ngược PayPal, nên rule phí của Stripe dùng
  `AmountFactor = +1` chứ không phải `−1`.

---

## 3. Master data: JournalType và 3 rule

### 3.1. Bảy `JournalType` của Stripe

| JournalTypeCode | `JournalType` (tên) | Contra | Trans | Fee | Partner | Classify |
|---|---|---|---|---|---|---|
| `STRIPE_RECEIPT_CUSTOMER` | `charge` | `13122001` | – | `64202014` | Fixed = Individuals | Bulk |
| `STRIPE_CHARGE` | Stripe Charge | `13122001` | – | `64202014` | Fixed = Individuals | Bulk |
| `STRIPE_REFUND` | Stripe Refund | `13122001` | – | `64202014` | Fixed = STRIPE | Single |
| `STRIPE_ADJUSTMENT` | Stripe Adjustment | `13122001` | – | `64202014` | Fixed = STRIPE | Single |
| `STRIPE_PAYOUT` | Stripe Payout | `11301001` | – | – | Fixed = STRIPE | Single |
| `STRIPE_FEE` | Stripe Fee | `33102005` | `64202015` | – | Fixed = STRIPE | Bulk |
| `STRIPE_RESERVE` | `reserved_funds` | `11202082` | – | – | Fixed = STRIPE | Bulk |

Cả 7 dòng đều có `BankAccount = 11202081`. Ô "–" nghĩa là để NULL.

> **`STRIPE_CHARGE` và `STRIPE_RECEIPT_CUSTOMER` cấu hình giống hệt nhau.** File mẫu (và dữ liệu thật)
> dùng `STRIPE_RECEIPT_CUSTOMER`; `STRIPE_CHARGE` là dòng master cũ, còn giữ để không vỡ dữ liệu đã ghi.
> Đừng nhầm hai mã này khi tra cứu.

> Cột `JournalType` (tên) của `STRIPE_RECEIPT_CUSTOMER` và `STRIPE_RESERVE` cố ý đặt đúng bằng chuỗi
> `Type` của Stripe (`charge`, `reserved_funds`) — đó chính là cách engine suy ngược khi cột `JournalType`
> trong file bỏ trống, xem [mục 4](#4-build-rawstripe--accountingevent).

### 3.2. Ba rule sinh bút toán

| RuleSeq | PairCode | Bên Nợ | Bên Có | Số tiền | Hệ số | Áp dụng cho |
|---|---|---|---|---|---|---|
| **10** | `BANK_CONTRA` | `BANK_ACCOUNT` | `CONTRA_ACCOUNT` | `AMOUNT` | ×1 | cả 7 nghiệp vụ |
| **20** | `CONTRA_TRANS` | `CONTRA_ACCOUNT` | `TRANS_ACCOUNT` | `AMOUNT` | ×1 | **chỉ `STRIPE_FEE`** |
| **30** | `FEE_BANK` | `FEE_ACCOUNT` | `BANK_ACCOUNT` | `FEE` | **×1** | `RECEIPT_CUSTOMER`, `CHARGE`, `REFUND`, `ADJUSTMENT` |

Tất cả có `NegativeMode = REVERSE` và mọi cờ `SkipIf*` = 1. Hệ quả:

- **Rule 30 bị bỏ khi `Fee = 0`** → INFO `AMOUNT_ZERO`. Trong file mẫu có 9 lượt.
- **`STRIPE_PAYOUT` và `STRIPE_RESERVE` không có rule 30** → 1 dòng file ra đúng 1 bút toán.
- **`STRIPE_FEE` là nghiệp vụ duy nhất có rule 20** → 1 dòng file ra **2 chứng từ**.

> Khác PayPal ở chỗ: PayPal cấu hình đủ 3 rule cho mọi nghiệp vụ rồi để engine bỏ bớt lúc chạy; Stripe
> chỉ khai đúng những rule cần. Nên Stripe sinh ít exception `MISSING_ACCOUNT` hơn hẳn.

---

## 4. Build: RawStripe → AccountingEvent

**Code:** `src/lib/engine/build-bank.ts` + `src/lib/engine/sources/stripe.ts`.
**Trên web:** trang **AccountingEvent** → **Build Stripe**.

| # | Bước | Chi tiết | Hỏng thì sao |
|---|---|---|---|
| 1 | Lọc | `UPPER(Currency)` phải là `USD` | `SKIPPED`, INFO `SOURCE_ROW_SKIPPED` |
| 2 | Công ty | `ComCode` → `Company` → `FncCurr` | ERROR `MISSING_COMCODE` / `MISSING_COMPANY` |
| 3 | Ngày | `PostingDate` = `Date`, fallback `Created (UTC)` | ERROR `INVALID_SOURCE_ROW` |
| 4 | JournalType | **Cột `JournalType` thắng**; trống thì tra `Type` trong `JournalType.JournalType` | ERROR `MISSING_JOURNAL_TYPE` |
| 5 | Tài khoản | dòng nguồn → `MappingBankAccount` (`Stripe1`) → mặc định JournalType | (xem rule skip) |
| 6 | Partner | cả 7 nghiệp vụ đều `Fixed = …` → **cột `PartnerCode` của file bị bỏ qua** | – |
| 7 | Sinh event | mỗi rule active → 1 event, `EventSeq = RuleSeq`, giữ nguyên dấu | INFO `AMOUNT_ZERO` |

### Bước 4 minh họa rõ nhất ở Stripe

Trong 48 dòng file mẫu, **8 dòng `reserved_funds` bỏ trống cột `JournalType`**:

```
Cột JournalType trống
   → engine tra journalTypeByNativeType("STRIPE", Type = "reserved_funds")
   → khớp dòng master có JournalType (tên) = "reserved_funds"
   → JournalTypeCode = STRIPE_RESERVE
```

Kết quả: cả 8 dòng build thành công, **không có exception nào**. 40 dòng còn lại có sẵn cột `JournalType`
nên dùng thẳng giá trị đó.

---

## 5. Post: AccountingEvent → GLTrans

**Code:** `src/lib/engine/post.ts`.

```
1. Lấy rule theo (JournalTypeCode, RuleSeq = EventSeq)
2. TK Nợ / TK Có = 1 trong 4 cột tài khoản của event, theo NormalDr/CrAccountSource
3. amount = Event.Amount × AmountFactor        (Stripe luôn ×1, làm tròn 2 số)
4. Nếu amount < 0 và NegativeMode = REVERSE  →  ĐẢO Nợ/Có, lấy trị tuyệt đối
5. InputCurr = FncCurr = USD  →  XRate = 1, RateType = MUL
6. Dòng Nợ: AccountedDr = amount · Dòng Có: AccountedCr = amount
```

Vì `AmountFactor` luôn bằng 1, **dấu của cột `Amount`/`Fee` trong file quyết định trực tiếp chiều Nợ/Có**:
số dương → tiền vào Stripe (`Nợ 11202081`), số âm → tiền ra (`Có 11202081`).

| | Single | Bulk |
|---|---|---|
| Nghiệp vụ | `REFUND`, `ADJUSTMENT`, `PAYOUT` | `RECEIPT_CUSTOMER`, `CHARGE`, `FEE`, `RESERVE` |
| `DocNum` | `ASI-{yyyyMMdd}-{AccountingEventID}` | `ASB-{yyyyMMdd}-{ID nhỏ nhất trong nhóm}` |
| `Description` | `{MemoTemplate} \| {id}` | `{MemoTemplate} \| {n} events` |

---

## 6. Ví dụ lần theo

Ba dòng, mỗi dòng minh họa một cơ chế khác nhau.

### 6.1. `charge` — khách trả tiền, Stripe thu phí

Dòng thô (19/11/2025, đơn `ZAAIC-191125-E38C3`, store `BSO`):

```
Date=2025-11-19  id=txn_3SVBh2K3ZXYJSkRp1IOqhT0v  Type=charge
Amount=64.98   Fee=2.7   Net=62.28   Currency=usd   JournalType=STRIPE_RECEIPT_CUSTOMER
```

Build sinh 2 event:

| EventSeq | PairCode | AmountSource | Amount | Partner |
|---|---|---|---|---|
| 10 | `BANK_CONTRA` | `AMOUNT` | **64.98** | INDIVIDUALS |
| 30 | `FEE_BANK` | `FEE` | **2.70** | INDIVIDUALS → dòng GL dùng `STRIPE` |

Post (`Bulk`): dòng này rơi vào chứng từ `ASB-20251119-114` cùng **7 dòng charge khác** của ngày
19/11/2025 (16 event tất cả):

```
rule 10:  64.98 × 1 = +64.98  (dương, không đảo)
          Nợ 11202081 (Stripe Available)  /  Có 13122001 (Người mua trả tiền trước)

rule 30:  2.70 × 1 = +2.70   (dương, không đảo)
          Nợ 64202014 (Phí Stripe)        /  Có 11202081 (Stripe Available)
```

Dòng GL thật (đã cộng gộp cả 8 giao dịch trong ngày):

| DocNum | Bên | TK | AccountedDr | AccountedCr | Partner | Description |
|---|---|---|---|---|---|---|
| `ASB-20251119-114` | Debit | `11202081` | 584,84 | 0 | INDIVIDUALS | Stripe Receipt Customer \| BANK_CONTRA \| 16 events |
| `ASB-20251119-114` | Credit | `13122001` | 0 | 584,84 | INDIVIDUALS | Stripe Receipt Customer \| BANK_CONTRA \| 16 events |
| `ASB-20251119-114` | Debit | `64202014` | 24,02 | 0 | STRIPE | Stripe Receipt Customer Fee \| FEE_BANK \| 16 events |
| `ASB-20251119-114` | Credit | `11202081` | 0 | 24,02 | STRIPE | Stripe Receipt Customer Fee \| FEE_BANK \| 16 events |

**Đọc bằng lời:** ngày 19/11 Stripe thu hộ 584,84 của khách và giữ lại 24,02 tiền phí. Riêng giao dịch
ví dụ góp 64,98 và 2,70 vào hai con số đó. Vì là Bulk nên sổ chỉ giữ số tổng — muốn xem từng giao dịch
thì tra bảng `AccountingEvent` theo `PostedDocNum`.

### 6.2. `reserved_funds` — cột JournalType để trống

Hai dòng ngược chiều nhau, cùng ngày, cùng `Source`:

```
id=txn_1TL33SK3ZXYJSkRpudhMpyUN   Amount=-11.23   JournalType=(trống)   Type=reserved_funds
id=txn_1TL33SK3ZXYJSkRpj5JGGxTA   Amount=+11.23   JournalType=(trống)   Type=reserved_funds
```

Cả hai suy ra `STRIPE_RESERVE` từ `Type`. Mỗi dòng 1 event (không có rule 30):

```
dòng âm:   −11.23  →  REVERSE  →  đảo  →  Nợ 11202082 (Pending/Reserve)  /  Có 11202081 (Available)
dòng dương: +11.23  →  không đảo        →  Nợ 11202081 (Available)        /  Có 11202082 (Pending/Reserve)
```

Cả hai cùng `PostingGroupKey` nên **gom chung 1 chứng từ** `ASB-20260411-179`:

| DocNum | Bên | TK | AccountedDr | AccountedCr |
|---|---|---|---|---|
| `ASB-20260411-179` | Debit | `11202082` | 11,23 | 0 |
| `ASB-20260411-179` | Credit | `11202081` | 0 | 11,23 |
| `ASB-20260411-179` | Debit | `11202081` | 11,23 | 0 |
| `ASB-20260411-179` | Credit | `11202082` | 0 | 11,23 |

**Đọc bằng lời:** Stripe giữ tạm 11,23 rồi hẹn nhả ra sau (hai dòng khác nhau ở cột `Available On (UTC)`:
16/04 và 07/06). Sổ ghi cả hai chiều nên số dư ròng bằng 0 — đúng bản chất "tiền chỉ đổi chỗ".

> Bốn dòng trên cùng một chứng từ nhưng **không cộng gộp** với nhau, vì khóa cộng dòng gồm cả `AccountCode`
> và `BalanceImpact`: `Nợ 11202082` và `Có 11202082` là hai dòng khác nhau.

### 6.3. `stripe_fee` — nghiệp vụ duy nhất dùng rule 20

```
Date=2025-12-03  id=txn_1Sa9MkK3ZXYJSkRpBMWZ0RnM  Type=stripe_fee
Amount=-10.69   Fee=0   JournalType=STRIPE_FEE
```

Chú ý: phí đứng ở cột **`Amount`**, không phải cột `Fee`. Đây là phí Stripe thu riêng, không gắn với
giao dịch bán hàng nào. Build sinh 2 event (seq 10 và 20), cả hai `Amount = −10.69`:

```
rule 10:  −10.69  →  REVERSE  →  Nợ 33102005 (Phải trả PSP)   /  Có 11202081 (Stripe Available)
rule 20:  −10.69  →  REVERSE  →  Nợ 64202015 (Chi phí phí Stripe) /  Có 33102005 (Phải trả PSP)
```

| DocNum | Bên | TK | AccountedDr | AccountedCr | Description |
|---|---|---|---|---|---|
| `ASB-20251203-132` | Debit | `33102005` | 10,69 | 0 | Stripe Standalone Fee \| BANK_CONTRA \| 2 events |
| `ASB-20251203-132` | Credit | `11202081` | 0 | 10,69 | Stripe Standalone Fee \| BANK_CONTRA \| 2 events |
| `ASB-20251203-132` | Debit | `64202015` | 10,69 | 0 | Stripe Standalone Fee \| CONTRA_TRANS \| 2 events |
| `ASB-20251203-132` | Credit | `33102005` | 0 | 10,69 | Stripe Standalone Fee \| CONTRA_TRANS \| 2 events |

**Đọc bằng lời:** hai bút toán nối đuôi nhau qua tài khoản trung gian `33102005`. Bút toán 1 nói "Stripe
đã trừ tiền, coi như ta đã trả nợ phí cho Stripe"; bút toán 2 nói "khoản đó là chi phí của kỳ này".
Cộng lại: `Nợ 64202015 / Có 11202081` — tiền ra, chi phí tăng. Tài khoản `33102005` triệt tiêu.

> Trong file mẫu có một dòng `stripe_fee` ngược chiều: `2025-12-14 Amount = +10.69` (Stripe hoàn lại phí),
> ra bút toán đảo hoàn toàn. Đó là lý do bảng cân đối ở [mục 8](#8-kết-quả-toàn-bộ-file-mẫu) thấy
> `64202015` có cả phát sinh Có.

---

## 7. Dòng bị loại và lỗi

File mẫu Stripe rất "sạch": **0 dòng lỗi, 0 dòng bị bỏ**, chỉ 2 dòng exception mức INFO:

```
STRIPE INFO AMOUNT_ZERO [STRIPE_REFUND|30]     STRIPE_REFUND rule 30: FEE = 0 → bỏ qua — 8 dòng
STRIPE INFO AMOUNT_ZERO [STRIPE_ADJUSTMENT|30] STRIPE_ADJUSTMENT rule 30: FEE = 0 → bỏ qua
```

Nghĩa là: 8 dòng `refund` và 1 dòng `adjustment` không có phí nên rule 30 tự bỏ. Đây là **hành vi đúng**,
không phải lỗi.

Các lỗi có thể gặp với file Stripe khác:

| ExceptionType | Severity | Khi nào | Xử lý |
|---|---|---|---|
| `SOURCE_ROW_SKIPPED` | INFO | `Currency` không phải USD | Bình thường — Stripe đa tiền tệ thì chỉ ghi sổ USD |
| `MISSING_JOURNAL_TYPE` | ERROR | Cột `JournalType` sai mã, **và** `Type` không khớp tên JournalType nào | Sửa cột `JournalType` trong file, hoặc thêm dòng master |
| `MISSING_COMCODE` / `MISSING_COMPANY` | ERROR | Cột `ComCode` trống hoặc chưa có trong `Company` | Điền `ComCode`, hoặc thêm công ty |
| `MISSING_FX` | ERROR (ở Post) | Công ty ghi sổ không dùng USD và thiếu tỷ giá kỳ đó | Thêm dòng `Exrate`. Với `ZENIROXPAY` (USD) không bao giờ gặp |

> **Bẫy im lặng cần biết:** nếu normalizer không uppercase `Currency`, toàn bộ file (`usd` chữ thường) sẽ
> bị `SOURCE_ROW_SKIPPED` — import báo `SUCCESS`, build báo `SUCCESS`, nhưng **0 event**. Gặp tình huống
> "build xong không có gì" thì kiểm tra cột `Currency` đầu tiên.

---

## 8. Kết quả toàn bộ file mẫu

```
48 dòng file ─► 48 RawStripe ─► 48 dòng hợp lệ ─► 71 event ─► 42 chứng từ ─► 106 dòng GL
```

| Bước | Số liệu |
|---|---|
| Import | 48 dòng, 0 lỗi, `Status = SUCCESS` |
| Build | 48 dòng nguồn · 0 `ErrorRows` · 0 `SkippedRows` · **71 event** · 9 lượt rule bị bỏ vì `Fee = 0` |
| Post Single | 31 event → 31 chứng từ → 62 dòng GL |
| Post Bulk | 40 event → 11 chứng từ → 44 dòng GL |
| **Tổng GL** | **106 dòng · 42 chứng từ · Σ Nợ = Σ Có = 34.634,22 USD** |

Số event theo nghiệp vụ:

| JournalTypeCode | Số dòng file | Rule chạy | Event |
|---|---|---|---|
| `STRIPE_RECEIPT_CUSTOMER` | 8 | 10 + 30 | 16 |
| `STRIPE_FEE` | 8 | 10 + 20 | 16 |
| `STRIPE_ADJUSTMENT` | 8 | 10 + 30 (1 dòng `Fee = 0`) | 15 |
| `STRIPE_REFUND` | 8 | 10 (mọi dòng `Fee = 0`) | 8 |
| `STRIPE_PAYOUT` | 8 | 10 | 8 |
| `STRIPE_RESERVE` | 8 | 10 | 8 |
| | **48** | | **71** |

### Bảng cân đối theo tài khoản

| Tài khoản | Tên | Phát sinh Nợ | Phát sinh Có | Số dòng |
|---|---|---|---|---|
| `11202081` | Stripe - Available | 879,86 | 33.667,73 | 47 |
| `11202082` | Stripe - Pending/Reserve | 219,35 | 219,35 | 8 |
| `11301001` | Rút về Bank - đang chuyển | 32.700,00 | 0 | 8 |
| `13122001` | Người mua trả tiền trước | 543,42 | 649,82 | 17 |
| `33102005` | Phải trả PSP | 86,63 | 86,63 | 12 |
| `64202014` | Chi phí Stripe transaction fee | 129,02 | 0 | 8 |
| `64202015` | Chi phí Stripe standalone fee | 75,94 | 10,69 | 6 |
| | **Tổng** | **34.634,22** | **34.634,22** | **106** |

Đọc bảng bằng lời:

- `11202081` phát sinh Có áp đảo vì kỳ mẫu chủ yếu là **payout rút tiền ra** (32.700 trên tổng 33.667,73).
- `11202082` Nợ đúng bằng Có → mọi khoản Stripe giữ tạm trong file mẫu đều đã có dòng nhả tương ứng.
- `13122001` Có (649,82) lớn hơn Nợ (543,42): tiền khách trả vào nhiều hơn tiền hoàn/điều chỉnh trả ra.
- `33102005` Nợ = Có → tài khoản trung gian của phí `STRIPE_FEE` triệt tiêu hoàn toàn, đúng như
  [ví dụ 6.3](#63-stripe_fee--nghiệp-vụ-duy-nhất-dùng-rule-20).

---

## 9. Tra nhanh và tự kiểm chứng

### 9.1. Các công thức khóa

```
SourceKey       = {id}
SourceID        = STRIPE|{SourceKey}
TransactionID   = {id}
EventSeq        = RuleSeq  (10 | 20 | 30)
Period          = YYYYMM của PostingDate
DocNum Single   = ASI-{yyyyMMdd}-{AccountingEventID}
DocNum Bulk     = ASB-{yyyyMMdd}-{AccountingEventID nhỏ nhất trong nhóm}
PostingGroupKey = ComCode|JournalTypeCode|yyyyMMdd|InputCurr|FncCurr|UPPER(PartnerCode)|PartnerTaxID|BankAccountNumber
Amount (event)  = AMOUNT hoặc FEE, giữ nguyên dấu
Amount (GL)     = |Event.Amount × 1|, chiều Nợ/Có do dấu quyết định (NegativeMode = REVERSE)
```

### 9.2. Cột GLTrans đến từ đâu

| Cột GLTrans | Nguồn |
|---|---|
| `AccountCode` | 1 trong 4 cột tài khoản của event, chọn theo `NormalDr/CrAccountSource` của rule |
| `BalanceImpact` | `Debit` / `Credit`, đảo lại nếu `Amount < 0` |
| `InputDr/Cr`, `AccountedDr/Cr` | `Event.Amount` (Stripe `AmountFactor` = 1) |
| `XRate`, `RateType` | `1` / `MUL` (USD → USD) |
| `PartnerCode` | partner của event, hoặc `STRIPE` nếu rule ghi `PartnerMode = FIXED` |
| `Description` | `rule.MemoTemplate` + ` \| ` + `id` (Single) hoặc ` \| {n} events` (Bulk) |
| `ReferenceTxnID` | `id` (Single) / `null` (Bulk) |
| `OrderID` | `invoiceId (metadata)` |
| `RefNum` | `Source`, fallback `invoiceId (metadata)` |
| `BankAccountNumber` | `Stripe1` |

### 9.3. Câu SQL soi dữ liệu

```sql
-- Chứng từ nào không cân? (kết quả rỗng là đúng)
SELECT DocNum, ROUND(SUM(AccountedDr),2) dr, ROUND(SUM(AccountedCr),2) cr
FROM GLTrans WHERE DataSource='STRIPE'
GROUP BY DocNum HAVING dr <> cr;

-- Một chứng từ Bulk gom những giao dịch nào?
SELECT TransactionID, EventSeq, Amount FROM AccountingEvent
WHERE PostedDocNum = 'ASB-20251119-114' ORDER BY TransactionID, EventSeq;

-- Các dòng suy JournalType từ cột Type (cột JournalType trong file bỏ trống)
SELECT Id, Type, JournalType, BuildStatus FROM RawStripe WHERE JournalType IS NULL;
```

### 9.4. Test nào canh các con số này

| Số liệu | Test |
|---|---|
| 48 dòng import, 71 event, Dr = Cr | `tests/integration/bank-sources.test.ts` |
| Mọi dòng sau normalize có `Currency = "USD"` (chứng minh việc uppercase) | `tests/engine/build-bank.test.ts` |
| `STRIPE_RECEIPT_CUSTOMER` dùng `11202081` / `Stripe1` / partner `INDIVIDUALS`, event seq 30 `Amount > 0` | `tests/engine/build-bank.test.ts` |
| `reserved_funds` bỏ trống JournalType → `STRIPE_RESERVE` + Contra `11202082`, **không** có `MISSING_JOURNAL_TYPE` | `tests/engine/build-bank.test.ts` |

Chạy: `npm test`.

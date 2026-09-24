# PayPal: sao kê thô → RawPaypal → AccountingEvent → GLTrans

> Giải thích **một dòng sao kê PayPal biến thành những dòng Nợ/Có nào, và vì sao**. Số liệu trong tài liệu
> do chính code của repo sinh ra trên `paypal-sample.csv` — bản trích 81 dòng của file thật, **đã gỡ khỏi repo**. Cách ánh xạ dưới đây không đổi; tổng số hiện tại của cả file xem `docs/DEVELOPER_GUIDE.md` §10.2.
>
> - Kiến thức kế toán cơ bản (Nợ/Có, loại tài khoản, chứng từ): [`MAPPING_ORDERS_TO_GLTRANS.md` Phần 1](MAPPING_ORDERS_TO_GLTRANS.md#phần-1--kiến-thức-kế-toán-tối-thiểu).
> - Chi tiết kỹ thuật: [`DEVELOPER_GUIDE.md` §6.11](DEVELOPER_GUIDE.md). Yêu cầu gốc: `tai lieu du an.md` §7.4.
> - Hai nguồn cùng engine: [Stripe](MAPPING_STRIPE_TO_GLTRANS.md) · [PingPong](MAPPING_PIPO_TO_GLTRANS.md).

## Mục lục

- [0. Số liệu lấy từ đâu](#0-số-liệu-lấy-từ-đâu)
- [1. Nguồn PayPal là gì](#1-nguồn-paypal-là-gì)
- [2. Import: file → RawPaypal](#2-import-file--rawpaypal)
- [3. Master data: JournalType và 3 rule](#3-master-data-journaltype-và-3-rule)
- [4. Build: RawPaypal → AccountingEvent](#4-build-rawpaypal--accountingevent)
- [5. Post: AccountingEvent → GLTrans](#5-post-accountingevent--gltrans)
- [6. Ví dụ lần theo: vòng đời một đơn hàng](#6-ví-dụ-lần-theo-vòng-đời-một-đơn-hàng)
- [7. Dòng bị loại và lỗi](#7-dòng-bị-loại-và-lỗi)
- [8. Kết quả toàn bộ file mẫu](#8-kết-quả-toàn-bộ-file-mẫu)
- [9. Tra nhanh và tự kiểm chứng](#9-tra-nhanh-và-tự-kiểm-chứng)

---

## 0. Số liệu lấy từ đâu

Chạy đúng code của repo trên một DB SQLite trống, master data lấy từ `data/seed/*.csv`:

```
importSourceFile("paypal", paypal-sample.csv)   →  81 dòng RawPaypal
runBuildSource("paypal")                        →  113 AccountingEvent
runPost("All", { dataSource: "PAYPAL" })        →  87 chứng từ / 190 dòng GLTrans
```

Trên máy bạn, **số tiền và tài khoản sẽ giống hệt**, nhưng các ID tự tăng (`RawPaypalID`,
`AccountingEventID`, và do đó cả phần số trong `DocNum`) chỉ trùng nếu làm trên DB trống và import đúng
1 lần. Các cột thời điểm (`AddDate`, `PostedAt`) là giờ lúc chạy.

---

## 1. Nguồn PayPal là gì

`Bank_Paypal` là **sao kê ví PayPal**: mỗi dòng là một lần tiền vào hoặc ra khỏi ví. Khác nguồn Orders
(nói về *hàng đã giao*), PayPal nói về *tiền đã chuyển động*.

```
 File sao kê (.csv/.xlsx, sheet Bank_Paypal)
      │  (1) IMPORT  ─ src/lib/services/import-source.ts
      ▼
 ┌──────────────┐   1 dòng file = 1 dòng RawPaypal (khóa SourceKey)
 │  RawPaypal   │
 └──────┬───────┘
        │  (2) BUILD  ─ src/lib/engine/build-bank.ts + sources/paypal.ts
        ▼
 ┌──────────────────┐  1 dòng raw × mỗi JournalLineRule active = 1 event
 │ AccountingEvent  │  (đã có số tiền + 4 tài khoản theo vai trò; CHƯA chia Nợ/Có)
 └──────┬───────────┘
        │  (3) POST   ─ src/lib/engine/post.ts
        ▼
 ┌──────────────┐   mỗi dòng = 1 vế Nợ hoặc Có; các dòng cùng DocNum luôn cân
 │   GLTrans    │
 └──────────────┘
```

| Từ | Sang | Quan hệ |
|---|---|---|
| Dòng file | RawPaypal | 1 → 1, khóa `SourceKey` |
| RawPaypal | AccountingEvent | 1 → **0…3** (mỗi rule active sinh 1 event, rule nào không đủ điều kiện thì bỏ) |
| AccountingEvent | Chứng từ | Single: 1 event = 1 chứng từ · Bulk: nhiều event cùng `PostingGroupKey` = 1 chứng từ |
| Chứng từ | Dòng GLTrans | 1 → 2 (hoặc nhiều hơn khi Bulk gom nhiều cặp) |

### Tài khoản mà PayPal dùng

| Tài khoản | Tên trong CoA | Loại | Ý nghĩa |
|---|---|---|---|
| `11202051` | PayPal - Available (USD) | A | **Tiền dùng được** trong ví PayPal |
| `11202052` | PayPal - Held/Reserve/Review (USD) | A | Tiền **bị PayPal giữ lại**, chưa rút được |
| `13122001` | Người mua trả tiền trước - Global/CA | A | Khách đã trả tiền, chờ giao hàng (nối với nguồn Orders) |
| `11301001` | Rút PayPal về Bank VN - đang chuyển | A | Tiền đang trên đường rút ra ngoài |
| `33102002` | Phải trả Supplier - COGS/fulfillment | L | Nợ nhà cung cấp (dùng cho Mass Pay) |
| `33102005` | Phải trả PSP / payment gateway | L | Nợ PayPal các khoản phí |
| `64202010` | Chi phí QLDN - Payment gateway / transaction fees | Exp | Phí giao dịch |
| `64202011` / `64202012` / `64202013` | Chi phí Dispute / Chargeback / Partner fees | Exp | Các loại phí riêng |

Nhắc lại quy tắc: **Tài sản (A) và Chi phí (Exp) tăng thì ghi Nợ. Nợ phải trả (L) và Doanh thu (R) tăng
thì ghi Có.** Vậy tiền vào ví PayPal = `Nợ 11202051`, tiền ra khỏi ví = `Có 11202051`.

---

## 2. Import: file → RawPaypal

**Code:** `src/lib/services/import-source.ts`, `src/lib/sources/normalize.ts`, `src/lib/sources/columns.ts`.
**Trên web:** trang **Raw → PayPal** → kéo file vào.

File có 23 cột. Build chỉ dùng 11 cột sau; 12 cột còn lại được lưu để tra cứu và tham gia `RowHash`:

| Cột trong file | Dùng làm gì |
|---|---|
| `Transaction ID` + `Date` + `Time` | Ghép thành `SourceKey`. `Date` còn là `PostingDate` |
| `Description` | Loại giao dịch gốc — dùng suy ra JournalType khi cột `JournalType` để trống |
| `Currency` | Bộ lọc: **chỉ USD mới ghi sổ** |
| `Gross` | Số tiền chính (`AmountSource = GROSS`) |
| `Fee` | Phí (`AmountSource = FEE`) |
| `JournalType` | **Người dùng điền tay** — quyết định nghiệp vụ |
| `ComCode` | Công ty ghi sổ |
| `PartnerCode` + `StoreName` | Đối tượng, dùng khi JournalType ghi `From Source` |
| `Invoice ID` | → `OrderID` trên event |
| `Reference Txn ID` | → `RefNum` (mã giao dịch gốc mà dòng này tham chiếu tới) |
| `BankAccoutNumber` | Số tài khoản nguồn. **Trống 100% trong file** → mặc định `PAYPAL1` |

### `SourceKey` — khóa định danh dòng

```
SourceKey = {Transaction ID}|{Date}|{Time}      VD: 06L351017M6526445|2025-11-17|05:30:35
```

Vì sao phải ghép cả ngày giờ? Trên workbook thật 142.659 dòng, **`Transaction ID` đơn lẻ có 37 mã bị
trùng** (kiểu Hold → Cancel Hold dùng chung mã). Bộ ba thì duy nhất tuyệt đối.

> **Quy tắc bắt buộc:** `SourceKey` **không được chứa cột người dùng điền tay** (`JournalType`,
> `PartnerCode`, `StoreName`). Nhờ vậy khi ai đó sửa tay cột `JournalType` rồi import lại, `RowHash` đổi
> nhưng `SourceKey` giữ nguyên → hệ thống nhận ra đúng dòng cũ và **chặn lại** nếu dòng đó đã build/post
> (báo *"Unbuild PAYPAL trước khi import lại"*). Đây là cơ chế chống ghi sổ trùng của nguồn này.

### Quy ước dấu của PayPal

- `Gross` mang dấu thật: tiền vào là **dương**, tiền ra là **âm**.
- `Fee` mang dấu **âm** khi PayPal thu phí (`-1.87`), **dương** khi PayPal trả lại phí (`+1.87`).
  Dấu ngược với Stripe — xử lý bằng `AmountFactor = -1`, xem [mục 3](#3-master-data-journaltype-và-3-rule).

---

## 3. Master data: JournalType và 3 rule

### 3.1. `JournalType` — mỗi nghiệp vụ dùng tài khoản nào cho từng vai trò

Tra bằng `DataSource = PAYPAL` + `JournalTypeCode`. 32 nghiệp vụ:

| JournalTypeCode | Nghiệp vụ (`Description` trong file) | Contra | Trans | Partner | Classify |
|---|---|---|---|---|---|
| `PP_EXPRESS_CHECKOUT_PAYMENT` | Express Checkout Payment | `13122001` | – | Fixed = Individuals | Bulk |
| `PP_DIRECT_CREDIT_CARD_PAYMENT` | Direct Credit Card Payment | `13122001` | – | Fixed = Individuals | Bulk |
| `PP_GENERAL_PAYMENT` | General Payment | `13122001` | `51131001` | From Source | Single |
| `PP_MOBILE_PAYMENT` | Mobile Payment | `13122001` | `51131001` | From Source | Single |
| `PP_PAYMENT_REFUND` | Payment Refund | `13122001` | – | Fixed = PAYPAL | Single |
| `PP_PAYMENT_REVERSAL` | Payment Reversal | `13122001` | – | From Source | Single |
| `PP_CHARGEBACK` | Chargeback | `13122001` | – | Fixed = PAYPAL | Single |
| `PP_CHARGEBACK_REVERSAL` | Chargeback Reversal | `13122001` | – | Fixed = PAYPAL | Single |
| `PP_IPR_REVERSAL` | Instant Payment Review (IPR) reversal | `13122001` | – | Fixed = PAYPAL | Single |
| `PP_CHARGEBACK_FEE` | Chargeback Fee | `33102005` | `64202012` | Fixed = PAYPAL | Single |
| `PP_DISPUTE_FEE` | Dispute Fee | `33102005` | `64202011` | Fixed = PAYPAL | Single |
| `PP_PARTNER_FEE` | Partner Fee | `33102005` | `64202013` | Fixed = PayPal | Bulk |
| `PP_PAYMENT_FEE` | Payment Fee | `33102005` | `64202010` | Fixed = PAYPAL | Bulk |
| `PP_FEE_REVERSAL` | Fee Reversal | `33102005` | `64202010` | Fixed = PAYPAL | Bulk |
| `PP_RESERVE_HOLD` | Reserve Hold | `11202052` | – | Fixed = Reserve Hold | Bulk |
| `PP_RESERVE_RELEASE` | Reserve Release | `11202052` | – | Fixed = Reserve Hold | Bulk |
| `PP_GENERAL_HOLD` | General Hold | `11202052` | – | Fixed = General Hold | Bulk |
| `PP_GENERAL_HOLD_RELEASE` | General Hold Release | `11202052` | – | Fixed = General Hold | Bulk |
| `PP_HOLD_AVAILABLE_BALANCE` | Hold on Available Balance | `11202052` | – | Fixed = General Account Hold | Single |
| `PP_REVERSAL_GENERAL_ACCOUNT_HOLD` | Reversal of General Account Hold | `11202052` | – | Fixed = General Account Hold | Single |
| `PP_HOLD_DISPUTE_INVESTIGATION` | Hold on Balance for Dispute Investigation | `11202052` | – | Fixed = Hold for Dispute | Single |
| `PP_CANCEL_HOLD_DISPUTE_RESOLUTION` | Cancellation of Hold for Dispute Resolution | **(trống!)** | – | Fixed = Hold for Dispute | Single |
| `PP_PAYMENT_REVIEW_HOLD` | Payment Review Hold | `11202052` | – | Fixed = Payment Review Hold | Single |
| `PP_PAYMENT_REVIEW_RELEASE` | Payment Review Release | `11202052` | – | Fixed = Payment Review Hold | Single |
| `PP_TAX_HOLD` | Tax Hold | `33302001` | – | Fixed = Tax | Bulk |
| `PP_TAX_RELEASE` | Tax Release | `33302001` | – | Fixed = Tax | Bulk |
| `PP_MASS_PAY_PAYMENT` | Mass Pay Payment | `33102002` | – | From Source | Single |
| `PP_GENERAL_ACCOUNT_CORRECTION` | General Account Correction | `33102002` | `71100001` | Fixed = PAYPAL | Single |
| `PP_GENERAL_BONUS` | General Bonus | `13889001` | `71100001` | Fixed = PAYPAL | Single |
| `PP_PROTECTION_BONUS_PAYOUT` | PayPal Protection Bonus… | `13889001` | `71100001` | Fixed = PAYPAL | Single |
| `PP_USER_INITIATED_WITHDRAWAL` | User Initiated Withdrawal | `11301001` | – | Fixed = PAYPAL | Single |
| `PP_USER_INITIATED_CURRENCY_CONVERSION` | User Initiated Currency Conversion | `63500001` | – | Fixed = PAYPAL | Single |

Cả 32 dòng đều có `BankAccount = 11202051` và `FeeAccount = 64202010`.
Ô "–" nghĩa là `TransAccount` để NULL → **rule 20 sẽ bị bỏ qua**, xem ngay dưới.
Dòng `PP_CANCEL_HOLD_DISPUTE_RESOLUTION` thiếu `ContraAccount` là **lỗi dữ liệu master**, xem [mục 7](#7-dòng-bị-loại-và-lỗi).

### 3.2. Ba rule sinh bút toán

Mọi nghiệp vụ PayPal dùng chung một bộ 3 `JournalLineRule` (`data/seed/journal-line-rule.csv`):

| RuleSeq | PairCode | Bên Nợ | Bên Có | Số tiền | Hệ số | Partner |
|---|---|---|---|---|---|---|
| **10** | `BANK_CONTRA` | `BANK_ACCOUNT` | `CONTRA_ACCOUNT` | `GROSS` | ×1 | của event |
| **20** | `CONTRA_TRANS` | `CONTRA_ACCOUNT` | `TRANS_ACCOUNT` | `GROSS` | ×1 | của event |
| **30** | `FEE_BANK` | `FEE_ACCOUNT` | `BANK_ACCOUNT` | `FEE` | **×(−1)** | cố định `PAYPAL` |

Cả 3 đều có `NegativeMode = REVERSE` và mọi cờ `SkipIf*` = 1. Ba hệ quả phải nhớ:

1. **Rule 20 bị bỏ khi `TransAccount` NULL.** Đa số nghiệp vụ PayPal rơi vào đây → INFO `MISSING_ACCOUNT`.
   (Trên workbook thật riêng trường hợp này đã ~86.000 dòng — lý do exception phải gom nhóm.)
2. **Rule 30 bị bỏ khi `Fee = 0`** → INFO `AMOUNT_ZERO`. Trong file mẫu, 59 lượt rule bị bỏ vì số tiền = 0.
3. **`AmountFactor = −1` ở rule 30** kéo `Fee` âm của PayPal về dương, để chi phí ghi Nợ đúng chiều.

> **"Contra" và "Trans" là *vai trò*, không phải bên Nợ hay bên Có.** Chiều ghi do cột
> `NormalDrAccountSource` / `NormalCrAccountSource` của rule quyết định, và có thể bị `NegativeMode`
> đảo ngược khi số tiền âm.

---

## 4. Build: RawPaypal → AccountingEvent

**Code:** `src/lib/engine/build-bank.ts` (`buildBankEvents`) + `src/lib/engine/sources/paypal.ts`.
**Trên web:** trang **AccountingEvent** → **Build PayPal**.

Với mỗi dòng raw, engine làm 7 bước:

| # | Bước | Chi tiết | Hỏng thì sao |
|---|---|---|---|
| 1 | Lọc | `Currency` (trim, UPPER) phải là `USD` | dòng → `SKIPPED`, INFO `SOURCE_ROW_SKIPPED` |
| 2 | Công ty | `ComCode` → `Company` → `FncCurr` | ERROR `MISSING_COMCODE` / `MISSING_COMPANY` |
| 3 | Ngày | `PostingDate` = cột `Date`; `Period` = `YYYYMM` | ERROR `INVALID_SOURCE_ROW` |
| 4 | JournalType | **Cột `JournalType` điền tay thắng.** Trống thì tra `Description` trong `JournalType.JournalType` | ERROR `MISSING_JOURNAL_TYPE` |
| 5 | Tài khoản | dòng nguồn → `MappingBankAccount` → mặc định của JournalType | (xem rule skip) |
| 6 | Partner | `Fixed = X` → dùng X. `From Source` → tra `PartnerCode` trong `Partners` | WARNING `MISSING_PARTNER`, **vẫn ghi sổ** |
| 7 | Sinh event | mỗi rule active → 1 event, `EventSeq = RuleSeq` | INFO `AMOUNT_ZERO` / `MISSING_ACCOUNT` |

Hai điểm hay nhầm:

- **Bước 4 — cột điền tay thắng.** Trong file mẫu có 2 dòng `Mass Pay Payment` bỏ trống cột `JournalType`;
  engine suy ngược từ `Description` và vẫn ra `PP_MASS_PAY_PAYMENT`. Làm được vì trong file PayPal,
  `Description` ↔ `JournalType` là quan hệ **1:1 tuyệt đối** (22 loại).
- **Bước 5 — tài khoản ngân hàng.** Cột `BankAccoutNumber` trống nên mọi dòng dùng `PAYPAL1`, tra
  `MappingBankAccount` (ComCode + số tài khoản) ra `11202051`.
- **Bước 7 — giữ nguyên dấu.** `Amount` trên event là số tiền gốc, **chưa nhân `AmountFactor`**. Phép nhân
  và việc quyết định Nợ/Có nằm ở bước Post.

---

## 5. Post: AccountingEvent → GLTrans

**Code:** `src/lib/engine/post.ts`. **Trên web:** trang **GL Trans** → **Post**.

Mỗi event → đúng 2 dòng GL, theo thứ tự:

```
1. Lấy rule theo (JournalTypeCode, RuleSeq = EventSeq)
2. TK Nợ = accountFromSource(NormalDrAccountSource)   ← đọc 4 cột tài khoản trên event
   TK Có = accountFromSource(NormalCrAccountSource)
3. amount = Event.Amount × AmountFactor         (làm tròn 2 số, ROUND_HALF_UP)
4. Nếu amount < 0 và NegativeMode = REVERSE  →  ĐẢO Nợ/Có, lấy trị tuyệt đối
5. Tỷ giá: InputCurr = FncCurr = USD  →  XRate = 1, RateType = MUL
6. Dòng Nợ: InputDr/AccountedDr = amount, BalanceImpact = "Debit"
   Dòng Có: InputCr/AccountedCr = amount, BalanceImpact = "Credit"
```

**Bước 4 là chìa khóa đọc hiểu sổ PayPal.** Vì `NegativeMode = REVERSE`, mọi dòng GL của PayPal đều mang
số dương; chiều tiền nằm ở chỗ tài khoản nào đứng bên Nợ.

### Single hay Bulk

| | Single | Bulk |
|---|---|---|
| Gom | 1 event = 1 chứng từ | Các event cùng `PostingGroupKey` |
| `DocNum` | `ASI-{yyyyMMdd}-{AccountingEventID}` | `ASB-{yyyyMMdd}-{ID nhỏ nhất trong nhóm}` |
| `ReferenceTxnID` | mã giao dịch gốc | `null` |
| `Description` | `{MemoTemplate} \| {TransactionID}` | `{MemoTemplate} \| {n} events` |

```
PostingGroupKey = ComCode|JournalTypeCode|yyyyMMdd|InputCurr|FncCurr|UPPER(PartnerCode)|PartnerTaxID|BankAccountNumber
VD: ZENIROXPAY|PP_EXPRESS_CHECKOUT_PAYMENT|20251117|USD|USD|INDIVIDUALS|INDIVIDUALS|PAYPAL1
```

---

## 6. Ví dụ lần theo: vòng đời một đơn hàng

Bốn dòng liên tiếp trong file mẫu, cùng `Invoice ID = G2A22-171125-1IM2M`, ngày 17/11/2025: khách trả
tiền → PayPal giữ lại một phần → khách đòi hoàn tiền → PayPal nhả phần giữ. Cột `Balance` của file chạy
`43.01 → 34.84 → −8.17 → 0`.

### 6.1. Bốn dòng thô

| # | Description | JournalType | Gross | Fee | PartnerCode trong file |
|---|---|---|---|---|---|
| 1 | Express Checkout Payment | `PP_EXPRESS_CHECKOUT_PAYMENT` | **44.88** | **−1.87** | lyndylutz@gmail.com |
| 2 | Reserve Hold | `PP_RESERVE_HOLD` | **−8.17** | 0 | (trống) |
| 3 | Payment Refund | `PP_PAYMENT_REFUND` | **−44.88** | **+1.87** | lyndylutz@gmail.com |
| 4 | Reserve Release | `PP_RESERVE_RELEASE` | **8.17** | 0 | (trống) |

> Chú ý dòng 1 và 3: file có ghi `PartnerCode`, nhưng `JournalType` của hai nghiệp vụ này là
> `Fixed = Individuals` và `Fixed = PAYPAL`, nên **cột `PartnerCode` bị bỏ qua**. Chỉ nghiệp vụ ghi
> `From Source` mới đọc cột đó.

### 6.2. Dòng 1 — khách trả tiền 44.88, PayPal thu phí 1.87

Build sinh 2 event (rule 20 bị bỏ vì `TransAccount` NULL):

| EventSeq | PairCode | AmountSource | Amount | Partner |
|---|---|---|---|---|
| 10 | `BANK_CONTRA` | `GROSS` | 44.88 | INDIVIDUALS |
| 30 | `FEE_BANK` | `FEE` | **−1.87** | INDIVIDUALS → dòng GL dùng `PAYPAL` (rule `PartnerMode = FIXED`) |

Post, `Classify = Bulk` → chứng từ `ASB-20251117-1`:

```
rule 10:  amount = 44.88 × 1 = +44.88  (dương, không đảo)
          Nợ 11202051 (PayPal Available)   44.88
              Có 13122001 (Người mua trả tiền trước)  44.88

rule 30:  amount = (−1.87) × (−1) = +1.87  (đã thành dương, không đảo)
          Nợ 64202010 (Chi phí phí giao dịch)  1.87
              Có 11202051 (PayPal Available)   1.87
```

Dòng GL thật:

| DocNum | Bên | TK | AccountedDr | AccountedCr | Partner | Description |
|---|---|---|---|---|---|---|
| `ASB-20251117-1` | Debit | `11202051` | 44.88 | 0 | INDIVIDUALS | Pair 1: Bank vs Contra from Gross \| 2 events |
| `ASB-20251117-1` | Credit | `13122001` | 0 | 44.88 | INDIVIDUALS | Pair 1: Bank vs Contra from Gross \| 2 events |
| `ASB-20251117-1` | Debit | `64202010` | 1.87 | 0 | PAYPAL | Pair 3: Fee vs Bank from Fee \| 2 events |
| `ASB-20251117-1` | Credit | `11202051` | 0 | 1.87 | PAYPAL | Pair 3: Fee vs Bank from Fee \| 2 events |

**Đọc bằng lời:** ví PayPal nhận 44.88 của khách (ghi nhận là khoản khách ứng trước, chưa phải doanh thu),
rồi PayPal trừ 1.87 tiền phí. Còn lại 43.01 đúng bằng cột `Net`.

### 6.3. Dòng 2 — PayPal giữ lại 8.17

Chỉ 1 event (Fee = 0 nên rule 30 bị bỏ). `Amount = −8.17` → **âm** → `REVERSE` đảo Nợ/Có:

```
rule 10:  amount = −8.17  →  REVERSE  →  đảo hai vế, lấy |−8.17| = 8.17
          Nợ 11202052 (PayPal Held/Reserve)   8.17
              Có 11202051 (PayPal Available)  8.17
```

| DocNum | Bên | TK | AccountedDr | AccountedCr | Partner |
|---|---|---|---|---|---|
| `ASB-20251117-3` | Debit | `11202052` | 8.17 | 0 | RESERVE HOLD |
| `ASB-20251117-3` | Credit | `11202051` | 0 | 8.17 | RESERVE HOLD |

**Đọc bằng lời:** tiền không ra khỏi PayPal, chỉ chuyển từ "dùng được" sang "bị giữ". Tổng tài sản không đổi.

### 6.4. Dòng 3 — hoàn tiền cho khách, PayPal trả lại phí

`Classify = Single` → mỗi event một chứng từ riêng:

```
rule 10:  amount = −44.88  →  REVERSE  →  đảo
          Nợ 13122001   44.88   /   Có 11202051   44.88          → ASI-20251117-4

rule 30:  amount = (+1.87) × (−1) = −1.87  →  REVERSE  →  đảo
          Nợ 11202051   1.87    /   Có 64202010   1.87           → ASI-20251117-5
```

| DocNum | Bên | TK | AccountedDr | AccountedCr | Description |
|---|---|---|---|---|---|
| `ASI-20251117-4` | Debit | `13122001` | 44.88 | 0 | Pair 1: … \| 1LU34396RX643582B |
| `ASI-20251117-4` | Credit | `11202051` | 0 | 44.88 | Pair 1: … \| 1LU34396RX643582B |
| `ASI-20251117-5` | Debit | `11202051` | 1.87 | 0 | Pair 3: … \| 1LU34396RX643582B |
| `ASI-20251117-5` | Credit | `64202010` | 0 | 1.87 | Pair 3: … \| 1LU34396RX643582B |

**Đọc bằng lời:** trả lại 44.88 cho khách (khoản ứng trước bị xóa), đồng thời PayPal hoàn lại 1.87 phí —
chi phí `64202010` được ghi Có để giảm xuống, đúng bằng số đã ghi Nợ ở dòng 1.

### 6.5. Dòng 4 và kết quả cả chuỗi

Dòng 4 (`Gross = +8.17`, dương, không đảo) cho `ASB-20251117-6`: **Nợ `11202051` / Có `11202052`** 8.17 —
đúng ngược với dòng 2.

Cộng mọi phát sinh trên `11202051` của 4 dòng:

```
+44.88  (dòng 1, khách trả)
− 1.87  (dòng 1, phí)
− 8.17  (dòng 2, bị giữ)
−44.88  (dòng 3, hoàn tiền)
+ 1.87  (dòng 3, hoàn phí)
+ 8.17  (dòng 4, nhả giữ)
───────
  0.00   ← khớp đúng cột Balance của file
```

Sổ kế toán đã tái hiện chính xác vòng đời của giao dịch: bán rồi hoàn, cuối cùng không còn gì.

---

## 7. Dòng bị loại và lỗi

`build-bank.ts` **gom exception theo nhóm** thay vì ghi từng dòng (nguồn thật có 142k dòng). Message có
đuôi `— N dòng (VD: …)`. Chi tiết từng dòng vẫn nằm ở `RawPaypal.BuildMessage`, xem trên trang raw.

File mẫu sinh **36 dòng exception**:

| ExceptionType | Severity | Nghĩa | Trong file mẫu |
|---|---|---|---|
| `MISSING_ACCOUNT` | INFO | Rule bị bỏ vì JournalType không khai tài khoản của vai trò đó | Rule 20 bị bỏ ở hầu hết nghiệp vụ (`TransAccount` NULL) |
| `AMOUNT_ZERO` | INFO | Rule bị bỏ vì số tiền = 0 | Rule 30 bị bỏ ở mọi dòng có `Fee = 0` — tổng 59 lượt |
| `MISSING_PARTNER` | WARNING | Không tra được partner → **vẫn ghi sổ**, `PartnerTaxID` trống | 4 dòng `PP_MASS_PAY_PAYMENT` dùng `From Source` nhưng cột `PartnerCode` trống |
| `MISSING_JOURNAL_TYPE` | ERROR | Không có JournalType tương ứng → dòng raw `ERROR`, không sinh event | 1 dòng, xem dưới |

### 7.1. Một dòng cố ý để lỗi

```
2025-11-19  General Currency Conversion  −400  PP_GENERAL_CURRENCY_CONVERSION
→ ERROR MISSING_JOURNAL_TYPE: Không có JournalType DataSource=PAYPAL, JournalTypeCode=PP_GENERAL_CURRENCY_CONVERSION
```

Master chỉ có `PP_USER_INITIATED_CURRENCY_CONVERSION`. Hệ thống **không tự suy** sang mã gần giống vì đó
là quyết định nghiệp vụ. Muốn ghi sổ thì thêm dòng JournalType mới, hoặc sửa cột `JournalType` trong file.

### 7.2. ⚠️ Lỗi master data đã biết: `PP_CANCEL_HOLD_DISPUTE_RESOLUTION`

Bốn dòng "Cancellation of Hold for Dispute Resolution" trong file mẫu **không sinh event nào**:

```
BuildStatus = BUILT
BuildMessage = Không sinh event nào — rule 10: thiếu CONTRA_ACCOUNT; rule 20: thiếu CONTRA_ACCOUNT; rule 30: FEE = 0
```

Nguyên nhân: dòng `JournalTypeID = 1` trong `data/seed/journal-type.csv` có **`ContraAccount` rỗng**, trong
khi mọi nghiệp vụ hold khác đều dùng `11202052`. `data/samples/gltrans-reference.csv` (kết xuất thật của
hệ thống cũ) cho thấy nghiệp vụ này **phải** ghi vào `11202052`.

Nhiều khả năng giá trị bị mất do lỗi header của file master: cột thứ 6 của `journal-type.csv` bị đặt tên
là `11202052` thay vì `ContraAccount` (parser đọc theo vị trí nên các dòng khác vẫn đúng).

**Hệ quả nguy hiểm:** dòng raw vẫn mang trạng thái `BUILT` và **không có exception mức ERROR**, nên nhìn
lướt bảng sẽ tưởng đã ghi sổ xong. Nghiệp vụ "nhả tiền giữ sau khi xử lý tranh chấp" bị thiếu khỏi sổ.
Cần bổ sung `ContraAccount = 11202052` cho dòng này trong Google Sheet rồi sync lại.

---

## 8. Kết quả toàn bộ file mẫu

```
81 dòng file ─► 81 RawPaypal ─► 80 dòng hợp lệ (1 ERROR) ─► 113 event ─► 87 chứng từ ─► 190 dòng GL
```

| Bước | Số liệu |
|---|---|
| Import | 81 dòng, 0 lỗi, `Status = SUCCESS` |
| Build | 81 dòng nguồn · 1 `ErrorRows` · **113 event** · 59 lượt rule bị bỏ vì số tiền = 0 |
| Post Single | 73 event → 73 chứng từ → 146 dòng GL |
| Post Bulk | 40 event → 14 chứng từ → 44 dòng GL |
| **Tổng GL** | **190 dòng · 87 chứng từ · Σ Nợ = Σ Có = 258.808,82 USD** |

### Bảng cân đối theo tài khoản

| Tài khoản | Tên | Phát sinh Nợ | Phát sinh Có | Số dòng |
|---|---|---|---|---|
| `11202051` | PayPal - Available | 47.418,60 | 211.169,23 | 82 |
| `11202052` | PayPal - Held/Reserve | 89.548,74 | 46.710,36 | 24 |
| `11301001` | Rút PayPal về Bank - đang chuyển | 76.500,00 | 0 | 4 |
| `13122001` | Người mua trả tiền trước | 959,55 | 610,16 | 21 |
| `33102002` | Phải trả Supplier | 44.000,00 | 0 | 4 |
| `33102005` | Phải trả PSP | 220,99 | 220,99 | 26 |
| `64202010` | Chi phí payment gateway | 19,95 | 98,08 | 20 |
| `64202011` | Chi phí Dispute | 60,00 | 0 | 4 |
| `64202012` | Chi phí Chargeback | 80,00 | 0 | 4 |
| `64202013` | Chi phí Partner fees | 0,99 | 0 | 1 |
| | **Tổng** | **258.808,82** | **258.808,82** | **190** |

Đọc bảng này bằng lời:

- `11202051` phát sinh Có nhiều hơn Nợ rất nhiều → trong kỳ mẫu, tiền **ra khỏi ví PayPal** là chính
  (rút 76.500 về ngân hàng, trả nhà cung cấp 44.000, bị giữ 89.548,74).
- `11202052` Nợ 89.548,74 / Có 46.710,36 → cuối kỳ vẫn còn một phần tiền **đang bị PayPal giữ**.
- `33102005` Nợ đúng bằng Có → mọi khoản phí PayPal ghi nhận phải trả đều đã được kết chuyển sang chi phí.
Riêng `64202010` có phát sinh Có (98,08) lớn hơn Nợ (19,95). Tách ra thì thấy rõ:

| Nguồn phát sinh | Nợ | Có |
|---|---|---|
| Phí thu trên giao dịch bán hàng (rule 30 của `EXPRESS_CHECKOUT`, `DIRECT_CREDIT_CARD`, `MASS_PAY`) | 19,95 | – |
| PayPal hoàn lại phí khi hoàn tiền / đảo giao dịch (rule 30 của `PAYMENT_REFUND`, `PAYMENT_REVERSAL`, `IPR_REVERSAL`) | – | 18,08 |
| `PP_FEE_REVERSAL` kết chuyển khoản phải trả PSP thành giảm chi phí (**rule 20**, không phải rule phí) | – | 80,00 |

Tức là phần lớn số dư Có **không đến từ cột `Fee`**, mà từ nghiệp vụ `Fee Reversal` đi qua rule 20.

---

## 9. Tra nhanh và tự kiểm chứng

### 9.1. Các công thức khóa

```
SourceKey       = {Transaction ID}|{Date}|{Time}
SourceID        = PAYPAL|{SourceKey}
TransactionID   = {Transaction ID}                     (mã gốc, ghi lên GL làm ReferenceTxnID)
EventSeq        = RuleSeq  (10 | 20 | 30)
Period          = YYYYMM của PostingDate
DocNum Single   = ASI-{yyyyMMdd}-{AccountingEventID}
DocNum Bulk     = ASB-{yyyyMMdd}-{AccountingEventID nhỏ nhất trong nhóm}
PostingGroupKey = ComCode|JournalTypeCode|yyyyMMdd|InputCurr|FncCurr|UPPER(PartnerCode)|PartnerTaxID|BankAccountNumber
Amount (event)  = GROSS hoặc FEE, giữ nguyên dấu, CHƯA nhân AmountFactor
Amount (GL)     = |Event.Amount × AmountFactor|, chiều Nợ/Có do NegativeMode quyết định
```

### 9.2. Cột GLTrans đến từ đâu

| Cột GLTrans | Nguồn |
|---|---|
| `AccountCode` | `accountFromSource(rule.NormalDr/CrAccountSource, event)` → 1 trong 4 cột tài khoản của event |
| `BalanceImpact` | `Debit` / `Credit`, do rule + `NegativeMode` quyết định |
| `InputDr/Cr`, `AccountedDr/Cr` | `Event.Amount × AmountFactor`, quy đổi theo `XRate` |
| `XRate`, `RateType` | `resolveFx`. PayPal USD → USD nên luôn `1` / `MUL` |
| `PartnerCode`, `PartnerTaxID` | partner của event, hoặc `rule.FixedPartner` nếu `PartnerMode = FIXED` |
| `Description` | `rule.MemoTemplate` + ` \| ` + `TransactionID` (Single) hoặc ` \| {n} events` (Bulk) |
| `ReferenceTxnID` | `Event.TransactionID` (Single) / `null` (Bulk) |
| `OrderID` | `Invoice ID` của file |
| `RefNum` | `Reference Txn ID`, hoặc `Invoice ID` nếu trống |
| `BankAccountNumber` | `PAYPAL1` |
| `DataSource`, `ComCode`, `Period`, `TransDate`, `DocDate` | copy từ event |

### 9.3. Câu SQL soi dữ liệu

```sql
-- Chứng từ nào không cân? (kết quả rỗng là đúng)
SELECT DocNum, ROUND(SUM(AccountedDr),2) dr, ROUND(SUM(AccountedCr),2) cr
FROM GLTrans WHERE DataSource='PAYPAL'
GROUP BY DocNum HAVING dr <> cr;

-- Lần từ 1 dòng GL về dòng sao kê gốc
SELECT r.* FROM RawPaypal r
JOIN AccountingEvent e ON e.SourceID = 'PAYPAL|' || r.SourceKey
WHERE e.PostedDocNum = 'ASI-20251117-4';

-- Dòng raw đã BUILT nhưng không sinh event nào (bẫy im lặng, xem mục 7.2)
SELECT SourceKey, JournalType, BuildMessage FROM RawPaypal
WHERE BuildMessage LIKE '%Không sinh event%';
```

### 9.4. Test nào canh các con số này

| Số liệu | Test |
|---|---|
| 81 dòng import, 113 event, Dr = Cr | `tests/integration/bank-sources.test.ts` |
| `PP_RESERVE_HOLD` chỉ có `EventSeq = 10`, mọi `Amount < 0` | `tests/engine/build-bank.test.ts` |
| `PP_EXPRESS_CHECKOUT_PAYMENT` có `EventSeq = [10, 30]`, event seq 30 `Amount < 0` | `tests/engine/build-bank.test.ts` |
| Đúng 1 `MISSING_JOURNAL_TYPE` = `PP_GENERAL_CURRENCY_CONVERSION` | `tests/engine/build-bank.test.ts` |
| Sửa tay cột `JournalType` rồi import lại thì bị chặn | `tests/integration/bank-sources.test.ts` |

Chạy: `npm test`.

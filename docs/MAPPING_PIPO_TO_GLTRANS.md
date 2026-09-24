# PingPong (PIPO): sao kê thô → RawPipo → AccountingEvent → GLTrans

> Giải thích **một dòng sao kê PingPong biến thành những dòng Nợ/Có nào, và vì sao**. Số liệu trong tài
> liệu do chính code của repo sinh ra trên `pipo-sample.csv` — bản trích 36 dòng của file thật, **đã gỡ khỏi repo**. Cách ánh xạ dưới đây không đổi; tổng số hiện tại của cả file xem `docs/DEVELOPER_GUIDE.md` §10.2.
>
> - Kiến thức kế toán cơ bản (Nợ/Có, loại tài khoản, chứng từ): [`MAPPING_ORDERS_TO_GLTRANS.md` Phần 1](MAPPING_ORDERS_TO_GLTRANS.md#phần-1--kiến-thức-kế-toán-tối-thiểu).
> - Chi tiết kỹ thuật: [`DEVELOPER_GUIDE.md` §6.11](DEVELOPER_GUIDE.md). Yêu cầu gốc: `tai lieu du an.md` §7.5.
> - Hai nguồn cùng engine: [PayPal](MAPPING_PAYPAL_TO_GLTRANS.md) · [Stripe](MAPPING_STRIPE_TO_GLTRANS.md).

## Mục lục

- [0. Số liệu lấy từ đâu](#0-số-liệu-lấy-từ-đâu)
- [1. Nguồn PingPong là gì](#1-nguồn-pingpong-là-gì)
- [2. Import: file → RawPipo](#2-import-file--rawpipo)
- [3. Master data: JournalType và 3 rule](#3-master-data-journaltype-và-3-rule)
- [4. Build: RawPipo → AccountingEvent](#4-build-rawpipo--accountingevent)
- [5. Quy tắc trừ phí — điểm khó nhất của nguồn này](#5-quy-tắc-trừ-phí--điểm-khó-nhất-của-nguồn-này)
- [6. Post và ví dụ lần theo](#6-post-và-ví-dụ-lần-theo)
- [7. Dòng bị loại và lỗi](#7-dòng-bị-loại-và-lỗi)
- [8. Kết quả toàn bộ file mẫu](#8-kết-quả-toàn-bộ-file-mẫu)
- [9. Tra nhanh và tự kiểm chứng](#9-tra-nhanh-và-tự-kiểm-chứng)

---

## 0. Số liệu lấy từ đâu

Chạy đúng code của repo trên một DB SQLite trống, master data lấy từ `data/seed/*.csv`:

```
importSourceFile("pipo", pipo-sample.csv)     →  36 dòng RawPipo
runBuildSource("pipo")                        →  48 AccountingEvent (2 dòng bị bỏ)
runPost("All", { dataSource: "PIPO" })        →  48 chứng từ / 96 dòng GLTrans
```

Số tiền và tài khoản sẽ giống hệt trên máy bạn; các ID tự tăng (và phần số trong `DocNum`) chỉ trùng nếu
làm trên DB trống và import đúng 1 lần.

---

## 1. Nguồn PingPong là gì

`Bank_Pipo` là **sao kê ví PingPong** — ví trung gian mà công ty dùng để: nhận tiền rút từ PayPal/Stripe,
trả tiền cho seller và nhà cung cấp, rút về ngân hàng Canada, nạp thẻ MasterCard.

Khác PayPal/Stripe (cổng thanh toán của **khách hàng**), PingPong là nơi **tiền đi ra**. Vì vậy tuyệt đại
đa số dòng có `Amount` âm.

```
 File sao kê (sheet Bank_Pipo)
      │  (1) IMPORT
      ▼
 ┌──────────────┐   1 dòng file = 1 dòng RawPipo (khóa SourceKey = TransactionId)
 │   RawPipo    │
 └──────┬───────┘
        │  (2) BUILD  ─ src/lib/engine/build-bank.ts + sources/pipo.ts
        ▼
 ┌──────────────────┐  1 dòng raw × mỗi JournalLineRule active = 1 event
 │ AccountingEvent  │
 └──────┬───────────┘
        │  (3) POST
        ▼
 ┌──────────────┐   Mọi nghiệp vụ PIPO đều Classify = Single
 │   GLTrans    │   → 1 event = 1 chứng từ = 2 dòng
 └──────────────┘
```

### Tài khoản mà PingPong dùng

| Tài khoản | Tên trong CoA | Loại | Ý nghĩa |
|---|---|---|---|
| `11202061` | PingPong - Available (USD) | A | Số dư ví PingPong |
| `11301001` | Rút PayPal về Bank VN - đang chuyển | A | Tiền đang chuyển giữa các ví/ngân hàng |
| `33102001` | Phải trả Seller - Share profit/Payout | L | Nợ seller (nối với nguồn Orders) |
| `33111002` | Phải trả NCC (USA) | L | Nợ nhà cung cấp |
| `33402001` | Lương phải trả - CA | L | Nợ lương |
| `13111001` / `13889001` | Phải thu khách hàng / Phải thu khác | A | Thu tiền về |
| `33102002` | Phải trả Supplier - COGS/fulfillment | L | Nợ chi phí fulfillment |
| `64200020` | Chi phí QLDN - Phí ngân hàng/chuyển tiền | Exp | **Phí chuyển tiền PingPong** |

---

## 2. Import: file → RawPipo

**Code:** `src/lib/services/import-source.ts`, `src/lib/sources/normalize.ts`.
**Trên web:** trang **Raw → PIPO / PingPong**.

File có 17 cột. Build dùng 9 cột:

| Cột trong file | Dùng làm gì |
|---|---|
| `TransactionId` | `SourceKey`, `TransactionID`, `RefNum` |
| `Time` | `PostingDate` (lấy phần ngày) |
| `Type` | `Receive` / `Send` / `Withdraw` — dùng suy JournalType khi cột `JournalType` trống |
| `Status` | Bộ lọc: **chỉ `Success` mới ghi sổ** |
| `Amount` | Số tiền chính (`AmountSource = AMOUNT`) — **có thể bị trừ phí, xem mục 5** |
| `Fee` | Phí (`AmountSource = FEE`) |
| `JournalType` | **Người dùng điền tay** |
| `ComCode` | Công ty ghi sổ |
| `PartnerCode`, `StoreName` | Đối tượng (mọi nghiệp vụ PIPO đều `From Source`) |
| `Note` | → `Description` của event |

`BankAccoutNumber` trống → mặc định `PINGPONG1` → `11202061`.
**Không dùng cột `CardNo`** — đó là số thẻ/ví, không có trong `MappingBankAccount`.

### `SourceKey`

```
SourceKey = {TransactionId}      VD: TR01202512091023373387775
```

Duy nhất tuyệt đối. Không chứa cột người dùng điền tay → sửa tay `JournalType`/`PartnerCode` rồi import
lại sẽ bị chặn (*"Unbuild PIPO trước khi import lại"*).

### Ba đặc thù định dạng phải biết

1. **`Amount`, `Fee`, `Net` là text có đuôi tiền tệ:** `"0.90USD"`, `"100.00USD"`, `"124.53CAD"`.
   `parseNumber` bóc lấy phần số.
2. **`From/To` chứa xuống dòng** bên trong dấu nháy: file mẫu có 46 dòng vật lý nhưng chỉ **36 bản ghi**.
3. **`Amount` đã mang dấu sẵn:** `Send`/`Withdraw` âm, `Receive` dương. Không cần suy từ `Type`.

> Cột `Rate` và phần `CAD` trong `Net` (ví dụ `Rate = 1.39759`, `Net = 124.53CAD`) là **tỷ giá riêng của
> PingPong khi chuyển sang ngân hàng Canada**. Hệ thống **không dùng chúng để ghi sổ** — toàn bộ nguồn PIPO
> ghi sổ bằng USD, tỷ giá kế toán nếu cần sẽ lấy từ bảng `Exrate`. Đừng nhầm hai thứ này.
>
> Ghi chú dữ liệu: một dòng trong file mẫu có `Rate = 136433` (thiếu dấu thập phân, đúng ra ~1,36433).
> Không ảnh hưởng ghi sổ vì cột này không được dùng.

---

## 3. Master data: JournalType và 3 rule

### 3.1. Mười `JournalType` của PIPO

Tất cả đều có `BankAccount = 11202061`, `FeeAccount = 64200020`, `Partner = From Source`,
`Classify = Single`:

| JournalTypeCode | Nghiệp vụ | Contra | Trans |
|---|---|---|---|
| `BANK_INTERNAL_TRANSFER_FROM` | Nhận tiền từ ví khác (PayPal, Stripe) | `11301001` | – |
| `BANK_INTERNAL_TRANSFER_TO` | Chuyển tiền sang ví/ngân hàng khác | `11301001` | – |
| `BANK_PAYMENT_SELLER` | Trả tiền seller | `33102001` | – |
| `BANK_PAYMENT_SUPPLIER` | Trả tiền nhà cung cấp | `33111002` | – |
| `BANK_PAYMENT_SALARY` | Trả lương | `33402001` | – |
| `BANK_PAYMENT_COSTSUP` | Trả chi phí fulfillment | `33102002` | – |
| `BANK_PAYMENT_OTHER` | Chi khác | `13889001` | – |
| `BANK_RECEIPT_CUSTOMER` | Thu tiền khách | `13111001` | – |
| `BANK_RECEIPT_OTHER` | Thu khác | `13889001` | – |
| `BANK_BANK_FEE` | Phí ngân hàng đứng riêng | `33111002` | `64200020` |

> ⚠️ **Mười mã này dùng chung `JournalTypeCode` với `DataSource = AccountingSource`** (khai trong Google Sheet,
> không còn nguồn nào import). `JournalLineRule` chỉ có **một** bộ rule `BANK_*` phục vụ cả hai và được tra
> theo `JournalTypeCode` **không kèm DataSource** — xóa các dòng đó khỏi master là PIPO mất sạch event.
> Vì `JournalLineRule` khóa theo `JournalTypeCode` **mà không có `DataSource`**, hai nguồn dùng chung
> đúng một bộ rule.
>
> **Thiếu 10 dòng `DataSource = PIPO` này thì `classifyOf` trả `null` và event sẽ không bao giờ post
> được** — không báo lỗi, chỉ đơn giản là event nằm mãi ở trạng thái `NEW`. Đây là cái bẫy đã được ghi
> trong `CLAUDE.md` quy tắc 11.

### 3.2. Ba rule sinh bút toán

| RuleSeq | PairCode | Bên Nợ | Bên Có | Số tiền | Hệ số | Partner |
|---|---|---|---|---|---|---|
| **10** | `BANK_CONTRA` | `BANK_ACCOUNT` | `CONTRA_ACCOUNT` | `AMOUNT` | ×1 | của event |
| **20** | `CONTRA_TRANS` | `CONTRA_ACCOUNT` | `TRANS_ACCOUNT` | `AMOUNT` | ×1 | của event |
| **30** | `FEE_BANK` | `FEE_ACCOUNT` | `BANK_ACCOUNT` | `FEE` | ×1 | cố định `BANK` |

Không phải nghiệp vụ nào cũng có đủ 3 rule:

| JournalTypeCode | Rule có trong master |
|---|---|
| `BANK_INTERNAL_TRANSFER_FROM` | **chỉ 10** |
| `BANK_INTERNAL_TRANSFER_TO` | **10 + 30** (không có 20) |
| `BANK_PAYMENT_*` | 10 + 20 + 30 |
| `BANK_RECEIPT_*`, `BANK_BANK_FEE` | 10 + 20 |

Tất cả có `NegativeMode = REVERSE` và mọi cờ `SkipIf*` = 1. Vì `TransAccount` của 9/10 nghiệp vụ là NULL,
**rule 20 gần như luôn bị bỏ** → INFO `MISSING_ACCOUNT`.

> Hai lỗi chính tả trong master data, không ảnh hưởng kết quả nhưng sẽ thấy khi soi dữ liệu:
> - `FixedPartner` của 6 rule phí viết là `BANk` (chữ k thường); code uppercase thành `BANK` nên vẫn khớp.
> - `MemoTemplate` của rule 30 thuộc `BANK_INTERNAL_TRANSFER_TO` bị chép nhầm thành
>   `Bank Payment CostSup | FEE_BANK`. Chuỗi sai này **hiện nguyên văn** trong `GLTrans.Description`.

---

## 4. Build: RawPipo → AccountingEvent

**Code:** `src/lib/engine/build-bank.ts` + `src/lib/engine/sources/pipo.ts`.
**Trên web:** trang **AccountingEvent** → **Build PIPO**.

| # | Bước | Chi tiết | Hỏng thì sao |
|---|---|---|---|
| 1 | Lọc | `UPPER(Status)` phải là `SUCCESS` | `SKIPPED`, INFO `SOURCE_ROW_SKIPPED` |
| 2 | Công ty | `ComCode` → `Company` → `FncCurr` | ERROR `MISSING_COMCODE` / `MISSING_COMPANY` |
| 3 | Ngày | `PostingDate` = phần ngày của `Time` | ERROR `INVALID_SOURCE_ROW` |
| 4 | JournalType | Cột `JournalType` thắng; trống thì tra `Type` | ERROR `MISSING_JOURNAL_TYPE` |
| 5 | Tài khoản | dòng nguồn → `MappingBankAccount` (`PINGPONG1`) → mặc định JournalType | (xem rule skip) |
| 6 | Partner | mọi nghiệp vụ đều `From Source` → tra cột `PartnerCode` trong `Partners` | WARNING `MISSING_PARTNER`, **vẫn ghi sổ** |
| 7 | Sinh event | mỗi rule active → 1 event; **số tiền tính theo mục 5** | INFO `AMOUNT_ZERO` / `MISSING_ACCOUNT` |

Bước 6 đáng chú ý: PIPO là nguồn duy nhất trong ba nguồn mà **cột `PartnerCode` của file thật sự được
dùng** (PayPal và Stripe hầu hết là `Fixed = …`). Vì vậy sai chính tả email seller trong file sẽ sinh
cảnh báo — nhưng **vẫn ghi sổ** với mã đó, `PartnerTaxID` để trống.

---

## 5. Quy tắc trừ phí — điểm khó nhất của nguồn này

**Code:** `src/lib/engine/sources/pipo.ts:28` (`pipoAmountExcludesFee`).

Trên sao kê PingPong, với các nghiệp vụ chuyển tiền đi, **cột `Amount` đã bao gồm cả phí**. Ví dụ thật:

```
Amount = -101.01     Fee = 1.01USD     Net = 100.00USD
```

Người nhận thực nhận **100,00**; công ty mất **101,01**; chênh lệch 1,01 là phí. Nếu ghi sổ thẳng
`Amount = -101.01` cho bút toán gốc **rồi cộng thêm** bút toán phí 1,01 nữa thì tổng thành 102,02 — sai.

Nên engine tách ra:

```
nếu JournalTypeCode bắt đầu bằng "BANK_PAYMENT_"  HOẶC  bằng "BANK_INTERNAL_TRANSFER_TO"
   và Fee ≠ 0:
       AMOUNT = (|Amount| − |Fee|) × dấu của Amount      ← số tiền gốc, đã bỏ phí ra
       FEE    = |Fee|
ngược lại:
       AMOUNT = Amount   (nguyên vẹn)
       FEE    = |Fee|
```

Áp vào ví dụ trên: `AMOUNT = −100.00`, `FEE = 1.01`. Hai bút toán cộng lại đúng 101,01 rút khỏi ví.

| Nghiệp vụ | Trừ phí? | Vì sao |
|---|---|---|
| `BANK_PAYMENT_SELLER`, `_SUPPLIER`, `_SALARY`, `_COSTSUP`, `_OTHER` | ✅ | Tiền chuyển đi, `Amount` gồm cả phí |
| `BANK_INTERNAL_TRANSFER_TO` | ✅ | Như trên |
| `BANK_INTERNAL_TRANSFER_FROM` | ❌ | Tiền nhận về, `Amount` là số thực nhận |
| `BANK_RECEIPT_*`, `BANK_BANK_FEE` | ❌ | Không rơi vào tiền tố trên |

> Đây là nguồn **duy nhất** mà hàm `amounts()` phụ thuộc vào `JournalTypeCode` — lý do
> `BankSourceSpec.amounts` nhận tham số thứ hai.

---

## 6. Post và ví dụ lần theo

Mọi nghiệp vụ PIPO đều `Classify = Single`: **1 event = 1 chứng từ = 2 dòng GL**,
`DocNum = ASI-{yyyyMMdd}-{AccountingEventID}`, `Description = {MemoTemplate} | {TransactionId}`.
`InputCurr = FncCurr = USD` nên `XRate = 1`, `RateType = MUL`.

### 6.1. Nhận 500 từ PayPal — trường hợp đơn giản nhất

```
Time=2025-11-20 17:23:10   TransactionId=MTX2511202425087791   Type=Receive
Amount=500   Fee=(trống)   Status=Success   JournalType=BANK_INTERNAL_TRANSFER_FROM
PartnerCode=Paypal ZeniroxPay
```

1 event (nghiệp vụ này chỉ có rule 10). `Amount = +500` dương → **không đảo**:

```
Nợ 11202061 (PingPong Available)          500.00
    Có 11301001 (Tiền đang chuyển)        500.00
```

| DocNum | Bên | TK | AccountedDr | AccountedCr | Partner |
|---|---|---|---|---|---|
| `ASI-20251120-185` | Debit | `11202061` | 500,00 | 0 | Paypal ZeniroxPay |
| `ASI-20251120-185` | Credit | `11301001` | 0 | 500,00 | Paypal ZeniroxPay |

**Đọc bằng lời:** tiền rút từ PayPal đã về tới ví PingPong. Tài khoản "đang chuyển" `11301001` được ghi Có
để tất toán — trước đó nguồn PayPal đã ghi Nợ nó khi lệnh rút phát sinh.

### 6.2. Trả seller 4.716,07 — phí bằng 0

```
Time=2025-12-09 17:24:13   TransactionId=TR01202512091023373387775   Type=Send
Amount=-4716.07   Fee=0.00USD   Note="ARG payout den ngay 08.12.2025"
JournalType=BANK_PAYMENT_SELLER   StoreName=ARG   PartnerCode=cong2672000@gmail.com
```

Nghiệp vụ này có đủ 3 rule, nhưng chỉ 1 chạy được:

| Rule | Kết quả |
|---|---|
| 10 `BANK_CONTRA` | ✅ 1 event, `Amount = −4716.07` (Fee = 0 nên **không trừ phí**) |
| 20 `CONTRA_TRANS` | ❌ bỏ — `TransAccount` NULL → INFO `MISSING_ACCOUNT` |
| 30 `FEE_BANK` | ❌ bỏ — `FEE = 0` → INFO `AMOUNT_ZERO` |

`Amount` âm → `REVERSE` đảo Nợ/Có:

```
−4716.07  →  REVERSE  →  đảo hai vế, lấy |−4716.07|
Nợ 33102001 (Phải trả Seller)        4.716,07
    Có 11202061 (PingPong Available) 4.716,07
```

| DocNum | Bên | TK | AccountedDr | AccountedCr | Partner |
|---|---|---|---|---|---|
| `ASI-20251209-196` | Debit | `33102001` | 4.716,07 | 0 | cong2672000@gmail.com |
| `ASI-20251209-196` | Credit | `11202061` | 0 | 4.716,07 | cong2672000@gmail.com |

**Đọc bằng lời:** công ty trả tiền cho seller store ARG. Khoản nợ phải trả seller giảm đi (ghi Nợ), tiền
trong ví giảm đi (ghi Có). Chính khoản `33102001` này đã được nguồn Orders ghi Có mỗi lần đơn của seller
được giao — nay trả tiền thì cấn trừ.

### 6.3. Rút 90 về Royal Bank — có phí, minh họa quy tắc mục 5

```
Time=2025-12-02 16:58:13   TransactionId=W01202512020958131164138   Type=Withdraw
Amount=-90   Fee=0.90USD   Rate=1.39759   Net=124.53CAD
JournalType=BANK_INTERNAL_TRANSFER_TO   PartnerCode=Royal Bank
```

Vì là `BANK_INTERNAL_TRANSFER_TO` và `Fee ≠ 0` → **tách phí ra**:

```
AMOUNT = (|−90| − |0.90|) × (−1) = −89.10
FEE    = 0.90
```

2 event (nghiệp vụ này chỉ có rule 10 và 30), mỗi event 1 chứng từ riêng:

```
rule 10:  −89.10  →  REVERSE  →  đảo
          Nợ 11301001 (Tiền đang chuyển)     89,10
              Có 11202061 (PingPong)         89,10          → ASI-20251202-189

rule 30:  +0.90 × 1 = +0.90  (dương, không đảo)
          Nợ 64200020 (Chi phí phí chuyển tiền)  0,90
              Có 11202061 (PingPong)             0,90       → ASI-20251202-190
```

| DocNum | Bên | TK | AccountedDr | AccountedCr | Partner | Description |
|---|---|---|---|---|---|---|
| `ASI-20251202-189` | Debit | `11301001` | 89,10 | 0 | Royal Bank | Bank Internal Transfer To \| BANK_CONTRA \| W0120… |
| `ASI-20251202-189` | Credit | `11202061` | 0 | 89,10 | Royal Bank | Bank Internal Transfer To \| BANK_CONTRA \| W0120… |
| `ASI-20251202-190` | Debit | `64200020` | 0,90 | 0 | **BANK** | **Bank Payment CostSup** \| FEE_BANK \| W0120… |
| `ASI-20251202-190` | Credit | `11202061` | 0 | 0,90 | **BANK** | **Bank Payment CostSup** \| FEE_BANK \| W0120… |

Kiểm tra lại tổng tiền ra khỏi ví PingPong:

```
89,10  (gốc)
+ 0,90  (phí)
───────
 90,00  ← đúng bằng cột Amount của file
```

**Đọc bằng lời:** công ty chuyển 90 USD ra khỏi PingPong; 89,10 tới được ngân hàng, 0,90 là phí chuyển
tiền và trở thành chi phí trong kỳ. Nếu không có quy tắc trừ phí ở [mục 5](#5-quy-tắc-trừ-phí--điểm-khó-nhất-của-nguồn-này),
sổ sẽ ghi 90,90 — thừa đúng một lần phí.

Hai chỗ "lệch" trong bảng trên là **đúng như cấu hình**, không phải bug ghi sổ:
- Partner dòng phí là `BANK` chứ không phải `Royal Bank`, vì rule 30 ghi `PartnerMode = FIXED`.
- Diễn giải là `Bank Payment CostSup` vì `MemoTemplate` của rule 183 bị chép nhầm (xem [mục 3.2](#32-ba-rule-sinh-bút-toán)).

---

## 7. Dòng bị loại và lỗi

File mẫu sinh **10 dòng exception** (đã gom nhóm):

| ExceptionType | Severity | Số lượng | Nghĩa |
|---|---|---|---|
| `SOURCE_ROW_SKIPPED` | INFO | 2 dòng | `Status = Retrieved`, không phải `Success` |
| `MISSING_ACCOUNT` | INFO | 12 lượt | Rule 20 bị bỏ vì `TransAccount` NULL (`BANK_PAYMENT_SELLER` 8, `_SUPPLIER` 4) |
| `AMOUNT_ZERO` | INFO | 12 lượt | Rule 30 bị bỏ vì `Fee = 0` (cùng hai nghiệp vụ trên) |
| `MISSING_PARTNER` | WARNING | 5 mã | Email seller chưa có trong bảng `Partners` |

### 7.1. Hai dòng `Retrieved`

```
2025-10-30 13:51:16  Amount=0.17   Status=Retrieved  → bỏ qua
2025-10-30 13:51:20  Amount=0.05   Status=Retrieved  → bỏ qua
INFO SOURCE_ROW_SKIPPED: PIPO chỉ ghi sổ giao dịch Status = Success (dòng này Retrieved) — 2 dòng
```

`Retrieved` là trạng thái trung gian của PingPong, giao dịch chưa chắc chắn. Chỉ `Success` mới ghi sổ.
Đây là **hành vi đúng**, không phải lỗi.

### 7.2. Năm seller chưa có trong `Partners`

```
WARNING MISSING_PARTNER: PartnerCode "Manh020901tb@gmail.com" (BANK_PAYMENT_SELLER)
        chưa có trong Partners → ghi sổ với mã đó, PartnerTaxID trống
```

Các mã còn lại: `anhdung0347699481@gmail.com`, `pingpong@nova8x.com`, `chatkia7@gmail.com`,
`vnbuihagialinh@gmail.com`.

**Đây chỉ là cảnh báo, không chặn ghi sổ.** Dòng GL vẫn có `PartnerCode` đúng, chỉ thiếu `PartnerTaxID`
nên báo cáo công nợ theo mã số thuế sẽ không gom được. Khắc phục: thêm seller vào Google Sheet `Partners`
rồi sync, sau đó Unpost + Unbuild + Build lại nguồn PIPO.

> Khác biệt đáng chú ý so với nguồn Orders: ở Orders, không tra được seller là **ERROR** và chặn post.
> Ở các nguồn ngân hàng chỉ là **WARNING**, vì tiền đã thực sự chuyển đi rồi — sổ phải phản ánh điều đó.

---

## 8. Kết quả toàn bộ file mẫu

```
36 dòng file ─► 36 RawPipo ─► 34 dòng hợp lệ (2 SKIPPED) ─► 48 event ─► 48 chứng từ ─► 96 dòng GL
```

| Bước | Số liệu |
|---|---|
| Import | 36 dòng, 0 lỗi, `Status = SUCCESS` |
| Build | 36 dòng nguồn · **2 `SkippedRows`** · 0 `ErrorRows` · **48 event** · 12 lượt rule bị bỏ vì `Fee = 0` |
| Post Single | 48 event → 48 chứng từ → 96 dòng GL |
| Post Bulk | không có (mọi JournalType đều `Single`) |
| **Tổng GL** | **96 dòng · 48 chứng từ · Σ Nợ = Σ Có = 316.847,24 USD** |

Số event theo nghiệp vụ:

| JournalTypeCode | Dòng file (Success) | Rule chạy | Event | Σ Amount |
|---|---|---|---|---|
| `BANK_INTERNAL_TRANSFER_TO` | 14 | 10 + 30 (mọi dòng đều có phí) | 28 | −3.458,06 |
| `BANK_INTERNAL_TRANSFER_FROM` | 8 | 10 | 8 | +158.500,00 |
| `BANK_PAYMENT_SELLER` | 8 | 10 | 8 | −8.305,51 |
| `BANK_PAYMENT_SUPPLIER` | 4 | 10 | 4 | −146.513,09 |
| | **34** | | **48** | |

### Bảng cân đối theo tài khoản

| Tài khoản | Tên | Phát sinh Nợ | Phát sinh Có | Số dòng |
|---|---|---|---|---|
| `11202061` | PingPong - Available | 158.500,00 | 158.347,24 | 48 |
| `11301001` | Tiền đang chuyển | 3.493,35 | 158.500,00 | 22 |
| `33102001` | Phải trả Seller | 8.305,51 | 0 | 8 |
| `33111002` | Phải trả NCC (USA) | 146.513,09 | 0 | 4 |
| `64200020` | Chi phí phí ngân hàng/chuyển tiền | 35,29 | 0 | 14 |
| | **Tổng** | **316.847,24** | **316.847,24** | **96** |

Đọc bảng bằng lời:

- `11202061` gần như cân bằng (Nợ 158.500 / Có 158.347,24): **tiền vào bao nhiêu thì đi ra gần hết** —
  đúng bản chất của ví trung chuyển.
- `11301001` Có 158.500 là tiền nhận về từ PayPal/Stripe; Nợ 3.493,35 là các lần rút tiếp ra ngân hàng.
- `33111002` Nợ 146.513,09 chỉ từ **4 dòng** — các khoản trả nhà cung cấp rất lớn (một dòng 60.000).
- `64200020` Nợ 35,29 trên 14 dòng: tổng phí chuyển tiền của cả kỳ mẫu, trung bình ~2,52/giao dịch.

---

## 9. Tra nhanh và tự kiểm chứng

### 9.1. Các công thức khóa

```
SourceKey       = {TransactionId}
SourceID        = PIPO|{SourceKey}
TransactionID   = {TransactionId}
EventSeq        = RuleSeq  (10 | 20 | 30)
Period          = YYYYMM của phần ngày trong cột Time
DocNum          = ASI-{yyyyMMdd}-{AccountingEventID}      (PIPO luôn Single)

AMOUNT = (|Amount| − |Fee|) × dấu(Amount)   nếu JournalTypeCode bắt đầu "BANK_PAYMENT_"
                                             hoặc = "BANK_INTERNAL_TRANSFER_TO", và Fee ≠ 0
       = Amount                              trong mọi trường hợp còn lại
FEE    = |Fee|
Amount (GL) = |Event.Amount × 1|, chiều Nợ/Có do dấu quyết định (NegativeMode = REVERSE)
```

### 9.2. Cột GLTrans đến từ đâu

| Cột GLTrans | Nguồn |
|---|---|
| `AccountCode` | 1 trong 4 cột tài khoản của event, chọn theo `NormalDr/CrAccountSource` |
| `BalanceImpact` | `Debit` / `Credit`, đảo lại nếu `Amount < 0` |
| `InputDr/Cr`, `AccountedDr/Cr` | `Event.Amount` (PIPO `AmountFactor` = 1) |
| `XRate`, `RateType` | `1` / `MUL` (USD → USD) |
| `PartnerCode` | cột `PartnerCode` của file; riêng dòng phí là `BANK` |
| `Description` | `rule.MemoTemplate` + ` \| ` + `TransactionId` |
| `ReferenceTxnID` | `TransactionId` |
| `OrderID` | luôn `null` (sao kê PingPong không gắn đơn hàng) |
| `RefNum` | `TransactionId` |
| `BankAccountNumber` | `PINGPONG1` |

### 9.3. Câu SQL soi dữ liệu

```sql
-- Chứng từ nào không cân? (kết quả rỗng là đúng)
SELECT DocNum, ROUND(SUM(AccountedDr),2) dr, ROUND(SUM(AccountedCr),2) cr
FROM GLTrans WHERE DataSource='PIPO'
GROUP BY DocNum HAVING dr <> cr;

-- Kiểm chứng quy tắc trừ phí: gốc + phí phải đúng bằng Amount của file
SELECT r.TransactionId, r.Amount AS amount_file, r.Fee AS fee_file,
       SUM(CASE WHEN e.EventSeq=10 THEN ABS(e.Amount) END) AS goc,
       SUM(CASE WHEN e.EventSeq=30 THEN ABS(e.Amount) END) AS phi
FROM RawPipo r JOIN AccountingEvent e ON e.SourceID = 'PIPO|' || r.SourceKey
WHERE r.JournalType = 'BANK_INTERNAL_TRANSFER_TO'
GROUP BY r.TransactionId;

-- Các dòng bị bỏ vì Status khác Success
SELECT TransactionId, Status, BuildStatus, BuildMessage FROM RawPipo WHERE BuildStatus='SKIPPED';
```

### 9.4. Test nào canh các con số này

| Số liệu | Test |
|---|---|
| 36 dòng import, 2 `SkippedRows`, 48 event, Dr = Cr | `tests/integration/bank-sources.test.ts` |
| `SOURCE_ROW_SKIPPED` mức INFO có chữ `Retrieved` | `tests/engine/build-bank.test.ts` |
| `BANK_PAYMENT_SELLER` dùng `11202061` / `PINGPONG1` / Contra `33102001` | `tests/engine/build-bank.test.ts` |
| `pipoAmountExcludesFee` đúng cho `BANK_PAYMENT_SELLER` và `BANK_INTERNAL_TRANSFER_TO`, **sai** cho `BANK_INTERNAL_TRANSFER_FROM`; với `{−101.01, 1.01, 100}` ra `AMOUNT ≈ −100` | `tests/engine/build-bank.test.ts` |

Chạy: `npm test`.

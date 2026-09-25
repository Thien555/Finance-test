# Đặc tả nghiệp vụ – Điền trước (PREFILL)

## 1. Mục đích tài liệu

Hiện nay, trước khi Import file sao kê PayPal, Stripe, PingPong, kế toán phải tự thêm và điền tay các cột `JournalType`, `PartnerCode`, `StoreName`, `ComCode`, `BankAccoutNumber`.

Tài liệu này mô tả quy tắc để hệ thống **tự điền các cột đó trước khi Import**, thêm cột `PartnerTaxID`, và tự tìm seller cho Orders. Dòng nào không điền được thì để trống và đưa vào **danh sách dòng lỗi**, xuất ra file kèm lý do để kế toán kiểm tra (mục 7). Đối tượng (partner) chưa có trong danh mục thì hệ thống đề xuất; kế toán duyệt, thêm vào Google Sheet rồi Sync.

## 2. Quy tắc chung

- **Tra cứu:** dùng mọi dữ liệu đã Import của mọi kỳ, không chỉ kỳ đang làm. Không bắt buộc thứ tự Import: dòng cần tra mà dữ liệu chưa có (vd PayPal chưa có đơn hàng tương ứng) thì vào danh sách dòng lỗi; Import bổ sung rồi chạy lại.
- **ComCode:** lấy từ tên file `<Nguồn>_<ComCode>.csv`, vd `Paypal_ZENIROXPAY.csv` → `ZENIROXPAY`. Công ty không có trong danh mục `Company` thì từ chối cả file.
- **BankAccoutNumber:** để trống; hệ thống dùng tài khoản mặc định của nguồn.
- **Tìm seller:** so theo **email seller + ký hiệu store** của đơn hàng. Ký hiệu store là tên store viết hoa, bỏ tiền tố nền tảng (`FFT-`, `WFF-`, `VICBEA-`, `MESI PAY-`) và bỏ chữ `FFT ` ở đầu:

| Tên trong danh mục Partners | Ký hiệu store | Ghi vào `StoreName` |
|---|---|---|
| `FFT-FFT NAC` | `NAC` | `FFT NAC` |
| `VICBEA-Lausan` | `LAUSAN` | `Lausan` |
| `MESI PAY-MS007` | `MS007` | `MS007` |

- **Đơn nhập tay** có email seller trống hoặc trùng email người mua: chỉ tìm theo ký hiệu store, không đề xuất seller mới.
- **Giá trị ghi cho seller:** `PartnerCode` = email store trong danh mục (không dùng email nhận payout), `StoreName` = tên store như bảng trên, `PartnerTaxID` = mã store trên Bettamax (StoreId) của seller.
- **Đối tượng không phải seller:** `StoreName` để trống, `PartnerTaxID` lấy từ danh mục.
- **Ô kế toán đã sửa tay:** giữ nguyên khi hệ thống điền lại.

Tài khoản nội bộ (`Pingpong ZeniroxPay`, `Paypal ZeniroxPay`…) và tên người gửi ở dòng 1 bảng PingPong hiện chỉ có cho công ty ZENIROXPAY. Công ty khác chưa khai thì để trống các ô này và đưa dòng vào danh sách dòng lỗi.

## 3. PayPal

**JournalType – cách tra:** lấy nguyên giá trị cột `Description` trong file, tìm dòng cùng tên trong danh mục JournalType của nguồn PayPal, rồi lấy mã `JournalTypeCode` của dòng đó. Không phân biệt chữ hoa/thường. `Description` không có trong danh mục thì để trống, dòng vào danh sách dòng lỗi.

Bảng tra theo danh mục hiện tại (danh mục thêm dòng thì hệ thống tự nhận):

| `Description` | `JournalType` | Nghĩa |
|---|---|---|
| Express Checkout Payment | `PP_EXPRESS_CHECKOUT_PAYMENT` | Khách thanh toán qua PayPal |
| Direct Credit Card Payment | `PP_DIRECT_CREDIT_CARD_PAYMENT` | Khách thanh toán bằng thẻ |
| General Payment | `PP_GENERAL_PAYMENT` | Nhận thanh toán khác |
| Mobile Payment | `PP_MOBILE_PAYMENT` | Nhận thanh toán qua di động |
| Payment Refund | `PP_PAYMENT_REFUND` | Hoàn tiền cho khách |
| Payment Reversal | `PP_PAYMENT_REVERSAL` | PayPal đảo ngược khoản thanh toán |
| Reserve Hold | `PP_RESERVE_HOLD` | PayPal giữ tiền dự phòng |
| Reserve Release | `PP_RESERVE_RELEASE` | PayPal nhả tiền dự phòng |
| Hold on Available Balance | `PP_HOLD_AVAILABLE_BALANCE` | PayPal giữ tiền trên số dư |
| Reversal of General Account Hold | `PP_REVERSAL_GENERAL_ACCOUNT_HOLD` | Nhả tiền giữ trên số dư |
| General Hold | `PP_GENERAL_HOLD` | Giữ tiền chung |
| General Hold Release | `PP_GENERAL_HOLD_RELEASE` | Nhả tiền giữ chung |
| Payment Review Hold | `PP_PAYMENT_REVIEW_HOLD` | Giữ tiền để PayPal xem xét giao dịch |
| Payment Review Release | `PP_PAYMENT_REVIEW_RELEASE` | Nhả tiền sau khi xem xét |
| Instant Payment Review (IPR) reversal | `PP_IPR_REVERSAL` | Đảo ngược sau khi xem xét |
| Tax Hold | `PP_TAX_HOLD` | Giữ tiền thuế |
| Tax Release | `PP_TAX_RELEASE` | Nhả tiền thuế |
| Chargeback | `PP_CHARGEBACK` | Khách khiếu nại qua ngân hàng, bị trừ tiền |
| Chargeback Fee | `PP_CHARGEBACK_FEE` | Phí chargeback |
| Chargeback Reversal | `PP_CHARGEBACK_REVERSAL` | Hoàn lại tiền chargeback |
| Hold on Balance for Dispute Investigation | `PP_HOLD_DISPUTE_INVESTIGATION` | Giữ tiền khi đang tranh chấp |
| Cancellation of Hold for Dispute Resolution | `PP_CANCEL_HOLD_DISPUTE_RESOLUTION` | Nhả tiền giữ khi tranh chấp xong |
| Dispute Fee | `PP_DISPUTE_FEE` | Phí tranh chấp |
| Partner Fee | `PP_PARTNER_FEE` | Phí đối tác |
| Payment Fee | `PP_PAYMENT_FEE` | Phí thanh toán |
| Fee Reversal | `PP_FEE_REVERSAL` | Hoàn lại phí |
| Mass Pay Payment | `PP_MASS_PAY_PAYMENT` | Trả tiền nhà cung cấp |
| User Initiated Withdrawal | `PP_USER_INITIATED_WITHDRAWAL` | Rút tiền về PingPong của công ty |
| User Initiated Currency Conversion | `PP_USER_INITIATED_CURRENCY_CONVERSION` | Đổi ngoại tệ |
| General Account Correction | `PP_GENERAL_ACCOUNT_CORRECTION` | PayPal điều chỉnh tài khoản |
| General Bonus | `PP_GENERAL_BONUS` | Tiền thưởng từ PayPal |
| PayPal Protection Bonus · Payout for PayPal Buyer Protection · Payout for Full Protection with PayPal Buyer Credit | `PP_PROTECTION_BONUS_PAYOUT` | PayPal bồi hoàn theo chương trình bảo vệ (1 mã, 3 tên) |
| General Currency Conversion | Chưa có mã: để trống | Đổi ngoại tệ; chờ kế toán chọn mã |

**Đối tượng:**

| Trường hợp | `PartnerCode` |
|---|---|
| Có `Invoice ID` (mọi loại giao dịch, kể cả giữ tiền, tranh chấp, phí) | Seller của đơn hàng |
| Không có `Invoice ID`, loại Mass Pay | Nhà cung cấp theo email ở cột `From Email Address`. Chưa có thì đề xuất nhà cung cấp mới |
| Không có `Invoice ID`, loại rút tiền (`User Initiated Withdrawal`) | `Pingpong ZeniroxPay` |
| Còn lại | Để trống |

Tìm đơn hàng lần lượt: mã đơn = `Invoice ID`; không thấy thì mã giao dịch ghi trên đơn = `Invoice ID` (đơn nhập tay); vẫn không thấy thì mã giao dịch trên đơn = `Transaction ID` của PayPal.

## 4. Stripe

**JournalType – cách tra:** lấy cột `Type` trong file rồi tra bảng dưới. Dùng bảng cố định vì danh mục ghi tên dạng `Stripe Refund`, không khớp với chữ `refund` trong file. Tiền dương hay âm cùng một `Type` vẫn ra cùng mã. `Type` không có trong bảng thì để trống, dòng vào danh sách dòng lỗi.

| `Type` | `JournalType` | Nghĩa |
|---|---|---|
| `charge` | `STRIPE_RECEIPT_CUSTOMER` | Khách thanh toán |
| `refund` | `STRIPE_REFUND` | Hoàn tiền cho khách |
| `payout` | `STRIPE_PAYOUT` | Stripe chuyển tiền về PingPong của công ty |
| `stripe_fee` | `STRIPE_FEE` | Phí Stripe |
| `adjustment` | `STRIPE_ADJUSTMENT` | Điều chỉnh do tranh chấp |
| `reserved_funds` | `STRIPE_RESERVE` | Stripe giữ hoặc nhả tiền dự phòng |

**Đối tượng:**

| Trường hợp | Kết quả |
|---|---|
| Có `invoiceId (metadata)` | Seller: tìm theo mã store ở cột `storeId (metadata)`; không có hoặc không ra seller thì tìm qua đơn hàng có mã `invoiceId` |
| Không có `invoiceId` nhưng có `Source` (vd hoàn tiền) | Lấy `invoiceId` của giao dịch charge gốc cùng `Source`, rồi làm như trên |
| `payout` | Cả 3 cột `PartnerCode`, `StoreName`, `PartnerTaxID` ghi `Pingpong ZeniroxPay` |
| Còn lại (`adjustment`, `stripe_fee`, `reserved_funds` không có hóa đơn) | Để trống |

## 5. PingPong

**JournalType – cách tra:** file PingPong không có cột nào cho biết loại giao dịch đủ chi tiết, nên hệ thống xét 3 cột: `Type` (`Send` = chuyển đi, `Receive` = nhận về, `Withdraw` = rút về ngân hàng), `From/To` (người gửi hoặc người nhận) và `Note` (ghi chú chuyển khoản). Xét bảng từ trên xuống, khớp dòng nào thì dừng:

| # | Giao dịch | Điều kiện | Ví dụ trong file | `JournalType` |
|---|---|---|---|---|
| 1 | Tiền từ PayPal, Stripe của công ty về PingPong | `Receive`, người gửi bắt đầu bằng `PAYPAL` hoặc `ZENIROXPAY INC` | From/To `ZENIROXPAY INC 30000009330076` | `BANK_INTERNAL_TRANSFER_FROM` |
| 2 | Rút về ngân hàng của công ty | `Withdraw` | From/To `Royal Bank of Canada 1019512` | `BANK_INTERNAL_TRANSFER_TO` |
| 3 | Nạp thẻ MasterCard của công ty | `Send`, người nhận chứa `PING PONG GLOBAL HOLDINGS` | From/To `PING PONG GLOBAL HOLDINGS LIMITED …` | `BANK_INTERNAL_TRANSFER_TO` |
| 4 | Trả tiền cho seller | `Send`, `Note` có chữ `payout` | Note `GGP payout den ngay 08.12.2025` | `BANK_PAYMENT_SELLER` |
| 5 | Trả tiền nhà cung cấp | `Send`, `Note` có `Sky Global` hoặc `Sky Corporation` | Note `ZeniroxPay payment for Sky Global` | `BANK_PAYMENT_SUPPLIER` |
| 6 | Không đủ thông tin (vd chuyển cho cá nhân, ghi chú trống) | Còn lại | Note `vb` hoặc trống | Để trống, dòng vào danh sách dòng lỗi |

6 mã PingPong còn lại trong danh mục (`BANK_PAYMENT_OTHER`, `BANK_PAYMENT_SALARY`, `BANK_PAYMENT_COSTSUP`, `BANK_RECEIPT_CUSTOMER`, `BANK_RECEIPT_OTHER`, `BANK_BANK_FEE`) không tự điền; kế toán chọn tay khi cần.

**Đối tượng:**

| `JournalType` | `PartnerCode` |
|---|---|
| `BANK_PAYMENT_SELLER` | Seller có ký hiệu store là chữ đứng ngay trước `payout` trong `Note`. Vd `GGP payout den ngay 08.12.2025` → ký hiệu `GGP` → seller `FFT-FFT GGP`: `PartnerCode` = `manh020901@gmail.com`, `StoreName` = `FFT GGP` |
| `BANK_INTERNAL_TRANSFER_FROM` | Người gửi `PAYPAL…` → `Paypal ZeniroxPay`. Còn lại, đối chiếu số tiền với payout Stripe và lệnh rút tiền PayPal từ 7 ngày trước đến chính ngày nhận → `Stripe ZeniroxPay` hoặc `Paypal ZeniroxPay` |
| `BANK_INTERNAL_TRANSFER_TO` | Rút về `ROYAL BANK` → `Royal Bank`; nạp thẻ → `MasterCard ZENIROXPAY` |
| `BANK_PAYMENT_SUPPLIER` | `Sky Global` → `SKYGLOBAL`; `Sky Corporation` → `SKYCORP` |

## 6. Orders

- Orders không cần điền cột nào trước khi Import. Cách hạch toán và cách xác định công ty theo cổng thanh toán giữ như hiện tại.
- Với mỗi dòng sẽ được ghi sổ, tìm seller theo mục 2. Seller chưa có trong danh mục thì đề xuất seller mới, vd `VICBEA-Nattozyme`.
- Bước ghi sổ Orders cũng phải tìm seller theo đúng quy tắc này.

## 7. Dòng lỗi và xuất file kiểm tra

Dòng nào hệ thống không điền được (`JournalType`, `PartnerCode`…), hoặc điền được nhưng cần kế toán xem lại (vd seller mới chờ duyệt), thì được đưa vào **danh sách dòng lỗi**. Ô không điền được để trống. Kế toán xem được danh sách trên màn hình và **xuất ra file Excel/CSV** để kiểm tra.

File xuất gồm toàn bộ dữ liệu gốc của dòng lỗi, thêm các cột:

| Cột | Nội dung |
|---|---|
| Nguồn | PayPal, Stripe, PingPong hoặc Orders |
| Dòng số | Vị trí dòng trong file (Orders: `ItemCode`) |
| Mã giao dịch | `Transaction ID` (PayPal), `id` (Stripe), `TransactionId` (PingPong), `OrderId` (Orders) |
| Cột cần xem | vd `JournalType`, `PartnerCode` |
| Lý do | Viết dễ hiểu, theo bảng dưới |

Các lý do thường gặp:

| Lý do | Cột | Kế toán xử lý |
|---|---|---|
| Loại giao dịch không có trong danh mục (`Description` PayPal, `Type` Stripe lạ) | `JournalType` | Chọn mã tay, hoặc thêm loại nghiệp vụ vào Google Sheet |
| Giao dịch PingPong không khớp quy tắc nào (dòng 6) | `JournalType`, `PartnerCode` | Điền tay |
| Không tìm thấy đơn hàng theo `Invoice ID` / `invoiceId` | `PartnerCode` | Kiểm tra đơn đã Import chưa, hoặc tra đơn tay |
| Không tìm thấy seller theo ký hiệu store, hoặc tìm ra nhiều seller | `PartnerCode` | Kiểm tra danh mục Partners, tra Bettamax |
| Seller, nhà cung cấp chưa có trong danh mục (đã điền email, chờ duyệt đề xuất) | `PartnerCode` | Duyệt đề xuất, thêm vào Google Sheet rồi Sync |
| Không tìm thấy payout Stripe / lệnh rút PayPal khớp khoản nhận PingPong | `PartnerCode` | Kiểm tra đã Import PayPal, Stripe chưa |
| Công ty chưa khai tài khoản nội bộ | `PartnerCode` | Bổ sung tài khoản nội bộ cho công ty |

Sửa xong thì chạy lại Điền trước: ô kế toán đã sửa tay được giữ nguyên, dòng đã hết lỗi tự ra khỏi danh sách.

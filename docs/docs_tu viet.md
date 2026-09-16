AccountingEvent là bảng trung gian ghi lại: “Từ dữ liệu gốc này, cần ghi sổ những khoản gì, bao nhiêu tiền, cho ai?”
Ví dụ một đơn hàng
RawOrders chứa rất nhiều thông tin: sản phẩm, số lượng, địa chỉ, ngày giao, giá bán, phí ship, seller…
Build đọc đơn đó và tạo 3 event:
Event Khoản cần ghi nhận Số tiền
1 Doanh thu tiền hàng 34.99
2 Doanh thu ship và phụ phí 7.99
3 Phần phải trả seller 19.32

Mỗi event còn lưu công ty, ngày ghi sổ, tài khoản theo vai trò, partner và mã đơn gốc.
Đến bước Post, hệ thống dùng các event này để sinh dòng Nợ/Có trong GLTrans.
Tại sao cần bảng này?

1. Kiểm tra trước khi ghi sổ
   Ví dụ chưa tìm được seller thì event phần chia seller bị đánh dấu lỗi để xử lý.
2. Giữ chi tiết khi GL đã gom tổng
   GL có thể chỉ ghi doanh thu ngày hôm đó = 1,246.29 USD. AccountingEvent giữ chi tiết để biết tổng đó gồm những đơn nào, mỗi đơn đóng góp bao nhiêu.
3. Theo dõi khoản nào đã ghi sổ
   NEW là đang chờ; POSTED là đã ghi và có mã chứng từ để tra.
Kết quả kiểm tra bút toán trên 55,112 order thật
Tóm lại
Engine ghi đúng theo quy tắc đang cấu hình. Một agent tự viết lại logic từ đầu (không đọc code engine) và đối soát từng dòng với kết quả của app:

Tầng	Kết quả đối soát độc lập
Import	55,111 / 55,111 dòng khớp 100% trên 15 cột kế toán
AccountingEvent	129,221 event khớp tuyệt đối: số tiền, partner, TaxID, trạng thái
GLTrans	3,178 chứng từ / 6,356 dòng khớp từng dòng; Σ Nợ = Σ Có = 3,479,338.74
Khác	Mọi chứng từ cân; không seller nào bị gán nhầm mà không báo lỗi; không đơn test nào lọt vào sổ; không sai số làm tròn
Nhưng sổ hiện tại chưa đúng và chưa đủ về mặt kế toán. Nguyên nhân không phải lỗi tính toán, mà là: thiếu master data, một số quy tắc nghiệp vụ không khớp với dữ liệu thật, dữ liệu nguồn có vấn đề, và 1 lỗi engine nguy hiểm cần sửa trước khi đổi mapping. GL mới phủ 85.7% doanh thu của các đơn FULFILLED.

A. Chưa lên sổ vì thiếu master data
1. 8 cổng thanh toán chưa map ComCode. 9,007 đơn FULFILLED bị bỏ ngoài sổ: doanh thu 381,293.42 và lợi nhuận seller 224,249.94. Không nên map hết về ZENIROXPAY: cột 47 không có tiêu đề trong file (chỉ có dữ liệu ở tháng 1/2026) gợi ý các cổng thuộc 2 nhóm pháp nhân khác nhau.

Nhãn cột 47	Cổng	Dòng lỗi	TotalPrice
fft (cùng nhóm với Inc./Stripe)	GA Key, GA 2	6,655	244,821.74
vic (chỉ seller Vicbea)	Key, Vicbea-Stripe, Vicbea, ZeniroxPay #599	2,329	126,724.32
messipay	ZeniroxPay #602	10	750.00
không có nhãn	Koro, Mr.Oakly	13	753.22
Nhóm Vicbea còn 2 vấn đề riêng. Profit của nhóm này không theo công thức chung (khoảng 1.05–1.07 lần, có đơn Profit −936.02). Tên partner dạng VICBEA-{Store} mà matcher không nhận, nên nếu map sẽ phát sinh 2,342 lỗi seller.

2. Seller thiếu trong Partners. 12 seller mới (onboard từ 3–4/2026) chưa có trong Partners: 480 event, 13,870.66. Thêm 2 seller có cả FFT-FFT ACZ/HBC và FFT-OLD ACZ/HBC: 46 event, 964.87, cần bạn chọn store. Hệ quả: 526 đơn đã ghi doanh thu nhưng thiếu chi phí seller, làm lãi gộp bị thổi phồng 14,835.53 (76% rơi vào 202604).

B. Quy tắc nghiệp vụ lệch với dữ liệu thật (cần bạn chốt)
3. Doanh thu = Quantity × UnitPrice, trong khi Profit seller tính trên TotalPrice.

931 đơn có TotalPrice ≠ Q×U + Ship, lệch ròng +37,797.66. 816 đơn TotalPrice cao hơn: mua thêm hoặc upsell mà Quantity không ghi. 115 đơn thấp hơn: giảm giá khi mua nhiều.
Hậu quả: 624 đơn có chi phí seller lớn hơn doanh thu đã ghi sổ. Ví dụ 15196-191125-PVXFS ghi doanh thu 59.99 + 4.99 nhưng TotalPrice 199.96 và Profit 99.49.
4. AdditionalCost (836 đơn quốc tế, 4,000.00). Khách không trả khoản này: nó không nằm trong TotalPrice, và thuế Canada cũng không tính trên nó. Khoản này đã được trừ vào Profit seller, nhưng engine vẫn ghi Nợ 13122001 / Có 51131001, tức ghi thừa 4,000. Tài liệu MAPPING của bạn từng cảnh báo điểm này; nay đã xác nhận trên dữ liệu thật.

5. Extra Fee (133 đơn). Profit trống nên engine coi là 0: 2,352 ghi vào 51112001, không trả seller, và chỉ báo INFO. Cần chốt đây là doanh thu của công ty hay phải trả seller.

6. Cột TaxID trên order thực ra là mã thuế của người mua (RFC Mexico, hoặc người mua gõ "No", "Norway"...). Engine lại dùng cột này làm ưu tiên số 1 để tìm seller, nên có rủi ro khớp nhầm partner như TAX hay PAYPAL. Hiện ảnh hưởng 0 USD.

C. Dữ liệu nguồn
7. File là các bản chụp theo tháng, trạng thái bị "đóng băng" lúc export.

2,673 đơn UNFULFILLED. Riêng đơn trả tiền 29–31/01/2026 thì 100% UNFULFILLED, gần như chắc đã giao sau đó nhưng chưa bao giờ được ghi doanh thu (phần thuộc ZENIROXPAY: 71,243.85). → Cần export lại.
Không có đơn nào trả tiền từ 27/11 đến 04/12/2025, ước tính thiếu khoảng 2,000 đơn.
8. Múi giờ. FulfilledAt lệch khoảng 8 giờ so với LastUpdatedAt. 159 đơn (11,706.36) nằm ở ranh giới tháng, có thể đang vào nhầm kỳ. Cần chốt múi giờ ghi sổ.

9. Các lỗi nhỏ:

Dòng 27342 là mảnh rời có Profit −12.99, bị bỏ qua.
#MS0091001 FULFILLED nhưng thiếu ngày và Quantity.
48 đơn Canada không có thuế.
56 nhóm nghi khách thanh toán trùng (2,715.07).
Cột 47/48 không có tiêu đề bị bỏ qua mà không cảnh báo.
D. Lỗi engine và vận hành
10. ⚠️ Lỗi nghiêm trọng: ghi sổ trùng. Nếu đổi GatewayCompanyMapping của một cổng đã post, lần Build sau tạo event mới dưới ComCode mới, trong khi event cũ vẫn POSTED. Không có cảnh báo nào. Mô phỏng đổi "ZeniroxPay - Stripe" sang ONTARIO: 495 đơn bị ghi trùng, 35,801.60. Tôi đã đối chiếu với code build.ts và xác nhận đúng: khóa event có chứa ComCode, và event POSTED không bị đụng tới. Vì vậy chưa được đổi mapping của cổng đã post cho tới khi sửa lỗi này.

11. Không khóa kỳ. Khi bổ sung mapping, 24,668 event (520,562.08) sẽ được ghi lùi vào 6 kỳ đã qua, và 196 PostingGroupKey bị tách thành 2 chứng từ.

12. Bộ nhớ. Import file 20MB cần khoảng 2.3–2.7GB RAM. Nếu heap Node chỉ 1GB thì server Next.js chết hẳn: lỗi hết bộ nhớ của Node không bắt được bằng try/catch.

Về mức độ kiểm chứng: các phát hiện A–C và mục 12 đều đã có người phản biện chạy lại độc lập. Mục 10–11 do agent rà soát cuối mô phỏng trên bản sao DB; riêng mục 10 tôi đã tự đối chiếu thêm với code.

Đề xuất thứ tự xử lý
Việc tôi làm được ngay, không cần chờ quyết định nghiệp vụ:
Sửa lỗi ghi trùng khi đổi mapping (mục 10).
Cho importer cảnh báo cột không tiêu đề, thiếu Quantity, Profit trống.
Bỏ ưu tiên cột TaxID khi tìm seller.
Đọc Excel dạng stream để giảm RAM.
Tất cả kèm test.
Việc bạn và kế toán cần chốt:
Map 8 cổng về ComCode nào (dùng bảng nhãn fft/vic ở mục 1).
Doanh thu tính theo TotalPrice hay Q×U.
Cách xử lý AdditionalCost và Extra Fee.
Múi giờ ghi sổ.
Store FFT-OLD.
Dữ liệu: xin export lại các tháng với trạng thái hiện tại, gồm cả khoảng 27/11–04/12/2025; cập nhật sheet Partners.
Bạn muốn tôi làm bước 1 luôn không? Tôi cũng có thể viết toàn bộ 45 phát hiện ra một file báo cáo chi tiết. File đó chứa email seller và số tiền thật, nên tôi sẽ để ngoài git.

Kết quả đầy đủ của workflow đang ở scratchpad (real/audit-result.json), cùng DB tạm real/full.db chứa dữ liệu thật. Nhắc lại: nên thêm docs/full-order.xlsx vào .gitignore.
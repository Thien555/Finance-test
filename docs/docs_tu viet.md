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

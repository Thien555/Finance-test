Tài liệu viết cho: kế toán/BA duyệt quy tắc, và AI/dev sẽ code bước tự điền.

Tài liệu đã xong: docs/BA_PREFILL_SOURCES.md, một file gồm phần quy tắc chung và 4 phần PayPal, Stripe, PingPong, Orders. Không sửa dòng code nào; tôi cũng chưa commit.

Mọi con số trong tài liệu được hai lần cài đặt độc lập chạy lại trên 4 file mẫu và khớp nhau. Sau đó có 2 vòng review, gồm một agent chỉ đọc tài liệu rồi thử code theo; mọi chỗ còn phải đoán đã được sửa.

Công thức suy ra từ dữ liệu mẫu

Nguồn JournalType Partner Khớp mẫu
PayPal Tra Description theo master (22 giá trị) Có Invoice ID → tìm đơn → seller. Mass Pay → supplier theo email. Rút tiền → Pingpong ZeniroxPay JournalType 142.658/142.659
Stripe Bảng Type → mã (6 loại) storeId hoặc invoice → seller. Payout → Pingpong ZeniroxPay 1.413/1.413
PingPong 6 quy tắc theo thứ tự (Type, From/To, Note) Mã store trong Note → seller. Khoản nhận về → đối chiếu với payout Stripe / lệnh rút PayPal 926/952; 26 dòng chờ điền tay
Orders Giữ 4 mã như code hiện tại Tìm seller theo (email, mã store) 52.434/52.437 dòng có seller
ComCode: lấy phần sau dấu \_ cuối của tên file, phải có trong bảng Company.
Partner mới: cả 4 nguồn chỉ cần thêm 2 partner: seller VICBEA-Nattozyme và supplier treasury@freshworks.com.
Chỗ tài liệu làm khác quy tắc bạn đưa ra, vì dữ liệu cho thấy làm đúng câu chữ sẽ sai

PingPong Send không có chữ "payout": không gán hết là SUPPLIER. 13 dòng nạp thẻ MasterCard được xếp vào chuyển nội bộ. 26 dòng không có mã store (HUI, Vicbea) để trống kèm cờ cho kế toán điền tay. Làm đúng câu chữ sẽ sai 39 dòng.
Mã store của PingPong: lấy chữ đứng ngay trước "payout", không lấy 3 ký tự đầu, vì cách 3 ký tự hỏng ở MS007. Bettamax chưa có tích hợp, nên tạm tra Partners master: ra đúng 143/143 mã.
Chuyển nội bộ về PingPong: không tách được PayPal với Stripe chỉ bằng From/To, vì hai bên ghi giống nhau. Phải đối chiếu số tiền với payout Stripe và lệnh rút PayPal, kết quả khớp 84/84.
PayPal không có Invoice ID: chỉ nhánh Mass Pay mới tra/thêm supplier theo email.
Theo các lựa chọn bạn đã chốt, tài liệu ghi rõ số dòng lệch với file mẫu:

PartnerCode: dùng email store thay vì email nhận payout như file mẫu, nên lệch 34.640 dòng PayPal và 408 dòng PingPong.
StoreName: ghi tên đầy đủ (FFT NAC, Lausan), trong khi mẫu ghi tên rút gọn và gộp cả nhóm Vicbea thành Vicbea.
Phát hiện quan trọng

2.388 lỗi thiếu partner của Orders: chỉ 3 là thiếu partner thật. 2.385 lỗi còn lại do hàm so tên store: không nhận tiền tố VICBEA-, và bắt nhầm các store FFT-OLD. Phải sửa hàm này trước khi cho tự thêm partner, nếu không sẽ sinh partner trùng.
Partner tự thêm sẽ mất khi bấm Sync master, vì Sync xóa rồi nạp lại toàn bộ Partners. Mặc định trong tài liệu: xuất danh sách đề xuất → dán lên Google Sheet → Sync.
File order export chưa có cột mã store (idStore). Cột TaxID hiện có là mã thuế người mua tự gõ, không dùng được.
Tên file mẫu Bank_Paypal.csv sẽ ra ComCode là PAYPAL, không phải mã công ty. File thô cần đặt tên theo dạng Paypal_ZENIROXPAY.csv.
File khác đã sửa (chỉ tài liệu)

CLAUDE.md: thêm 1 dòng link tới tài liệu mới.
DEVELOPER_GUIDE.md: thêm link ở §6.11, và thêm 3 bug phát hiện được vào §13.3 (#18–#20).
§9 còn 20 câu hỏi mở cho kế toán, mỗi câu kèm giá trị mặc định tài liệu đang dùng. Các câu cần chốt sớm nhất:

charge của Stripe ghi mã STRIPE_CHARGE (theo tài liệu gốc) hay STRIPE_RECEIPT_CUSTOMER (theo file mẫu, mã này chỉ có trong seed)?
Tên cột mã store sẽ thêm vào file order export.
Store ACZ/HBC thuộc FFT-FFT hay FFT-OLD.
26 dòng PingPong không có mã store trả cho seller nào.

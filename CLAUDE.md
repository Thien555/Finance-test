@AGENTS.md

# Sky Finance – Accounting Engine

Web kế toán cho công ty dropshipping: **file thô → bảng Raw → (Build) AccountingEvent → (Post) GLTrans**, mỗi lần post có PostingBatch. 4 nguồn: **Orders**, **PAYPAL**, **STRIPE**, **PIPO**. Quy tắc ghi sổ điều khiển bởi master data (JournalType, JournalLineRule, Partners, CoA, Exrate, MappingBankAccount) snapshot từ Google Sheet. Next.js 16 (App Router, FE + Route Handlers) · antd 6 · SQLite (better-sqlite3 + Drizzle) · không auth.

**Tài liệu chi tiết: [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md)** — đọc mục liên quan trước khi sửa. Yêu cầu nghiệp vụ gốc: `tai lieu du an.md`.

## Lệnh

- `npm run dev` – dev server (lần đầu tự migrate + seed `data/finance.db`)
- `npm test` · `npx tsc --noEmit` · `npm run lint` · `npm run build`
- `npm run db:generate` (sau khi sửa schema) · `npm run db:seed` · `npm run db:clear` (xóa dữ liệu giao dịch, giữ master) · `npm run db:reset` (xóa hẳn file DB, tắt dev server trước)
- `npm run audit -- orders|paypal|stripe|pipo` – đo lại baseline trên DB riêng (in số liệu để ghi vào rule 9 + guide §10.2)
- `npm run db:export-seed` – ghi Company/GatewayCompanyMapping (sửa trên web, không có trong sheet) từ DB ra `data/seed` để commit

## Bản đồ code

- `src/lib/engine/` – logic nghiệp vụ thuần, không DB (`build-orders.ts`, `build-bank.ts` + `sources/*.ts` cho 3 nguồn ngoài Orders, `reconcile-events.ts`, `post.ts`, `post-guard.ts`, `resolve-partner.ts`, `resolve-fx.ts`, `keys.ts`, `parse.ts`, `masters.ts`)
- `src/lib/services/` – đọc/ghi DB, transaction, batch log (`import-orders`, `import-source`, `build`, `build-source`, `post`, `clear`, `queries`, `export`, `master`)
- `src/app/api/**/route.ts` – route mỏng, bọc `handle()` từ `src/lib/api.ts`
- `src/app/**/page.tsx` – màn hình client antd; helper ở `src/components/client.ts`, `src/components/ui.tsx`
- `src/lib/db/schema.ts` – 18 bảng, tên cột giữ đúng như sheet (kể cả khoảng trắng và typo `BankAccoutNumber`) · `drizzle/` – migration
- `tests/` – vitest (engine + integration trên DB tạm) · `data/seed/` – master CSV · `data/samples/` – **4 file dữ liệu thật** (`order-data.csv`, `Bank_Paypal.csv`, `Bank_Stripe.csv`, `Bank_Pipo.csv`) + 3 CSV tham chiếu

## Quy tắc bắt buộc

1. Quy tắc kế toán chỉ đặt trong `src/lib/engine` và phải có test; route/page không chứa nghiệp vụ.
2. Tiền tính bằng `decimal.js`, làm tròn 2 số lẻ (ROUND_HALF_UP). So khớp mã: trim + uppercase.
3. Page client không import module kéo `node:*`, `exceljs`, `better-sqlite3`; chỉ `import type` từ services. Hằng dùng chung đặt ở `src/lib/orders/columns.ts`, `src/lib/sources/columns.ts`, `src/lib/gl-columns.ts`, `src/lib/field-docs.ts`.
4. Đổi schema → `npm run db:generate`. Transaction better-sqlite3 là đồng bộ, không `await` trong `db.transaction`.
5. antd v6: `orientation` (không `direction`), Alert `title`, Steps `content`, Drawer `size`, `destroyOnHidden`, `App.useApp()`; không dùng Modal `forceRender`.
6. Lỗi input người dùng → `throw new BadRequestError()` (`src/lib/errors.ts`) để API trả 400.
7. Route tĩnh cùng cấp `src/app/api/master/[table]` sẽ che route động → tự khai báo đủ method.
8. Thêm ExceptionType → cập nhật `src/lib/engine/types.ts`, `TYPE_DOCS` trong `src/app/exceptions/page.tsx`, bảng §6.8 của guide. Thêm cột GL/Event → `gl-columns.ts` + `field-docs.ts`.
9. Sau khi sửa: chạy `npm test` (~10 phút, chạy trên file dữ liệu thật), `npx tsc --noEmit`, `npm run lint`. **Baseline: Orders 55.111 dòng → 156.233 event (2.388 ERROR thiếu partner) → 3.397 chứng từ / 6.794 dòng GL, Σ Nợ = Σ Có = 4.013.848,04.** PayPal 142.659 → 198.243 event / 4.778 chứng từ / Σ 6.986.394,87; Stripe 1.413 → 2.712 / 287 / Σ 123.799,26; PIPO 952 → 968 / 968 / Σ 3.223.254,07. Đo lại bằng `npm run audit`. Lệch mà không cố ý đổi nghiệp vụ là bug.
11. Thêm nguồn dữ liệu: khai báo `BankSourceSpec` trong `src/lib/engine/sources/`, **không** viết quy tắc kế toán ở đó — chúng nằm trong `build-bank.ts` (guide §11.1). JournalType phải có dòng đúng `DataSource` mới, nếu không `classifyOf` trả null và event không bao giờ post được.
12. `SourceKey` của bảng raw **không được phụ thuộc cột người dùng điền tay** (`JournalType`, `PartnerCode`, …) — đó là cơ chế chống ghi sổ trùng của 3 nguồn ngoài Orders (guide §6.11.3, §6.11.6).
10. Thay đổi hành vi → cập nhật `docs/DEVELOPER_GUIDE.md` trong cùng lần sửa.

## Đọc mục nào trong guide

| Việc | Mục |
|---|---|
| Import file, parse số/ngày | §6.1 |
| Công thức sinh event, map seller/ComCode | §6.2 |
| Nợ/Có, Single/Bulk, DocNum, tỷ giá | §6.3 |
| Unpost/Unbuild | §6.4 |
| API | §7 |
| UI/antd | §8 |
| Build PayPal/Stripe/PIPO | §6.11 |
| Một dòng sao kê PayPal/Stripe/PingPong ra Nợ/Có nào (có ví dụ, số liệu thật) | [`docs/MAPPING_PAYPAL_TO_GLTRANS.md`](docs/MAPPING_PAYPAL_TO_GLTRANS.md) · [`STRIPE`](docs/MAPPING_STRIPE_TO_GLTRANS.md) · [`PIPO`](docs/MAPPING_PIPO_TO_GLTRANS.md) |
| Thêm nguồn dữ liệu mới | §11.1 |
| Lỗi thường gặp, câu SQL soi dữ liệu | §12 |
| Giả định, hạn chế, **bug đã biết chưa sửa** | §13 (bug: §13.3) |

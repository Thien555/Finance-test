@AGENTS.md

# Sky Finance – Accounting Engine

Web kế toán cho công ty dropshipping: **file order thô → RawOrders → (Build) AccountingEvent → (Post) GLTrans**, mỗi lần post có PostingBatch. Hiện chỉ làm nguồn **Orders**; quy tắc ghi sổ điều khiển bởi master data (JournalType, JournalLineRule, Partners, CoA, Exrate) snapshot từ Google Sheet. Next.js 16 (App Router, FE + Route Handlers) · antd 6 · SQLite (better-sqlite3 + Drizzle) · không auth.

**Tài liệu chi tiết: [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md)** — đọc mục liên quan trước khi sửa. Yêu cầu nghiệp vụ gốc: `tai lieu du an.md`.

## Lệnh

- `npm run dev` – dev server (lần đầu tự migrate + seed `data/finance.db`)
- `npm test` · `npx tsc --noEmit` · `npm run lint` · `npm run build`
- `npm run db:generate` (sau khi sửa schema) · `npm run db:seed` · `npm run db:reset` (tắt dev server trước)

## Bản đồ code

- `src/lib/engine/` – logic nghiệp vụ thuần, không DB (`build-orders.ts`, `reconcile-events.ts`, `post.ts`, `post-guard.ts`, `resolve-partner.ts`, `resolve-fx.ts`, `keys.ts`, `parse.ts`, `masters.ts`)
- `src/lib/services/` – đọc/ghi DB, transaction, batch log (`import-orders`, `build`, `post`, `clear`, `queries`, `export`, `master`)
- `src/app/api/**/route.ts` – route mỏng, bọc `handle()` từ `src/lib/api.ts`
- `src/app/**/page.tsx` – màn hình client antd; helper ở `src/components/client.ts`, `src/components/ui.tsx`
- `src/lib/db/schema.ts` – 15 bảng, tên cột giữ đúng như sheet · `drizzle/` – migration
- `tests/` – vitest (engine + integration trên DB tạm) · `data/seed/` – master CSV · `data/samples/` – order mẫu + output tham chiếu

## Quy tắc bắt buộc

1. Quy tắc kế toán chỉ đặt trong `src/lib/engine` và phải có test; route/page không chứa nghiệp vụ.
2. Tiền tính bằng `decimal.js`, làm tròn 2 số lẻ (ROUND_HALF_UP). So khớp mã: trim + uppercase.
3. Page client không import module kéo `node:*`, `exceljs`, `better-sqlite3`; chỉ `import type` từ services. Hằng dùng chung đặt ở `src/lib/orders/columns.ts`, `src/lib/gl-columns.ts`, `src/lib/field-docs.ts`.
4. Đổi schema → `npm run db:generate`. Transaction better-sqlite3 là đồng bộ, không `await` trong `db.transaction`.
5. antd v6: `orientation` (không `direction`), Alert `title`, Steps `content`, Drawer `size`, `destroyOnHidden`, `App.useApp()`; không dùng Modal `forceRender`.
6. Lỗi input người dùng → `throw new BadRequestError()` (`src/lib/errors.ts`) để API trả 400.
7. Route tĩnh cùng cấp `src/app/api/master/[table]` sẽ che route động → tự khai báo đủ method.
8. Thêm ExceptionType → cập nhật `src/lib/engine/types.ts`, `TYPE_DOCS` trong `src/app/exceptions/page.tsx`, bảng §6.8 của guide. Thêm cột GL/Event → `gl-columns.ts` + `field-docs.ts`.
9. Sau khi sửa: chạy `npm test`, `npx tsc --noEmit`, `npm run lint`. **Baseline với order mẫu: 174 AccountingEvent → 21 chứng từ / 42 dòng GL, Σ Nợ = Σ Có = 6,339.70.** Lệch mà không cố ý đổi nghiệp vụ là bug.
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
| Thêm nguồn PayPal/Stripe/PIPO/AccountingSource | §11.1 |
| Lỗi thường gặp, câu SQL soi dữ liệu | §12 |
| Giả định, hạn chế, **bug đã biết chưa sửa** | §13 (bug: §13.3) |

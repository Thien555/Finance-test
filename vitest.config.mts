import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Test chạy trên file dữ liệu thật (order 55k dòng, PayPal 142k dòng) nên:
 *  - `testTimeout`/`hookTimeout` tính bằng phút, không phải giây.
 *  - `fileParallelism: false`: 2 suite nặng chạy song song là 2 × ~10GB RSS → OOM.
 *  - project **engine**: `isolate: false` + `singleFork` để mọi file test dùng chung 1 tiến trình,
 *    nhờ đó cache parse trong tests/helpers/fixtures.ts có tác dụng (parse lại mỗi file mất ~70s).
 *  - project **integration**: bắt buộc `isolate: true` — mỗi file tự set `DATABASE_PATH` ở module scope
 *    còn `getDb()` cache connection trên `globalThis`, dùng chung tiến trình là dính DB của file khác.
 *
 * Heap: `npm test` đã bọc `cross-env NODE_OPTIONS=--max-old-space-size=12288` (tiến trình con kế thừa).
 */
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    pool: "forks",
    projects: [
      {
        resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
        test: {
          name: "engine",
          include: ["tests/engine/**/*.test.ts"],
          environment: "node",
          testTimeout: 600_000,
          hookTimeout: 600_000,
          isolate: false, // dùng chung 1 tiến trình cho mọi file engine → cache parse có tác dụng
          pool: "forks",
          maxWorkers: 1,
        },
      },
      {
        resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          testTimeout: 600_000,
          hookTimeout: 600_000,
          isolate: true,
          fileParallelism: false,
          pool: "forks",
          maxWorkers: 1,
        },
      },
    ],
  },
});

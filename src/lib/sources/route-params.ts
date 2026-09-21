import { BadRequestError } from "@/lib/errors";
import { SOURCE_KEYS, type SourceKey } from "./columns";

/** Đọc tham số [source] trên URL; sai tên → 400 chứ không 500 */
export function parseSourceKey(value: string | null | undefined): SourceKey {
  const key = (value ?? "").trim().toLowerCase();
  if ((SOURCE_KEYS as readonly string[]).includes(key)) return key as SourceKey;
  throw new BadRequestError(`Nguồn "${value ?? ""}" không hợp lệ. Chọn: ${SOURCE_KEYS.join(", ")}`);
}

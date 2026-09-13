/** Helper cho Route Handlers */
import { NextResponse } from "next/server";
import { BadRequestError } from "@/lib/errors";
import type { Scope } from "@/lib/services/common";

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** Bọc handler: lỗi input → 400, lỗi không mong muốn → 500 */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response> | Response) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof BadRequestError) return fail(err.message, 400);
      console.error(err);
      return fail(err instanceof Error ? err.message : String(err), 500);
    }
  };
}

type Source = URLSearchParams | Record<string, unknown>;

function read(source: Source, key: string): string | null {
  const v = source instanceof URLSearchParams ? source.get(key) : source[key];
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

export const str = read;

export function int(source: Source, key: string): number | null {
  const v = read(source, key);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function bool(source: Source, key: string): boolean {
  const v = read(source, key);
  return v === "1" || v === "true";
}

const PERIOD = /^\d{6}$/;

export function parseScope(source: Source): Scope {
  const periodFrom = read(source, "periodFrom");
  const periodTo = read(source, "periodTo");
  for (const p of [periodFrom, periodTo]) {
    if (p && !PERIOD.test(p)) throw new BadRequestError(`Kỳ "${p}" phải có dạng YYYYMM`);
  }
  return {
    comCode: read(source, "comCode")?.toUpperCase() ?? null,
    periodFrom,
    periodTo,
    dataSource: read(source, "dataSource"),
  };
}

export function paging(source: Source) {
  return { page: int(source, "page") ?? 1, pageSize: int(source, "pageSize") ?? 50 };
}

export async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function xlsxResponse(buffer: Buffer, fileName: string) {
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
    },
  });
}

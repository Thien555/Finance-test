"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function toQuery(params: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "") continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

async function parse<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export async function getJson<T>(url: string): Promise<T> {
  return parse<T>(await fetch(url, { cache: "no-store" }));
}

export async function postJson<T>(url: string, body: unknown = {}, method = "POST"): Promise<T> {
  return parse<T>(
    await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  );
}

export async function deleteJson<T>(url: string): Promise<T> {
  return parse<T>(await fetch(url, { method: "DELETE" }));
}

/** GET dữ liệu, tự load lại khi url đổi */
export function useApi<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    if (!url) return;
    const id = ++seq.current;
    setLoading(true);
    try {
      const d = await getJson<T>(url);
      if (id === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (id === seq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch dữ liệu khi url đổi
    void reload();
  }, [reload]);

  return { data, loading, error, reload };
}

export interface FilterOptions {
  comCodes: { value: string; label: string | null }[];
  journalTypeCodes: { value: string; dataSource: string }[];
  periods: string[];
  postBatches: { value: number; classify: string; status: string }[];
}

export function useOptions() {
  return useApi<FilterOptions>("/api/options");
}

export const money = (v: number | null | undefined) =>
  v === null || v === undefined ? "" : v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

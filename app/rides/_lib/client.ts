/** Browser-side JSON fetch that surfaces the API's { error } message. */
export async function api<T = unknown>(url: string, init?: { method?: string; body?: unknown; keepalive?: boolean }): Promise<T> {
  const res = await fetch(url, {
    method: init?.method ?? "POST",
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
    keepalive: init?.keepalive,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data as { error?: string }).error ?? `HTTP ${res.status}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return data as T;
}

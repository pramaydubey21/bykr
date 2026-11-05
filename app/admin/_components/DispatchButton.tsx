"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/** POST /api/admin/alerts/dispatch — one alert, or every PENDING one when alertId is omitted. */
export default function DispatchButton({
  alertId,
  label,
  disabled,
}: {
  alertId?: number;
  label: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const run = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/alerts/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(alertId != null ? { alertId } : {}),
      });
      const body = await res.json().catch(() => ({}));
      setMsg(res.ok ? `Dispatched ${body.dispatched?.length ?? 0} alert(s)` : body.error ?? `Error ${res.status}`);
      startTransition(() => router.refresh());
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-2">
      <button
        onClick={run}
        disabled={busy || disabled}
        className="whitespace-nowrap rounded-md border border-neutral-300 px-3 py-1 text-xs font-medium hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-800"
      >
        {busy ? "Dispatching…" : label}
      </button>
      {msg && <span className="text-xs text-neutral-500">{msg}</span>}
    </span>
  );
}

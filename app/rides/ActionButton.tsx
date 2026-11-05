"use client";
/** A button that POSTs/DELETEs to the ride API, then refreshes or navigates. */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { api } from "./_lib/client";

export default function ActionButton({
  url,
  method = "POST",
  label,
  busyLabel,
  confirm,
  redirectTo,
  className,
  onDone,
}: {
  url: string;
  method?: "POST" | "DELETE";
  label: string;
  busyLabel?: string;
  confirm?: string;
  redirectTo?: string;
  className?: string;
  onDone?: (result: unknown) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function run() {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api(url, { method });
      onDone?.(result);
      startTransition(() => {
        if (redirectTo) router.push(redirectTo);
        router.refresh();
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className={
          className ??
          "rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
        }
      >
        {busy ? (busyLabel ?? "Working…") : label}
      </button>
      {error && <span className="mt-1 text-xs text-red-600">{error}</span>}
    </span>
  );
}

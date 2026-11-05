"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Notice } from "@/components/ui";

async function call(url: string, method: string, body?: unknown): Promise<string | null> {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.ok) return null;
  const data = await res.json().catch(() => ({}));
  return data.error ?? `Request failed (${res.status})`;
}

export function AddFriendForm() {
  const router = useRouter();
  const [msg, setMsg] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [pending, start] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const email = String(new FormData(form).get("email") ?? "");
    start(async () => {
      const res = await fetch("/api/friends", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ tone: "error", text: data.error ?? "Could not send the request." });
        return;
      }
      setMsg({
        tone: "success",
        text: data.result === "accepted" ? "They had already asked you — you are now friends." : "Request sent.",
      });
      form.reset();
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="flex gap-2">
        <Input name="email" type="email" placeholder="friend@example.com" required aria-label="Friend's email" />
        <Button type="submit" disabled={pending}>{pending ? "Sending…" : "Send request"}</Button>
      </div>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </form>
  );
}

const LABELS = { accept: "Accept", decline: "Decline", cancel: "Cancel", unfriend: "Remove" } as const;

export function FriendButton({ friendshipId, kind }: { friendshipId: number; kind: keyof typeof LABELS }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    if (kind === "unfriend" && !confirm("Remove this rider from your circle?")) return;
    start(async () => {
      const err =
        kind === "accept"
          ? await call(`/api/friends/${friendshipId}/accept`, "POST")
          : await call(`/api/friends/${friendshipId}`, "DELETE");
      setError(err);
      if (!err) router.refresh();
    });
  }

  return (
    <span className="inline-flex items-center gap-2">
      {error && <span className="text-xs text-red-700">{error}</span>}
      <Button
        variant={kind === "accept" ? "primary" : kind === "unfriend" ? "danger" : "secondary"}
        onClick={onClick}
        disabled={pending}
      >
        {LABELS[kind]}
      </Button>
    </span>
  );
}

export function SuggestButton({ userId }: { userId: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="inline-flex items-center gap-2">
      {error && <span className="text-xs text-red-700">{error}</span>}
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const err = await call("/api/friends", "POST", { userId });
            setError(err);
            if (!err) router.refresh();
          })
        }
      >
        Add
      </Button>
    </span>
  );
}

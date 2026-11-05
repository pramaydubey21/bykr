"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, EmptyState, Input, Notice, Select } from "@/components/ui";

type Contact = { contact_id: number; contact_name: string; contact_phone: string; relation: string };

const RELATIONS = ["PARENT", "SPOUSE", "SIBLING", "FRIEND", "RELATIVE", "OTHER"] as const;
const label = (r: string) => r.charAt(0) + r.slice(1).toLowerCase();

async function send(url: string, method: string, body?: unknown): Promise<string | null> {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.ok) return null;
  const data = await res.json().catch(() => ({}));
  return data.error ?? `Request failed (${res.status})`;
}

function readForm(form: HTMLFormElement) {
  const fd = new FormData(form);
  return {
    contactName: String(fd.get("contactName") ?? ""),
    contactPhone: String(fd.get("contactPhone") ?? ""),
    relation: String(fd.get("relation") ?? ""),
  };
}

function ContactFields({ c }: { c?: Contact }) {
  return (
    <>
      <Input name="contactName" placeholder="Name" defaultValue={c?.contact_name} required maxLength={120} aria-label="Contact name" />
      <Input name="contactPhone" type="tel" placeholder="+91 98220 00000" defaultValue={c?.contact_phone} required aria-label="Contact phone" />
      <Select name="relation" defaultValue={c?.relation ?? ""} required aria-label="Relation">
        <option value="" disabled>Relation…</option>
        {RELATIONS.map((r) => <option key={r} value={r}>{label(r)}</option>)}
      </Select>
    </>
  );
}

export function ContactsManager({ initial }: { initial: Contact[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function run(action: () => Promise<string | null>, after?: () => void) {
    setError(null);
    start(async () => {
      const err = await action();
      if (err) return setError(err);
      after?.();
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {error && <Notice tone="error">{error}</Notice>}

      {initial.length === 0 ? (
        <EmptyState>No emergency contacts yet. Add at least one before you ride.</EmptyState>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
          {initial.map((c) =>
            editing === c.contact_id ? (
              <li key={c.contact_id} className="p-3">
                <form
                  className="grid gap-2 sm:grid-cols-[1fr_1fr_9rem_auto]"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const body = readForm(e.currentTarget);
                    run(() => send(`/api/contacts/${c.contact_id}`, "PATCH", body), () => setEditing(null));
                  }}
                >
                  <ContactFields c={c} />
                  <div className="flex gap-2">
                    <Button type="submit" disabled={pending}>Save</Button>
                    <Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                  </div>
                </form>
              </li>
            ) : (
              <li key={c.contact_id} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900">
                    {c.contact_name} <span className="font-normal text-slate-500">· {label(c.relation)}</span>
                  </p>
                  <p className="text-xs text-slate-500">{c.contact_phone}</p>
                </div>
                <div className="flex gap-2">
                  <Button variant="secondary" disabled={pending} onClick={() => { setError(null); setEditing(c.contact_id); }}>
                    Edit
                  </Button>
                  <Button
                    variant="danger"
                    disabled={pending}
                    onClick={() => {
                      if (confirm(`Delete ${c.contact_name}?`)) run(() => send(`/api/contacts/${c.contact_id}`, "DELETE"));
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}

      <form
        className="grid gap-2 sm:grid-cols-[1fr_1fr_9rem_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          run(() => send("/api/contacts", "POST", readForm(form)), () => form.reset());
        }}
      >
        <ContactFields />
        <Button type="submit" disabled={pending}>Add contact</Button>
      </form>
    </div>
  );
}

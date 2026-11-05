"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { signInAction } from "@/lib/auth/actions";
import { Button, Field, Input, Notice } from "@/components/ui";

export function SignUpForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: form.get("fullName"),
          email: form.get("email"),
          phone: form.get("phone"),
          password: form.get("password"),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Could not create the account.");
        return;
      }
      // Account exists: sign straight in (redirects on success).
      form.set("next", "/");
      const result = await signInAction({ error: null }, form);
      if (result.error) router.push("/signin?joined=1");
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      {error && <Notice tone="error">{error}</Notice>}
      <Field label="Full name">
        <Input name="fullName" autoComplete="name" required maxLength={120} autoFocus />
      </Field>
      <Field label="Email">
        <Input name="email" type="email" autoComplete="email" required />
      </Field>
      <Field label="Phone" hint="Optional. Digits, spaces or dashes, with an optional leading +.">
        <Input name="phone" type="tel" autoComplete="tel" pattern="\+?[0-9 \-]{7,20}" />
      </Field>
      <Field label="Password" hint="At least 8 characters.">
        <Input name="password" type="password" autoComplete="new-password" required minLength={8} />
      </Field>
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Creating account…" : "Sign up"}
      </Button>
    </form>
  );
}

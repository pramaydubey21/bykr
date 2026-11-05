"use client";

import { useActionState } from "react";
import { signInAction, type SignInState } from "@/lib/auth/actions";
import { Button, Field, Input, Notice } from "@/components/ui";

export function SignInForm({ next, joined }: { next: string; joined: boolean }) {
  const [state, action, pending] = useActionState<SignInState, FormData>(signInAction, { error: null });

  return (
    <form action={action} className="space-y-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      {joined && !state.error && <Notice tone="success">Account created. Sign in to continue.</Notice>}
      {state.error && <Notice tone="error">{state.error}</Notice>}
      <input type="hidden" name="next" value={next} />
      <Field label="Email">
        <Input name="email" type="email" autoComplete="email" required autoFocus defaultValue={state.email} key={state.email} />
      </Field>
      <Field label="Password">
        <Input name="password" type="password" autoComplete="current-password" required />
      </Field>
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

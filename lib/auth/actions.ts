"use server";

import { AuthError } from "next-auth";
import { signIn, signOut } from "@/auth";

export type SignInState = { error: string | null; email?: string };

/** Server action behind the sign-in form (and the auto sign-in after sign-up). */
export async function signInAction(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const next = String(formData.get("next") ?? "/");
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      // only same-site paths, never an absolute URL from the query string
      redirectTo: /^\/(?![/\\])/.test(next) ? next : "/",
    });
    return { error: null };
  } catch (err) {
    if (err instanceof AuthError) {
      return {
        error: err.type === "CredentialsSignin" ? "Wrong email or password." : "Sign-in failed.",
        email: String(formData.get("email") ?? ""), // React 19 resets the form after an action; refill it
      };
    }
    throw err; // NEXT_REDIRECT on success must propagate
  }
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/signin" });
}

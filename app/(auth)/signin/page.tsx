import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { SignInForm } from "./SignInForm";

export const metadata = { title: "Sign in · bykr" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string; joined?: string }> }) {
  if (await getSessionUser()) redirect("/");
  const { next, joined } = await searchParams;

  return (
    <div className="mx-auto mt-16 max-w-sm">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-slate-900">Sign in to bykr</h1>
      <p className="mb-6 text-sm text-slate-600">
        No account? <Link href="/signup" className="font-medium text-slate-900 underline">Sign up</Link>
      </p>
      <SignInForm next={next ?? "/"} joined={joined === "1"} />
      <p className="mt-6 text-xs text-slate-500">
        Demo accounts: <code>aarav@bykr.local</code>, <code>admin@bykr.local</code> — password <code>bykr-demo-123</code>
      </p>
    </div>
  );
}

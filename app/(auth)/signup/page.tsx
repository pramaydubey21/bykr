import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { SignUpForm } from "./SignUpForm";

export const metadata = { title: "Sign up · bykr" };

export default async function SignUpPage() {
  if (await getSessionUser()) redirect("/");
  return (
    <div className="mx-auto mt-16 max-w-sm">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-slate-900">Create your bykr account</h1>
      <p className="mb-6 text-sm text-slate-600">
        Already riding with us? <Link href="/signin" className="font-medium text-slate-900 underline">Sign in</Link>
      </p>
      <SignUpForm />
    </div>
  );
}

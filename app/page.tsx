import Link from "next/link";
import { getSessionUser } from "@/lib/auth/session";
import { Card, Notice } from "@/components/ui";

export default async function Home({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  const user = await getSessionUser();
  const { denied } = await searchParams;

  if (!user) {
    return (
      <div className="mx-auto mt-16 max-w-xl text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">Ride together. Get help fast.</h1>
        <p className="mt-3 text-slate-600">
          bykr tracks your group on a live map and, when an impact is confirmed, alerts your co-riders,
          emergency contacts and the nearest authority records — all from inside the database.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link href="/signup" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700">Create an account</Link>
          <Link href="/signin" className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50">Sign in</Link>
        </div>
      </div>
    );
  }

  const tiles = [
    { href: "/rides", title: "Rides", body: "Create, join and follow group rides on the live map." },
    { href: "/friends", title: "Friends", body: "Your riding circle, requests, and people you may know." },
    { href: "/profile", title: "Emergency contacts", body: "Who gets alerted if an accident is confirmed." },
    ...(user.roles.includes("ADMIN")
      ? [{ href: "/admin", title: "Admin", body: "All rides, accidents, the alert audit log and showcase queries." }]
      : []),
  ];

  return (
    <div className="space-y-6">
      {denied === "admin" && <Notice tone="error">That area is only available to administrators.</Notice>}
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Welcome back, {user.name.split(" ")[0]}</h1>
      <div className="grid gap-4 sm:grid-cols-2">
        {tiles.map((t) => (
          <Link key={t.href} href={t.href} className="block">
            <Card className="h-full transition-colors hover:border-slate-400">
              <h2 className="font-semibold text-slate-900">{t.title}</h2>
              <p className="mt-1 text-sm text-slate-600">{t.body}</p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

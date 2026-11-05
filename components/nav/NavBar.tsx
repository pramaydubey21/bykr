import Link from "next/link";
import { getSessionUser } from "@/lib/auth/session";
import { signOutAction } from "@/lib/auth/actions";
import { NavLinks } from "./NavLinks";

/** Server component: reads the session, shows Admin only to the ADMIN role. */
export async function NavBar() {
  const user = await getSessionUser();

  const links = [
    { href: "/rides", label: "Rides" },
    { href: "/friends", label: "Friends" },
    { href: "/profile", label: "Profile" },
    ...(user?.roles.includes("ADMIN") ? [{ href: "/admin", label: "Admin" }] : []),
  ];

  return (
    <header className="border-b border-slate-200 bg-white">
      <nav className="mx-auto flex h-14 max-w-5xl items-center gap-4 px-4">
        <Link href="/" className="text-lg font-bold tracking-tight text-slate-900">
          bykr
        </Link>
        {user ? (
          <>
            <NavLinks links={links} />
            <div className="ml-auto flex items-center gap-3">
              <span className="hidden text-sm text-slate-600 sm:inline">{user.name}</span>
              <form action={signOutAction}>
                <button type="submit" className="rounded-md px-2 py-1 text-sm text-slate-600 hover:bg-slate-100 hover:text-slate-900">
                  Sign out
                </button>
              </form>
            </div>
          </>
        ) : (
          <div className="ml-auto flex items-center gap-2 text-sm">
            <Link href="/signin" className="rounded-md px-2 py-1 text-slate-700 hover:bg-slate-100">Sign in</Link>
            <Link href="/signup" className="rounded-md bg-slate-900 px-3 py-1 text-white hover:bg-slate-700">Sign up</Link>
          </div>
        )}
      </nav>
    </header>
  );
}

import Link from "next/link";
import { requireAdmin } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const TABS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/rides", label: "All rides" },
  { href: "/admin/accidents", label: "Accidents & alerts" },
  { href: "/admin/audit", label: "Alert audit log" },
  { href: "/admin/queries", label: "Showcase queries" },
];

/**
 * The ADMIN check here only decides whether to render the admin UI. What an
 * admin can actually read is decided by PostgreSQL: every page below queries
 * through withUser(adminId), and the RLS policies grant everything only
 * because fn_is_admin(adminId) is true in the database.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="mb-4 text-2xl font-bold">Administration</h1>
      <nav className="mb-8 flex flex-wrap gap-2 border-b border-neutral-200 pb-3 text-sm dark:border-neutral-800">
        {TABS.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className="rounded-md px-3 py-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}

import { requireUserId } from "@/lib/auth/session";
import { Badge, Card, PageHeader } from "@/components/ui";
import { getProfile, listContacts } from "./queries";
import { ContactsManager } from "./ContactsManager";

export const dynamic = "force-dynamic";
export const metadata = { title: "Profile · bykr" };

export default async function ProfilePage() {
  const me = await requireUserId();
  const [profile, contacts] = await Promise.all([getProfile(me), listContacts(me)]);

  return (
    <div className="space-y-6">
      <PageHeader title="Profile" />

      {profile && (
        <Card title="Account">
          <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
            <dt className="text-slate-500">Name</dt>
            <dd className="text-slate-900">{profile.full_name}</dd>
            <dt className="text-slate-500">Email</dt>
            <dd className="text-slate-900">{profile.email}</dd>
            <dt className="text-slate-500">Phone</dt>
            <dd className="text-slate-900">{profile.phone_no ?? "—"}</dd>
            <dt className="text-slate-500">Roles</dt>
            <dd className="flex gap-1">{profile.roles.map((r) => <Badge key={r}>{r}</Badge>)}</dd>
          </dl>
        </Card>
      )}

      <Card title="Emergency contacts">
        <p className="mb-4 text-sm text-slate-600">
          When an accident on your ride is confirmed, the database trigger adds each of these people to the alert.
          bykr shows the alert; it never phones or messages anyone itself.
        </p>
        <ContactsManager initial={contacts} />
      </Card>
    </div>
  );
}

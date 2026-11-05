import { requireUserId } from "@/lib/auth/session";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { getFriendsOverview } from "./queries";
import { AddFriendForm, FriendButton, SuggestButton } from "./FriendControls";

export const dynamic = "force-dynamic";
export const metadata = { title: "Friends · bykr" };

export default async function FriendsPage() {
  const me = await requireUserId();
  const { circle, incoming, outgoing, suggestions } = await getFriendsOverview(me);

  return (
    <div className="space-y-6">
      <PageHeader title="Friends" subtitle="Your riding circle. Co-riders on a ride are alerted if you have an accident." />

      <Card title="Add a friend">
        <AddFriendForm />
      </Card>

      {incoming.length > 0 && (
        <Card title={<>Requests for you <Badge tone="amber">{incoming.length}</Badge></>}>
          <ul className="divide-y divide-slate-100">
            {incoming.map((r) => (
              <li key={r.friendship_id} className="flex items-center justify-between gap-3 py-2">
                <Person name={r.full_name} email={r.email} />
                <div className="flex gap-2">
                  <FriendButton friendshipId={r.friendship_id} kind="accept" />
                  <FriendButton friendshipId={r.friendship_id} kind="decline" />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <Card title={`Your circle (${circle.length})`}>
          {circle.length === 0 ? (
            <EmptyState>No friends yet. Send a request above.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100">
              {circle.map((f) => (
                <li key={f.friendship_id} className="flex items-center justify-between gap-3 py-2">
                  <Person name={f.full_name} email={f.email} />
                  <FriendButton friendshipId={f.friendship_id} kind="unfriend" />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="People you may know">
          {suggestions.length === 0 ? (
            <EmptyState>No friends-of-friends to suggest yet.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100">
              {suggestions.map((s) => (
                <li key={s.user_id} className="flex items-center justify-between gap-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-slate-900">{s.full_name}</p>
                    <p className="text-xs text-slate-500">
                      {s.mutual_count} mutual friend{s.mutual_count === 1 ? "" : "s"}
                    </p>
                  </div>
                  {s.requested ? <Badge>Requested</Badge> : <SuggestButton userId={s.user_id} />}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-slate-500">
            Riders two hops away in your circle, from <code>fn_friends_within(you, 2)</code> — a recursive CTE.
          </p>
        </Card>
      </div>

      {outgoing.length > 0 && (
        <Card title="Sent requests">
          <ul className="divide-y divide-slate-100">
            {outgoing.map((r) => (
              <li key={r.friendship_id} className="flex items-center justify-between gap-3 py-2">
                <Person name={r.full_name} email={r.email} />
                <div className="flex items-center gap-2">
                  <Badge>Pending</Badge>
                  <FriendButton friendshipId={r.friendship_id} kind="cancel" />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function Person({ name, email }: { name: string; email: string }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-sm font-medium text-slate-900">{name}</p>
      <p className="truncate text-xs text-slate-500">{email}</p>
    </div>
  );
}

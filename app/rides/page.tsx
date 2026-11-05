import Link from "next/link";
import { requireUserId } from "@/lib/auth/session";
import { withUser } from "@/lib/db";
import { listMyRides, type RideListRow } from "./_lib/queries";
import ActionButton from "./ActionButton";

export const dynamic = "force-dynamic";
export const metadata = { title: "Rides · bykr" };

const STATE_STYLE: Record<RideListRow["ride_state"], string> = {
  ACTIVE: "bg-green-100 text-green-800",
  CREATED: "bg-amber-100 text-amber-800",
  COMPLETED: "bg-gray-100 text-gray-700",
};

function when(r: RideListRow) {
  const d = r.ended_at ?? r.started_at ?? r.created_at;
  const verb = r.ended_at ? "ended" : r.started_at ? "started" : "created";
  return `${verb} ${new Date(d).toLocaleString()}`;
}

export default async function RidesPage() {
  const userId = await requireUserId();
  const rides = await withUser(userId, (db) => listMyRides(db, userId));
  const invitations = rides.filter((r) => r.my_participant_id && !r.my_joined_at && r.ride_state !== "COMPLETED");
  const rest = rides.filter((r) => !invitations.includes(r));

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Rides</h1>
        <Link href="/rides/new" className="rounded bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-700">
          New ride
        </Link>
      </div>

      {invitations.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Invitations</h2>
          <ul className="divide-y rounded border">
            {invitations.map((r) => (
              <li key={r.ride_id} className="flex items-center justify-between gap-4 p-3">
                <div>
                  <div className="font-medium">{r.ride_title}</div>
                  <div className="text-xs text-gray-500">
                    from {r.creator_name} · {r.ride_state.toLowerCase()} · {r.joined_count} joined
                  </div>
                </div>
                <ActionButton url={`/api/rides/${r.ride_id}/join`} label="Join" busyLabel="Joining…" redirectTo={`/rides/${r.ride_id}`} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {rest.length === 0 ? (
        <p className="text-gray-500">No rides yet. Create one and invite your friends.</p>
      ) : (
        <ul className="divide-y rounded border">
          {rest.map((r) => (
            <li key={r.ride_id}>
              <Link href={`/rides/${r.ride_id}`} className="flex items-center justify-between gap-4 p-3 hover:bg-gray-50">
                <div>
                  <div className="font-medium">
                    {r.ride_title}
                    {r.i_am_leader && <span className="ml-2 text-xs text-purple-700">leader</span>}
                  </div>
                  <div className="text-xs text-gray-500">
                    by {r.creator_name} · {when(r)} · {r.joined_count} joined
                    {r.invited_count > 0 && `, ${r.invited_count} invited`}
                  </div>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATE_STYLE[r.ride_state]}`}>{r.ride_state}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

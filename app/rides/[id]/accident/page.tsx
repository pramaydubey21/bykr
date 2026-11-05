import Link from "next/link";
import { notFound } from "next/navigation";
import { withUser } from "@/lib/db";
import { requireUserId } from "@/lib/auth/session";
import AccidentMonitor from "@/components/accident/AccidentMonitor";

export const dynamic = "force-dynamic";

type Row = {
  ride_id: number;
  ride_title: string;
  ride_state: string;
  participant_id: number | null;
  joined_at: Date | null;
  left_at: Date | null;
};

export default async function AccidentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rideId = Number(id);
  if (!Number.isInteger(rideId) || rideId <= 0) notFound();
  const userId = await requireUserId();

  // RLS: a rider who is not in this ride gets no row at all.
  const ride = await withUser(userId, async (db) => {
    const { rows } = await db.query<Row>(
      `SELECT r.ride_id, r.ride_title, r.ride_state,
              rp.participant_id, rp.joined_at, rp.left_at
         FROM ride r
         LEFT JOIN ride_participant rp
                ON rp.ride_id = r.ride_id AND rp.user_id = $2
        WHERE r.ride_id = $1`,
      [rideId, userId],
    );
    return rows[0] ?? null;
  });
  if (!ride) notFound();

  const riding = ride.participant_id != null && ride.joined_at != null && ride.left_at == null;
  const blocked =
    ride.ride_state !== "ACTIVE"
      ? `This ride is ${ride.ride_state}. Accident monitoring only runs on an ACTIVE ride.`
      : !riding
        ? "You have not joined this ride (or have left it), so an accident cannot be reported on it."
        : null;

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <Link href={`/rides/${rideId}`} className="text-sm text-neutral-500 hover:underline">
        ← Back to ride
      </Link>
      <h1 className="mb-6 mt-2 text-2xl font-bold">Accident detection</h1>
      {blocked ? (
        <p className="rounded-lg bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {blocked}
        </p>
      ) : (
        <AccidentMonitor rideId={rideId} rideTitle={ride.ride_title} />
      )}
      <p className="mt-8 text-xs text-neutral-500">
        bykr never contacts a real emergency service. Authority records are shown on the alert page for
        a person to act on.
      </p>
    </main>
  );
}

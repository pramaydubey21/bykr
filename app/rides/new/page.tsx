import Link from "next/link";
import { requireUserId } from "@/lib/auth/session";
import { withUser } from "@/lib/db";
import { listFriends } from "../_lib/queries";
import CreateRideForm from "./CreateRideForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "New ride · bykr" };

export default async function NewRidePage() {
  const userId = await requireUserId();
  const friends = await withUser(userId, (db) => listFriends(db, userId));
  return (
    <main className="mx-auto max-w-xl px-4 py-8">
      <Link href="/rides" className="text-sm text-gray-500 hover:underline">
        ← Rides
      </Link>
      <h1 className="mb-6 mt-2 text-2xl font-semibold">New ride</h1>
      <CreateRideForm friends={friends} />
    </main>
  );
}

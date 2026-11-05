"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "../_lib/client";

export default function CreateRideForm({ friends }: { friends: { user_id: number; full_name: string }[] }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [invite, setInvite] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: number) {
    setInvite((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { rideId } = await api<{ rideId: number }>("/api/rides", {
        body: { title, inviteUserIds: [...invite] },
      });
      router.push(`/rides/${rideId}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <label className="block">
        <span className="text-sm font-medium">Title</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={120}
          required
          placeholder="Sunday run to Lavasa"
          className="mt-1 w-full rounded border px-3 py-2"
        />
      </label>

      <fieldset>
        <legend className="text-sm font-medium">Invite friends</legend>
        {friends.length === 0 ? (
          <p className="mt-1 text-sm text-gray-500">
            You have no friends in your circle yet. You can still create the ride and ride alone.
          </p>
        ) : (
          <ul className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
            {friends.map((f) => (
              <li key={f.user_id}>
                <label className="flex items-center gap-2 rounded px-2 py-1 hover:bg-gray-50">
                  <input type="checkbox" checked={invite.has(f.user_id)} onChange={() => toggle(f.user_id)} />
                  {f.full_name}
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={busy || title.trim() === ""}
        className="rounded bg-gray-900 px-4 py-2 font-medium text-white hover:bg-gray-700 disabled:opacity-50"
      >
        {busy ? "Creating…" : `Create ride${invite.size ? ` and invite ${invite.size}` : ""}`}
      </button>
    </form>
  );
}

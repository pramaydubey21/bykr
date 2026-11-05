"use client";
/**
 * Live ride screen.
 *
 *  - Polls GET /api/rides/[id]/live every 5 s (Postgres participants + status,
 *    MongoDB latest position per participant).
 *  - Every 5 s while the ride is ACTIVE, takes one position (real GPS, or the
 *    "simulate movement" generator, since a laptop does not move) and appends
 *    it to a local buffer. When online the buffer is flushed with ONE
 *    POST /api/rides/[id]/pings carrying an array -> one MongoDB insertMany.
 *    "Simulate offline" keeps buffering; switching it off flushes everything
 *    in a single bulk call.
 *  - Status control: click the status button, click a status. Two clicks.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { LiveMap } from "@/components/map";
import { offsetMetres } from "@/lib/geo";
import { api } from "../_lib/client";
import {
  STATUS_OPTIONS,
  STATUS_STYLE,
  type LiveParticipant,
  type LiveResponse,
  type PingPayload,
  type StatusOption,
} from "../_lib/types";
import ActionButton from "../ActionButton";

const TICK_MS = 5000;
const DEFAULT_START = { lat: 18.5204, lon: 73.8567 }; // Pune

type Props = {
  rideId: number;
  title: string;
  initial: LiveResponse;
  me: { userId: number; participantId: number | null; joined: boolean; isLeader: boolean };
};

type FlushInfo = { at: string; sent: number; inserted: number } | null;

function bufferKey(rideId: number) {
  return `bykr:pings:${rideId}`;
}
function loadBuffer(rideId: number): PingPayload[] {
  try {
    const raw = localStorage.getItem(bufferKey(rideId));
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function saveBuffer(rideId: number, buf: PingPayload[]) {
  try {
    if (buf.length === 0) localStorage.removeItem(bufferKey(rideId));
    else localStorage.setItem(bufferKey(rideId), JSON.stringify(buf));
  } catch {
    /* storage unavailable: the in-memory buffer still works */
  }
}

function ago(iso: string | null | undefined, now: number) {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export default function LiveRide({ rideId, title, initial, me }: Props) {
  const router = useRouter();
  const [live, setLive] = useState<LiveResponse>(initial);
  const [pollError, setPollError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [simulateOffline, setSimulateOffline] = useState(false);
  const [simulateMovement, setSimulateMovement] = useState(true);
  const [buffered, setBuffered] = useState(0);
  const [lastFlush, setLastFlush] = useState<FlushInfo>(null);
  const [pingError, setPingError] = useState<string | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [trail, setTrail] = useState<{ lat: number; lon: number }[]>([]);

  const [statusOpen, setStatusOpen] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);

  const bufferRef = useRef<PingPayload[]>([]);
  const flushingRef = useRef(false);
  const offlineRef = useRef(simulateOffline);
  const realPosRef = useRef<{ lat: number; lon: number; speedKmph: number; accuracyM: number } | null>(null);
  const simRef = useRef<{ lat: number; lon: number; heading: number; tick: number } | null>(null);
  const liveRef = useRef(live);
  liveRef.current = live;
  offlineRef.current = simulateOffline;

  const rideState = live.rideState;
  const mine: LiveParticipant | undefined = live.participants.find((p) => p.participantId === me.participantId);
  const canPing = rideState === "ACTIVE" && me.joined && me.participantId !== null;

  // Restore a buffer left over from a reload while offline.
  useEffect(() => {
    bufferRef.current = loadBuffer(rideId);
    setBuffered(bufferRef.current.length);
  }, [rideId]);

  // ---------------------------------------------------------------- polling
  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/rides/${rideId}/live`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setLive(data as LiveResponse);
      setPollError(null);
      if ((data as LiveResponse).rideState !== liveRef.current.rideState) router.refresh();
    } catch (e) {
      setPollError((e as Error).message);
    }
  }, [rideId, router]);

  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
      void poll();
    }, TICK_MS);
    return () => clearInterval(id);
  }, [poll]);

  // ---------------------------------------------------------------- flushing
  const flush = useCallback(async () => {
    if (flushingRef.current || offlineRef.current) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    const batch = bufferRef.current.slice();
    if (batch.length === 0) return;
    flushingRef.current = true;
    try {
      const r = await api<{ received: number; inserted: number; dropped: number }>(`/api/rides/${rideId}/pings`, {
        body: batch,
      });
      bufferRef.current = bufferRef.current.slice(batch.length);
      setLastFlush({ at: new Date().toISOString(), sent: batch.length, inserted: r.inserted });
      setPingError(null);
    } catch (e) {
      const err = e as Error & { status?: number };
      setPingError(err.message);
      // 400/403 will never succeed (ride ended, not a participant): drop them.
      if (err.status === 400 || err.status === 403) bufferRef.current = bufferRef.current.slice(batch.length);
    } finally {
      flushingRef.current = false;
      saveBuffer(rideId, bufferRef.current);
      setBuffered(bufferRef.current.length);
    }
  }, [rideId]);

  // Flush as soon as "simulate offline" is switched off, or the browser comes back online.
  useEffect(() => {
    if (!simulateOffline) void flush();
  }, [simulateOffline, flush]);
  useEffect(() => {
    const on = () => void flush();
    window.addEventListener("online", on);
    return () => window.removeEventListener("online", on);
  }, [flush]);

  // ---------------------------------------------------------------- real GPS
  useEffect(() => {
    if (!canPing || simulateMovement) return;
    if (!("geolocation" in navigator)) {
      setGpsError("This browser has no geolocation. Turn on “simulate movement”.");
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        realPosRef.current = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          speedKmph: pos.coords.speed != null && pos.coords.speed >= 0 ? pos.coords.speed * 3.6 : 0,
          accuracyM: pos.coords.accuracy ?? 50,
        };
        setGpsError(null);
      },
      (err) => setGpsError(`GPS: ${err.message}. Turn on “simulate movement”.`),
      { enableHighAccuracy: true, maximumAge: 4000, timeout: 15000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [canPing, simulateMovement]);

  // ---------------------------------------------------------------- simulated movement
  const nextSimulated = useCallback((): PingPayload => {
    if (!simRef.current) {
      const start =
        liveRef.current.participants.find((p) => p.participantId === me.participantId)?.position ??
        realPosRef.current ??
        liveRef.current.participants.find((p) => p.position)?.position ??
        DEFAULT_START;
      // Small per-rider offset so riders starting together do not overlap exactly.
      const jitter = offsetMetres(start, ((me.userId * 37) % 60) - 30, ((me.userId * 53) % 60) - 30);
      simRef.current = { lat: jitter.lat, lon: jitter.lon, heading: (me.userId * 47) % 360, tick: 0 };
    }
    const s = simRef.current;
    s.tick++;
    // Ride for ~2 minutes, then a 30 s stop: gives the aggregation real stops
    // and tagRideSegments real segment boundaries.
    const stopped = s.tick % 30 >= 24;
    const speedKmph = stopped ? Math.random() * 2 : 38 + Math.random() * 20;
    if (!stopped) {
      s.heading = (s.heading + (Math.random() * 30 - 15) + 360) % 360;
      const metres = (speedKmph / 3.6) * (TICK_MS / 1000);
      const rad = (s.heading * Math.PI) / 180;
      const p = offsetMetres(s, metres * Math.cos(rad), metres * Math.sin(rad));
      s.lat = p.lat;
      s.lon = p.lon;
    }
    return {
      lat: Number(s.lat.toFixed(6)),
      lon: Number(s.lon.toFixed(6)),
      speedKmph: Number(speedKmph.toFixed(1)),
      accuracyM: 5,
      recordedAt: new Date().toISOString(),
    };
  }, [me.participantId, me.userId]);

  // ---------------------------------------------------------------- ping tick
  useEffect(() => {
    if (!canPing) return;
    const tick = () => {
      let ping: PingPayload | null = null;
      if (simulateMovement) ping = nextSimulated();
      else if (realPosRef.current) {
        const r = realPosRef.current;
        ping = { ...r, recordedAt: new Date().toISOString() };
      }
      if (!ping) return;
      bufferRef.current.push(ping);
      saveBuffer(rideId, bufferRef.current);
      setBuffered(bufferRef.current.length);
      setTrail((t) => [...t.slice(-120), { lat: ping!.lat, lon: ping!.lon }]);
      void flush();
    };
    tick();
    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, [canPing, simulateMovement, nextSimulated, flush, rideId]);

  // ---------------------------------------------------------------- status
  async function chooseStatus(label: StatusOption) {
    setStatusBusy(true);
    setStatusError(null);
    try {
      await api(`/api/rides/${rideId}/status`, { body: { label } });
      setLive((l) => ({
        ...l,
        participants: l.participants.map((p) =>
          p.participantId === me.participantId ? { ...p, status: label, statusSetAt: new Date().toISOString() } : p,
        ),
      }));
      setStatusOpen(false);
    } catch (e) {
      setStatusError((e as Error).message);
    } finally {
      setStatusBusy(false);
    }
  }

  // ---------------------------------------------------------------- end ride
  async function endRide() {
    if (!window.confirm("End the ride for everyone? This computes the summary, route and embedding.")) return;
    setEnding(true);
    setEndError(null);
    try {
      offlineRef.current = false;
      await flush(); // make sure the last buffered pings are in MongoDB first
      await api(`/api/rides/${rideId}/end`);
      router.refresh();
    } catch (e) {
      setEndError((e as Error).message);
      setEnding(false);
    }
  }

  // ---------------------------------------------------------------- render
  const located = live.participants.filter((p) => p.position).length;
  const joined = live.participants.filter((p) => p.joined);

  return (
    <main className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/rides" className="text-sm text-gray-500 hover:underline">
            ← Rides
          </Link>
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="text-sm text-gray-500">
            <span
              className={`mr-2 rounded-full px-2 py-0.5 text-xs font-medium ${
                rideState === "ACTIVE" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"
              }`}
            >
              {rideState}
            </span>
            {joined.length} joined · {located} on map · refreshed every 5 s
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {!me.joined && me.participantId !== null && (
            <ActionButton url={`/api/rides/${rideId}/join`} label="Join ride" busyLabel="Joining…" />
          )}
          {me.isLeader && rideState === "CREATED" && (
            <ActionButton url={`/api/rides/${rideId}/start`} label="Start ride" busyLabel="Starting…" />
          )}
          {canPing && (
            <Link
              href={`/rides/${rideId}/accident`}
              className="rounded border border-red-600 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
            >
              Impact / accident…
            </Link>
          )}
          {me.isLeader && rideState === "ACTIVE" && (
            <span className="inline-flex flex-col">
              <button
                type="button"
                onClick={endRide}
                disabled={ending}
                className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
              >
                {ending ? "Ending…" : "End ride"}
              </button>
              {endError && <span className="mt-1 max-w-xs text-xs text-red-600">{endError}</span>}
            </span>
          )}
        </div>
      </div>

      {rideState === "CREATED" && (
        <p className="mb-4 rounded bg-amber-50 p-3 text-sm text-amber-900">
          Waiting for the leader to start the ride. Positions are sent only while the ride is ACTIVE.
        </p>
      )}
      {pollError && <p className="mb-2 text-sm text-red-600">Live update failed: {pollError}</p>}

      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="relative overflow-hidden rounded border">
          <LiveMap participants={live.participants} meParticipantId={me.participantId} myTrail={trail} height={520} />

          {/* Status control: click 1 opens, click 2 sets. */}
          {canPing && (
            <div className="absolute right-3 top-3 z-[1000] w-48 rounded bg-white/95 p-2 shadow">
              <button
                type="button"
                onClick={() => setStatusOpen((o) => !o)}
                className="flex w-full items-center justify-between rounded px-2 py-1.5 text-sm font-medium hover:bg-gray-100"
                aria-expanded={statusOpen}
              >
                <span>
                  My status:{" "}
                  {mine?.status ? (
                    <span
                      className="rounded-full px-2 py-0.5 text-xs"
                      style={{ background: STATUS_STYLE[mine.status].bg, color: STATUS_STYLE[mine.status].fg }}
                    >
                      {STATUS_STYLE[mine.status].label}
                    </span>
                  ) : (
                    "—"
                  )}
                </span>
                <span aria-hidden>{statusOpen ? "▴" : "▾"}</span>
              </button>
              {statusOpen && (
                <ul className="mt-1 space-y-1">
                  {STATUS_OPTIONS.map((s) => (
                    <li key={s}>
                      <button
                        type="button"
                        disabled={statusBusy}
                        onClick={() => chooseStatus(s)}
                        className="w-full rounded px-2 py-1.5 text-left text-sm font-medium disabled:opacity-50"
                        style={{ background: STATUS_STYLE[s].bg, color: STATUS_STYLE[s].fg }}
                      >
                        {STATUS_STYLE[s].label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {statusError && <p className="mt-1 text-xs text-red-600">{statusError}</p>}
            </div>
          )}
        </div>

        <aside className="space-y-4">
          {canPing && (
            <section className="rounded border p-3 text-sm">
              <h2 className="mb-2 font-semibold">Telemetry</h2>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={simulateMovement} onChange={(e) => setSimulateMovement(e.target.checked)} />
                Simulate movement
              </label>
              <label className="mt-1 flex items-center gap-2">
                <input type="checkbox" checked={simulateOffline} onChange={(e) => setSimulateOffline(e.target.checked)} />
                Simulate offline
              </label>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-gray-500">Buffered</dt>
                <dd className={buffered > 1 ? "font-semibold text-amber-700" : ""}>
                  {buffered} ping{buffered === 1 ? "" : "s"}
                  {simulateOffline && " (offline)"}
                </dd>
                <dt className="text-gray-500">Last flush</dt>
                <dd>
                  {lastFlush
                    ? `${lastFlush.inserted}/${lastFlush.sent} inserted (one insertMany) · ${ago(lastFlush.at, now)}`
                    : "—"}
                </dd>
              </dl>
              {gpsError && !simulateMovement && <p className="mt-2 text-xs text-red-600">{gpsError}</p>}
              {pingError && <p className="mt-2 text-xs text-red-600">{pingError}</p>}
            </section>
          )}

          <section className="rounded border p-3">
            <h2 className="mb-2 text-sm font-semibold">Participants</h2>
            <ul className="space-y-2 text-sm">
              {live.participants.map((p) => (
                <li key={p.participantId} className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium">
                      {p.name}
                      {p.participantId === me.participantId && <span className="text-sky-600"> (you)</span>}
                      {p.isLeader && <span className="text-xs text-purple-700"> leader</span>}
                    </div>
                    <div className="text-xs text-gray-500">
                      {!p.joined
                        ? "invited, not joined"
                        : p.position
                          ? `${p.position.speedKmph.toFixed(0)} km/h · ${ago(p.position.recordedAt, now)}`
                          : "no position yet"}
                    </div>
                  </div>
                  {p.status && (
                    <span
                      className="shrink-0 rounded-full px-2 py-0.5 text-xs"
                      style={{ background: STATUS_STYLE[p.status].bg, color: STATUS_STYLE[p.status].fg }}
                    >
                      {STATUS_STYLE[p.status].label}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </main>
  );
}

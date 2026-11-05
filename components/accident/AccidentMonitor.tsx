"use client";

/**
 * Accident path for one ride (spec section 1 and 8).
 *
 * Two triggers lead to the SAME 30 second countdown and the SAME server call:
 *   - a DeviceMotion listener (impact > 4 g, then stillness — see detector.ts)
 *   - the "Simulate impact" button, because a laptop has no accelerometer.
 *
 * Countdown expires → POST /api/accidents { isConfirmed: true }  → the
 *   database trigger trg_generate_sos creates the alert and its recipients.
 * Rider cancels       → POST /api/accidents { isConfirmed: false } → the event
 *   is recorded for the history, and the trigger's WHEN clause skips it.
 *
 * Nothing here contacts any emergency service.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ImpactDetector, simulatedDetection, type Detection } from "./detector";

const COUNTDOWN_S = 30;

type Phase =
  | { kind: "idle" }
  | { kind: "countdown"; detection: Detection; source: "motion" | "simulated"; endsAt: number }
  | { kind: "sending"; confirmed: boolean }
  | { kind: "cancelled"; eventId: number }
  | { kind: "error"; message: string };

type MotionState = "unsupported" | "needs-permission" | "listening" | "denied";

type Props = { rideId: number; rideTitle: string };

type DeviceMotionEventWithPermission = typeof DeviceMotionEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

export default function AccidentMonitor({ rideId, rideTitle }: Props) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [motion, setMotion] = useState<MotionState>("unsupported");
  const [now, setNow] = useState(() => Date.now());
  const [lastG, setLastG] = useState<number | null>(null);
  const detector = useRef(new ImpactDetector());
  const phaseRef = useRef<Phase>(phase);
  const position = useRef<{ lat: number; lon: number } | null>(null);
  const detectedAt = useRef<Date | null>(null);
  phaseRef.current = phase;

  // ---------------------------------------------------------------- position
  const refreshPosition = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (p) => {
        position.current = { lat: p.coords.latitude, lon: p.coords.longitude };
      },
      () => {
        /* no fix: the server falls back to this rider's latest MongoDB ping */
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
    );
  }, []);

  // ---------------------------------------------------------------- trigger
  const startCountdown = useCallback(
    (detection: Detection, source: "motion" | "simulated") => {
      if (phaseRef.current.kind === "countdown" || phaseRef.current.kind === "sending") return;
      detectedAt.current = new Date();
      refreshPosition();
      setNow(Date.now());
      setPhase({ kind: "countdown", detection, source, endsAt: Date.now() + COUNTDOWN_S * 1000 });
    },
    [refreshPosition],
  );

  // ---------------------------------------------------------------- motion
  const onMotion = useCallback(
    (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null || a.y == null || a.z == null) return;
      const g = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z) / 9.80665;
      setLastG(Math.round(g * 100) / 100);
      if (phaseRef.current.kind === "countdown" || phaseRef.current.kind === "sending") return;
      const hit = detector.current.push(performance.now(), a.x, a.y, a.z);
      if (hit) startCountdown(hit, "motion");
    },
    [startCountdown],
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof DeviceMotionEvent === "undefined") {
      setMotion("unsupported");
      return;
    }
    const DME = DeviceMotionEvent as DeviceMotionEventWithPermission;
    if (typeof DME.requestPermission === "function") {
      setMotion("needs-permission"); // iOS Safari: must be granted from a tap
      return;
    }
    window.addEventListener("devicemotion", onMotion);
    setMotion("listening");
    return () => window.removeEventListener("devicemotion", onMotion);
  }, [onMotion]);

  const enableMotion = async () => {
    const DME = DeviceMotionEvent as DeviceMotionEventWithPermission;
    try {
      const res = await DME.requestPermission?.();
      if (res === "granted") {
        window.addEventListener("devicemotion", onMotion);
        setMotion("listening");
      } else {
        setMotion("denied");
      }
    } catch {
      setMotion("denied");
    }
  };

  useEffect(() => {
    refreshPosition();
  }, [refreshPosition]);

  // ---------------------------------------------------------------- submit
  const submit = useCallback(
    async (confirmed: boolean, detection: Detection) => {
      setPhase({ kind: "sending", confirmed });
      try {
        const res = await fetch("/api/accidents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rideId,
            isConfirmed: confirmed,
            impactForceG: detection.peakG,
            lat: position.current?.lat ?? null,
            lon: position.current?.lon ?? null,
            detectedAt: (detectedAt.current ?? new Date()).toISOString(),
            samples: detection.samples,
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setPhase({ kind: "error", message: body.error ?? `Server answered ${res.status}` });
          return;
        }
        if (confirmed && body.alertId) {
          router.push(`/alerts/${body.alertId}`);
        } else {
          setPhase({ kind: "cancelled", eventId: body.eventId });
        }
      } catch (err) {
        setPhase({ kind: "error", message: err instanceof Error ? err.message : "Network error" });
      }
    },
    [rideId, router],
  );

  // ---------------------------------------------------------------- countdown tick
  useEffect(() => {
    if (phase.kind !== "countdown") return;
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= phase.endsAt) {
        window.clearInterval(id);
        void submit(true, phase.detection);
      }
    }, 200);
    return () => window.clearInterval(id);
  }, [phase, submit]);

  const remaining =
    phase.kind === "countdown" ? Math.max(0, Math.ceil((phase.endsAt - now) / 1000)) : COUNTDOWN_S;

  // ---------------------------------------------------------------- render
  if (phase.kind === "countdown") {
    return (
      <div className="rounded-xl border-2 border-red-600 bg-red-50 p-6 text-center dark:bg-red-950/40">
        <p className="text-sm font-semibold uppercase tracking-wide text-red-700 dark:text-red-300">
          Possible accident detected ({phase.source === "simulated" ? "simulated" : "device motion"},
          peak {phase.detection.peakG.toFixed(1)} g)
        </p>
        <p className="my-4 text-7xl font-bold tabular-nums text-red-700 dark:text-red-300">{remaining}</p>
        <p className="mb-6 text-sm">
          When the countdown ends an alert goes to your co-riders, your emergency contacts and the
          authority records for this area are shown for a person to act on.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <button
            onClick={() => submit(false, phase.detection)}
            className="rounded-lg bg-neutral-900 px-8 py-4 text-lg font-semibold text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900"
          >
            I&apos;m OK — cancel
          </button>
          <button
            onClick={() => submit(true, phase.detection)}
            className="rounded-lg border border-red-600 px-6 py-4 font-semibold text-red-700 hover:bg-red-100 dark:text-red-300 dark:hover:bg-red-900/40"
          >
            Send alert now
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {phase.kind === "sending" && (
        <p className="rounded-lg bg-neutral-100 p-4 text-sm dark:bg-neutral-800">
          {phase.confirmed ? "Recording the accident and dispatching the alert…" : "Recording the cancellation…"}
        </p>
      )}
      {phase.kind === "cancelled" && (
        <p className="rounded-lg bg-green-50 p-4 text-sm text-green-800 dark:bg-green-950/40 dark:text-green-300">
          Cancelled. Recorded as accident event #{phase.eventId} with is_confirmed = false — the trigger
          did not fire, so no alert was created.
        </p>
      )}
      {phase.kind === "error" && (
        <p className="rounded-lg bg-red-50 p-4 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-300">
          {phase.message}
        </p>
      )}

      <section className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="mb-1 font-semibold">Motion monitoring — {rideTitle}</h2>
        <p className="mb-4 text-sm text-neutral-600 dark:text-neutral-400">
          Keep this page open while riding. An impact above 4 g followed by 3 s of stillness starts a{" "}
          {COUNTDOWN_S} second countdown.
        </p>
        {motion === "listening" && (
          <p className="text-sm">
            <span className="mr-2 inline-block h-2 w-2 rounded-full bg-green-500" />
            Listening to device motion{lastG != null ? ` — current ${lastG.toFixed(2)} g` : " (no readings yet: this device may have no accelerometer)"}
          </p>
        )}
        {motion === "needs-permission" && (
          <button
            onClick={enableMotion}
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
          >
            Enable motion detection
          </button>
        )}
        {motion === "denied" && <p className="text-sm text-amber-700">Motion access was denied.</p>}
        {motion === "unsupported" && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            This browser does not expose device motion. Use “Simulate impact” below.
          </p>
        )}
      </section>

      <section className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="mb-1 font-semibold">Simulate impact</h2>
        <p className="mb-4 text-sm text-neutral-600 dark:text-neutral-400">
          Sends a synthetic 6.8 g motion window through exactly the same countdown and server call.
        </p>
        <button
          onClick={() => startCountdown(simulatedDetection(), "simulated")}
          disabled={phase.kind === "sending"}
          className="rounded-lg bg-red-600 px-5 py-3 font-semibold text-white hover:bg-red-700 disabled:opacity-50"
        >
          Simulate impact
        </button>
      </section>
    </div>
  );
}

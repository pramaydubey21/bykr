/**
 * Impact detector for DeviceMotion readings. Pure logic, no React, so the
 * thresholds are easy to explain and to test.
 *
 *   1. Every reading's magnitude |a| (accelerationIncludingGravity, m/s^2) is
 *      converted to g. At rest it reads ~1 g.
 *   2. A reading above IMPACT_G is a candidate impact.
 *   3. The candidate becomes a suspected accident only if the device then lies
 *      still: for STILL_MS every reading stays within STILL_TOLERANCE_G of 1 g.
 *      Any movement before that (the rider picked the phone up, a pothole and
 *      carried on riding) discards the candidate.
 *   4. If stillness has not been reached within GIVE_UP_MS of the impact, the
 *      candidate is discarded too.
 *
 * A rolling buffer keeps the readings around the impact; they are stored in
 * MongoDB (motion_samples) as the evidence behind the accident_event row.
 */
export const G = 9.80665;
export const IMPACT_G = 4;
export const STILL_TOLERANCE_G = 0.35;
export const STILL_MS = 3000;
export const GIVE_UP_MS = 10000;
const PRE_IMPACT_MS = 2000;
const MAX_SAMPLES = 1500;

export type Sample = { t: number; x: number; y: number; z: number }; // t = ms offset from first sample

export type Detection = { peakG: number; samples: Sample[] };

export class ImpactDetector {
  private buf: { at: number; x: number; y: number; z: number }[] = [];
  private impactAt: number | null = null;
  private peakG = 0;
  private stillSince: number | null = null;

  /** Feed one reading; returns a Detection when an impact-then-stillness completes. */
  push(at: number, x: number, y: number, z: number): Detection | null {
    this.buf.push({ at, x, y, z });
    const g = Math.sqrt(x * x + y * y + z * z) / G;

    if (this.impactAt == null) {
      // Not tracking an impact: keep only the pre-impact window.
      while (this.buf.length > 0 && at - this.buf[0].at > PRE_IMPACT_MS) this.buf.shift();
      if (g > IMPACT_G) {
        this.impactAt = at;
        this.peakG = g;
        this.stillSince = null;
      }
      return null;
    }

    if (this.buf.length > MAX_SAMPLES) this.buf.shift();
    this.peakG = Math.max(this.peakG, g);

    if (g > IMPACT_G) {
      // still tumbling: restart the stillness window
      this.stillSince = null;
    } else if (Math.abs(g - 1) <= STILL_TOLERANCE_G) {
      if (this.stillSince == null) this.stillSince = at;
      if (at - this.stillSince >= STILL_MS) {
        const detection = { peakG: this.peakG, samples: this.snapshot() };
        this.reset();
        return detection;
      }
    } else if (this.stillSince != null) {
      // moved after the impact → the rider is up and about; not an accident
      this.reset();
      return null;
    }

    if (this.impactAt != null && at - this.impactAt > GIVE_UP_MS) this.reset();
    return null;
  }

  reset(): void {
    this.impactAt = null;
    this.stillSince = null;
    this.peakG = 0;
    this.buf = [];
  }

  private snapshot(): Sample[] {
    const t0 = this.buf.length ? this.buf[0].at : 0;
    return this.buf.map((s) => ({
      t: Math.round(s.at - t0),
      x: round3(s.x),
      y: round3(s.y),
      z: round3(s.z),
    }));
  }
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * The "Simulate impact" path: a synthetic 4 s window (50 Hz) shaped like the
 * real thing — riding vibration, a 6.8 g spike, then the device lying still —
 * so the server receives the same kind of evidence either way.
 */
export function simulatedDetection(): Detection {
  const samples: Sample[] = [];
  let peak = 0;
  for (let i = 0; i < 200; i++) {
    const t = i * 20;
    let x = 0.4 * Math.sin(i / 3);
    let y = 0.3 * Math.cos(i / 4);
    let z = G + 0.5 * Math.sin(i / 2);
    if (i >= 50 && i < 56) {
      // the impact
      const k = [2.1, 4.8, 6.8, 5.2, 3.0, 1.6][i - 50];
      x = k * G * 0.6;
      y = k * G * 0.3;
      z = k * G * 0.74;
    } else if (i >= 56) {
      // lying still on its side
      x = G * 0.98;
      y = 0.05;
      z = 0.1;
    }
    peak = Math.max(peak, Math.sqrt(x * x + y * y + z * z) / G);
    samples.push({ t, x: round3(x), y: round3(y), z: round3(z) });
  }
  return { peakG: Math.round(peak * 100) / 100, samples };
}

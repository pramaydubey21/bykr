/** Shapes shared between the ride API and the client components (no server imports). */

export const STATUS_OPTIONS = ["RIDING", "STOPPED", "REFUELLING", "EATING", "DELAYED"] as const;
export type StatusOption = (typeof STATUS_OPTIONS)[number];

export const STATUS_STYLE: Record<StatusOption, { label: string; bg: string; fg: string }> = {
  RIDING: { label: "Riding", bg: "#16a34a", fg: "#fff" },
  STOPPED: { label: "Stopped", bg: "#6b7280", fg: "#fff" },
  REFUELLING: { label: "Refuelling", bg: "#2563eb", fg: "#fff" },
  EATING: { label: "Eating", bg: "#d97706", fg: "#fff" },
  DELAYED: { label: "Delayed", bg: "#dc2626", fg: "#fff" },
};

export type LiveParticipant = {
  participantId: number;
  userId: number;
  name: string;
  isLeader: boolean;
  joined: boolean;
  status: StatusOption | null;
  statusSetAt: string | null;
  position: { lat: number; lon: number; speedKmph: number; recordedAt: string } | null;
};

export type LiveResponse = {
  rideId: number;
  rideState: "CREATED" | "ACTIVE" | "COMPLETED";
  serverTime: string;
  participants: LiveParticipant[];
};

/** One ping as the browser buffers it and POSTs it (an array of these). */
export type PingPayload = {
  lat: number;
  lon: number;
  speedKmph: number;
  accuracyM: number;
  recordedAt: string; // ISO
};

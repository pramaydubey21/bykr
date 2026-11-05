"use client";
/**
 * Leaflet live map: one marker per participant with a status badge.
 * Imported only through components/map/index.tsx (next/dynamic, ssr:false),
 * because Leaflet touches `window` at import time.
 */
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect, useMemo, useRef } from "react";
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from "react-leaflet";
import { STATUS_STYLE, type LiveParticipant } from "@/app/rides/_lib/types";

export type LiveMapProps = {
  participants: LiveParticipant[];
  meParticipantId: number | null;
  /** Recent positions of the current user (drawn as a short trail). */
  myTrail?: { lat: number; lon: number }[];
  fallbackCenter?: { lat: number; lon: number };
  height?: number | string;
};

const DEFAULT_CENTER = { lat: 18.5204, lon: 73.8567 }; // Pune

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function markerIcon(p: LiveParticipant, isMe: boolean): L.DivIcon {
  const st = p.status ? STATUS_STYLE[p.status] : null;
  const initials = p.name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const ring = isMe ? "#0ea5e9" : p.isLeader ? "#a855f7" : "#111827";
  const badge = st
    ? `<span style="position:absolute;left:50%;top:36px;transform:translateX(-50%);white-space:nowrap;
         background:${st.bg};color:${st.fg};font:600 10px/1 system-ui,sans-serif;padding:3px 6px;border-radius:999px;
         box-shadow:0 1px 2px rgba(0,0,0,.35)">${st.label}</span>`
    : "";
  const html = `<div style="position:relative;width:34px;height:34px">
      <div style="width:34px;height:34px;border-radius:50%;background:#fff;border:3px solid ${ring};
           display:flex;align-items:center;justify-content:center;font:700 12px/1 system-ui,sans-serif;color:#111827;
           box-shadow:0 1px 3px rgba(0,0,0,.4)">${escapeHtml(initials)}</div>${badge}</div>`;
  return L.divIcon({ html, className: "", iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -18] });
}

/** Fit the view to everyone once, the first time positions are known. */
function FitOnce({ points }: { points: [number, number][] }) {
  const map = useMap();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || points.length === 0) return;
    done.current = true;
    if (points.length === 1) map.setView(points[0], 15);
    else map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 16 });
  }, [map, points]);
  return null;
}

export default function LiveMapInner({ participants, meParticipantId, myTrail, fallbackCenter, height = 480 }: LiveMapProps) {
  const located = participants.filter((p) => p.position);
  const points = useMemo<[number, number][]>(
    () => located.map((p) => [p.position!.lat, p.position!.lon]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [located.map((p) => `${p.participantId}:${p.position!.lat},${p.position!.lon}`).join("|")],
  );
  const c = fallbackCenter ?? DEFAULT_CENTER;

  return (
    <MapContainer center={[c.lat, c.lon]} zoom={13} style={{ height, width: "100%" }} scrollWheelZoom>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <FitOnce points={points} />
      {myTrail && myTrail.length > 1 && (
        <Polyline positions={myTrail.map((t) => [t.lat, t.lon] as [number, number])} pathOptions={{ color: "#0ea5e9", weight: 3, opacity: 0.6 }} />
      )}
      {located.map((p) => (
        <Marker
          key={p.participantId}
          position={[p.position!.lat, p.position!.lon]}
          icon={markerIcon(p, p.participantId === meParticipantId)}
        >
          <Popup>
            <strong>{p.name}</strong>
            {p.isLeader && " (leader)"}
            <br />
            Status: {p.status ? STATUS_STYLE[p.status].label : "—"}
            <br />
            Speed: {p.position!.speedKmph.toFixed(0)} km/h
            <br />
            Last ping: {new Date(p.position!.recordedAt).toLocaleTimeString()}
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}

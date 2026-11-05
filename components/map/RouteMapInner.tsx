"use client";
/**
 * Leaflet map of a completed ride's route. Imported only through
 * components/map/index.tsx (next/dynamic, ssr:false).
 */
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { CircleMarker, MapContainer, Polyline, Popup, TileLayer, Tooltip } from "react-leaflet";

export type RouteLine = {
  name: string;
  color: string;
  points: { lat: number; lon: number }[];
};

export type RouteMapProps = {
  lines: RouteLine[];
  height?: number | string;
};

export default function RouteMapInner({ lines, height = 420 }: RouteMapProps) {
  const all = lines.flatMap((l) => l.points.map((p) => [p.lat, p.lon] as [number, number]));
  if (all.length === 0) {
    return (
      <div style={{ height }} className="flex items-center justify-center rounded border border-dashed text-sm text-gray-500">
        No route recorded for this ride.
      </div>
    );
  }
  const bounds = L.latLngBounds(all);
  const main = lines.find((l) => l.points.length > 0)!;
  const start = main.points[0];
  const end = main.points[main.points.length - 1];

  return (
    <MapContainer bounds={bounds} boundsOptions={{ padding: [30, 30] }} style={{ height, width: "100%" }} scrollWheelZoom>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {lines.map((l, i) =>
        l.points.length > 1 ? (
          <Polyline
            key={i}
            positions={l.points.map((p) => [p.lat, p.lon] as [number, number])}
            pathOptions={{ color: l.color, weight: i === 0 ? 5 : 3, opacity: i === 0 ? 0.9 : 0.6 }}
          >
            <Tooltip sticky>{l.name}</Tooltip>
          </Polyline>
        ) : null,
      )}
      <CircleMarker center={[start.lat, start.lon]} radius={8} pathOptions={{ color: "#16a34a", fillOpacity: 1 }}>
        <Popup>Start</Popup>
      </CircleMarker>
      <CircleMarker center={[end.lat, end.lon]} radius={8} pathOptions={{ color: "#dc2626", fillOpacity: 1 }}>
        <Popup>End</Popup>
      </CircleMarker>
    </MapContainer>
  );
}

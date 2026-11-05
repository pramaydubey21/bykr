"use client";
/**
 * Client-only entry points for the maps. Leaflet needs `window`, so both maps
 * are loaded with next/dynamic and ssr:false (allowed only in a client module,
 * which is why this file is "use client").
 */
import dynamic from "next/dynamic";
import type { LiveMapProps } from "./LiveMapInner";
import type { RouteMapProps } from "./RouteMapInner";

export type { LiveMapProps, RouteMapProps };
export type { RouteLine } from "./RouteMapInner";

function MapPlaceholder() {
  return <div className="flex h-[420px] items-center justify-center rounded bg-gray-100 text-sm text-gray-500">Loading map…</div>;
}

export const LiveMap = dynamic<LiveMapProps>(() => import("./LiveMapInner"), {
  ssr: false,
  loading: MapPlaceholder,
});

export const RouteMap = dynamic<RouteMapProps>(() => import("./RouteMapInner"), {
  ssr: false,
  loading: MapPlaceholder,
});

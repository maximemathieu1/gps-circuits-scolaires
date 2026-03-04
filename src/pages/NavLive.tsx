// src/pages/NavLive.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import mapboxgl from "mapbox-gl";

import { callFn } from "@/lib/api";
import { haversineMeters } from "@/lib/geo";
import { useWakeLock } from "@/lib/useWakeLock";

/* =========================
   Types (alignés DB)
========================= */

type StopType = "school" | "school_uturn" | "uturn" | "transfer" | "ecole";
type NoteMode = "none" | "show" | "tts";

type StopPoint = {
  lat: number;
  lng: number;
  label?: string | null;
  stop_type?: StopType | null;
  note?: string | null;
  note_mode?: NoteMode | null;
  note_trigger_m?: number | null;
  note_once?: boolean | null;
};

type PointsResp = {
  version_id: string;
  points: {
    idx: number;
    lat: number;
    lng: number;
    label?: string | null;

    stop_type?: StopType | null;
    note?: string | null;
    note_mode?: NoteMode | null;
    note_trigger_m?: number | null;
    note_once?: boolean | null;
  }[];
};

type TraceResp = {
  version_id: string;
  points_count: number;
  trail: { idx: number; lat: number; lng: number }[];
  updated_at?: string;
};

type LatLng = { lat: number; lng: number };

/* =========================
   Helpers
========================= */

function useQuery() {
  const { search } = useLocation();
  return useMemo(() => new URLSearchParams(search), [search]);
}

function watchPos(
  onPos: (p: { lat: number; lng: number; acc?: number | null; heading?: number | null; speed?: number | null }) => void,
  onErr: (m: string) => void
) {
  return navigator.geolocation.watchPosition(
    (pos) =>
      onPos({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        acc: pos.coords.accuracy ?? null,
        heading: (pos.coords as any).heading ?? null,
        speed: (pos.coords as any).speed ?? null,
      }),
    (err) => onErr(err.message),
    { enableHighAccuracy: true, maximumAge: 500, timeout: 15000 }
  );
}

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

function projectMeters(originLat: number, p: LatLng) {
  const R = 6371000;
  const lat = (p.lat * Math.PI) / 180;
  const lng = (p.lng * Math.PI) / 180;
  const lat0 = (originLat * Math.PI) / 180;
  return { x: R * lng * Math.cos(lat0), y: R * lat };
}

function distPointToSegmentMeters(originLat: number, p: LatLng, a: LatLng, b: LatLng) {
  const P = projectMeters(originLat, p);
  const A = projectMeters(originLat, a);
  const B = projectMeters(originLat, b);

  const ABx = B.x - A.x;
  const ABy = B.y - A.y;
  const APx = P.x - A.x;
  const APy = P.y - A.y;

  const denom = ABx * ABx + ABy * ABy;
  if (denom <= 1e-9) return Math.hypot(P.x - A.x, P.y - A.y);

  const t = clamp((APx * ABx + APy * ABy) / denom, 0, 1);
  const cx = A.x + t * ABx;
  const cy = A.y + t * ABy;

  return Math.hypot(P.x - cx, P.y - cy);
}

function minDistanceToPolylineMeters(me: LatLng, line: [number, number][]) {
  if (!line || line.length < 2) return null;

  const originLat = me.lat;
  let best = Infinity;

  for (let i = 0; i < line.length - 1; i++) {
    const a = { lat: line[i][0], lng: line[i][1] };
    const b = { lat: line[i + 1][0], lng: line[i + 1][1] };
    const d = distPointToSegmentMeters(originLat, me, a, b);
    if (d < best) best = d;
  }

  return Number.isFinite(best) ? best : null;
}

function nearestLineIndex(me: LatLng, line: [number, number][]) {
  if (!line || line.length === 0) return null;
  let best = Infinity;
  let bestIdx = 0;
  for (let i = 0; i < line.length; i++) {
    const d = haversineMeters(me, { lat: line[i][0], lng: line[i][1] });
    if (d < best) {
      best = d;
      bestIdx = i;
    }
  }
  return { idx: bestIdx, dist: best };
}

function nearestLineIndexWindow(me: LatLng, line: [number, number][], start: number, end: number) {
  if (!line || line.length === 0) return null;
  const s = clamp(Math.floor(start), 0, line.length - 1);
  const e = clamp(Math.floor(end), 0, line.length - 1);
  const a = Math.min(s, e);
  const b = Math.max(s, e);

  let best = Infinity;
  let bestIdx = a;

  for (let i = a; i <= b; i++) {
    const d = haversineMeters(me, { lat: line[i][0], lng: line[i][1] });
    if (d < best) {
      best = d;
      bestIdx = i;
    }
  }
  return { idx: bestIdx, dist: best };
}

/* =========================
   PRO: distance "le long de la trace"
========================= */

function cumulativeDistancesMeters(line: [number, number][]) {
  const cum: number[] = [0];
  for (let i = 1; i < line.length; i++) {
    const a = { lat: line[i - 1][0], lng: line[i - 1][1] };
    const b = { lat: line[i][0], lng: line[i][1] };
    cum[i] = cum[i - 1] + haversineMeters(a, b);
  }
  return cum;
}

function distPointToSegmentWithT(originLat: number, p: LatLng, a: LatLng, b: LatLng) {
  const P = projectMeters(originLat, p);
  const A = projectMeters(originLat, a);
  const B = projectMeters(originLat, b);

  const ABx = B.x - A.x;
  const ABy = B.y - A.y;
  const APx = P.x - A.x;
  const APy = P.y - A.y;

  const denom = ABx * ABx + ABy * ABy;
  if (denom <= 1e-9) {
    return { dist: Math.hypot(P.x - A.x, P.y - A.y), t: 0 };
  }

  const t = clamp((APx * ABx + APy * ABy) / denom, 0, 1);
  const cx = A.x + t * ABx;
  const cy = A.y + t * ABy;
  return { dist: Math.hypot(P.x - cx, P.y - cy), t };
}

function projectOnPolylineAlongMeters(me: LatLng, line: [number, number][], cum: number[]) {
  if (!line || line.length < 2) return null;

  const originLat = me.lat;
  let bestDist = Infinity;
  let bestI = 0;
  let bestT = 0;

  for (let i = 0; i < line.length - 1; i++) {
    const a = { lat: line[i][0], lng: line[i][1] };
    const b = { lat: line[i + 1][0], lng: line[i + 1][1] };
    const r = distPointToSegmentWithT(originLat, me, a, b);
    if (r.dist < bestDist) {
      bestDist = r.dist;
      bestI = i;
      bestT = r.t;
    }
  }

  const segLen = Math.max(
    0.0001,
    haversineMeters(
      { lat: line[bestI][0], lng: line[bestI][1] },
      { lat: line[bestI + 1][0], lng: line[bestI + 1][1] }
    )
  );

  const along = (cum[bestI] ?? 0) + bestT * segLen;

  return { alongM: along, offM: bestDist, segIdx: bestI, t: bestT };
}

function stopAlongMetersOnPolyline(stop: LatLng, line: [number, number][], cum: number[]) {
  return projectOnPolylineAlongMeters(stop, line, cum);
}

/* =========================
   UI / Type mapping
========================= */

function stopTypeOrDefault(t?: StopType | null): StopType {
  const x = (t ?? "school") as StopType;
  return x;
}

function isBlockingType(t: StopType) {
  return t === "transfer" || t === "ecole";
}

function haloColorForType(t: StopType) {
  switch (t) {
    case "school":
      return "#FBBF24";
    case "school_uturn":
      return "#f97316";
    case "uturn":
      return "#a855f7";
    case "transfer":
      return "#06b6d4";
    case "ecole":
      return "#22c55e";
    default:
      return "#93c5fd";
  }
}

function activeLineColorForType(t: StopType) {
  switch (t) {
    case "school":
      return "#1d4ed8";
    case "school_uturn":
      return "#ea580c";
    case "uturn":
      return "#7c3aed";
    case "transfer":
      return "#0891b2";
    case "ecole":
      return "#16a34a";
    default:
      return "#1d4ed8";
  }
}

function bannerTitleForType(t: StopType) {
  switch (t) {
    case "transfer":
      return "Transfert dans";
    case "ecole":
      return "École dans";
    case "uturn":
      return "Demi-tour dans";
    case "school_uturn":
      return "Arrêt + demi-tour dans";
    default:
      return "Arrêt scolaire dans";
  }
}

function bannerIconForType(t: StopType) {
  switch (t) {
    case "transfer":
      return "🔁";
    case "ecole":
      return "🏫";
    case "uturn":
      return "↩️";
    case "school_uturn":
      return "🚌";
    default:
      return "🧒";
  }
}

/* =========================
   MP3 SFX (Safari iOS + Fully Android)
========================= */

const SOUND_URLS = {
  audioOn: "/audio/audio_on.mp3",
  stopWarning: "/audio/stop_warning.mp3",
  stopReached: "/audio/stop_reached.mp3",
  stopMissed: "/audio/stop_missed.mp3",
  circuitDone: "/audio/circuit_done.mp3",
  ding: "/audio/ding.mp3",

  demiTour: "/audio/demi_tour.mp3",
  arretScolaireDemiTour: "/audio/arret_scolaire_demi_tour.mp3",
  transfert: "/audio/transfert.mp3",
  ecole: "/audio/ecole.mp3",
} as const;

type SoundKey = keyof typeof SOUND_URLS;

function useSfx() {
  const unlockedRef = useRef(false);

  const poolRef = useRef<Record<string, HTMLAudioElement[]>>({});
  const poolPtrRef = useRef<Record<string, number>>({});
  const lastPlayAtRef = useRef<Record<string, number>>({});

  function getFromPool(key: SoundKey) {
    const k = String(key);
    if (!poolRef.current[k]) {
      const url = SOUND_URLS[key] || "";
      const poolSize = key === "ding" ? 3 : 2;

      poolRef.current[k] = Array.from({ length: poolSize }).map(() => {
        const a = new Audio(url);
        a.preload = "auto";
        a.crossOrigin = "anonymous";
        (a as any).playsInline = true;
        return a;
      });
      poolPtrRef.current[k] = 0;
    }

    const arr = poolRef.current[k];
    const ptr = poolPtrRef.current[k] ?? 0;
    const a = arr[ptr % arr.length];
    poolPtrRef.current[k] = (ptr + 1) % arr.length;
    return a;
  }

  function preloadAll() {
    (Object.keys(SOUND_URLS) as SoundKey[]).forEach((k) => {
      try {
        const a = getFromPool(k);
        a.load?.();
      } catch {}
    });
  }

  function unlock() {
    if (unlockedRef.current) return;
    try {
      const a = getFromPool("audioOn");
      a.volume = 0.001;
      a.currentTime = 0;

      const p = a.play();
      Promise.resolve(p)
        .then(() => {
          try {
            a.pause();
            a.currentTime = 0;
          } catch {}
          unlockedRef.current = true;
          try {
            a.volume = 1.0;
          } catch {}
        })
        .catch(() => {});
    } catch {}
  }

  function play(key: SoundKey, opts?: { volume?: number; cooldownMs?: number }) {
    try {
      const k = String(key);
      const now = Date.now();
      const cd = opts?.cooldownMs ?? 700;
      const last = lastPlayAtRef.current[k] ?? 0;
      if (now - last < cd) return;
      lastPlayAtRef.current[k] = now;

      const a = getFromPool(key);
      try {
        a.pause();
      } catch {}
      try {
        a.currentTime = 0;
      } catch {}
      try {
        a.volume = clamp(opts?.volume ?? 1.0, 0, 1);
      } catch {}

      a.play().catch(() => {});
    } catch {}
  }

  return { unlock, play, preloadAll };
}

function audioKeyForStopType(t: StopType): SoundKey {
  switch (t) {
    case "school_uturn":
      return "arretScolaireDemiTour";
    case "uturn":
      return "demiTour";
    case "transfer":
      return "transfert";
    case "ecole":
      return "ecole";
    default:
      return "stopWarning";
  }
}

/* =========================
   Fullscreen helpers (best-effort web)
========================= */

async function tryEnterFullscreen() {
  try {
    const el = document.documentElement as any;
    if ((document as any).fullscreenElement) return;
    if (el.requestFullscreen) await el.requestFullscreen();
    else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
  } catch {}
}

function installAutoFullscreenOnce() {
  let done = false;

  const handler = async () => {
    if (done) return;
    done = true;
    try {
      await tryEnterFullscreen();
    } catch {}
    try {
      window.removeEventListener("pointerdown", handler, { capture: true } as any);
      window.removeEventListener("touchstart", handler, { capture: true } as any);
    } catch {}
  };

  window.addEventListener("pointerdown", handler, { capture: true });
  window.addEventListener("touchstart", handler, { capture: true });
}

/* =========================
   Bearing helpers
========================= */

function wrap360(deg: number) {
  let d = deg % 360;
  if (d < 0) d += 360;
  return d;
}

function bearingDeg(a: LatLng, b: LatLng) {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;

  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lng - a.lng);

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

  let brng = toDeg(Math.atan2(y, x));
  brng = (brng + 360) % 360;
  return brng;
}

function smoothAngle(prev: number, next: number) {
  const delta = ((next - prev + 540) % 360) - 180;
  return prev + delta;
}

/* =========================
   iOS tap helper (évite le “double tap”)
========================= */

function tapHandler(fn: () => void) {
  return (e: any) => {
    try {
      e.preventDefault?.();
      e.stopPropagation?.();
    } catch {}
    fn();
  };
}

/* =========================
   Main
========================= */

export default function NavLive() {
  const q = useQuery();
  const nav = useNavigate();
  const sfx = useSfx();

  const circuitId = q.get("circuit") || "";

  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);

  // Audio state
  const [audioOn, setAudioOn] = useState(false);

  // GPS (état affichage)
  const [me, setMe] = useState<LatLng | null>(null);
  const [acc, setAcc] = useState<number | null>(null);
  const [speed, setSpeed] = useState<number | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // GPS refs (animation fluide)
  const targetPosRef = useRef<LatLng | null>(null);
  const animPosRef = useRef<LatLng | null>(null);
  const accRef = useRef<number | null>(null);
  const speedRef = useRef<number | null>(null);
  const headingRef = useRef<number | null>(null);
  const lastBearingRef = useRef<number>(0);

  // Stops
  const [points, setPoints] = useState<StopPoint[]>([]);
  const [targetIdx, setTargetIdx] = useState(0);
  const target = points[targetIdx] ?? null;

  // Notes (DB-driven)
  const [activeNote, setActiveNote] = useState<string | null>(null);
  const noteShownForIdxRef = useRef<Set<number>>(new Set()); // note_once
  const noteLastShowAtRef = useRef<Record<number, number>>({}); // anti-spam si note_once=false
  const NOTE_REPEAT_COOLDOWN_MS = 2500;

  // ✅ Anti re-pop après "Continuer" si le conducteur reste dans la zone
  const noteSuppressForIdxRef = useRef<Set<number>>(new Set());
  const NOTE_SUPPRESS_HYSTERESIS_M = 12;

  // Pause (transfert/ecole)
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  // Trace officielle
  const [officialLine, setOfficialLine] = useState<[number, number][]>([]);
  const [hasOfficial, setHasOfficial] = useState(false);

  // Distance à la polyline (info)
  const [offRouteM, setOffRouteM] = useState<number | null>(null);

  // Wake lock
  const { supported: wlSupported, active: wlActive } = useWakeLock(running);

  // Bandeau stop + sons
  const stopWarnRef = useRef<number | null>(null);
  const stopWarnMaxRef = useRef<number | null>(null);
  const stopDingRef = useRef<number | null>(null);

  const [stopBanner, setStopBanner] = useState<{ show: boolean; meters: number; label?: string | null; max: number }>(
    { show: false, meters: 0, label: null, max: 150 }
  );
  const stopBannerLastMRef = useRef<number | null>(null);

  // Mode intelligent (skip arrêt manqué)
  const stopTouchedRef = useRef(false);
  const stopMinDistRef = useRef<number>(Infinity);

  // join logique
  const joinedTraceRef = useRef<boolean>(false);

  // Anti-finish si arrêts trop proches
  const lastMeRef = useRef<LatLng | null>(null);
  const travelSinceTargetSetRef = useRef(0);
  const initialDistToTargetRef = useRef<number | null>(null);
  const MIN_TRAVEL_AFTER_TARGET_SET_M = 12;
  const ARRIVE_EPS_M = 5;

  // Follow mode
  const followRef = useRef(true);

  // ====== Tuning ======
  const ARRIVE_STOP_M = 45;
  const DING_AT_M = 10;

  function warnStopMeters() {
    const v = speedRef.current ?? null;
    const kmh = v != null ? v * 3.6 : 0;
    return kmh >= 80 ? 200 : 150;
  }

  // Arrêt manqué
  const STOP_TOUCH_M = 35;
  const STOP_SKIP_CONFIRM_M = 90;
  const STOP_SKIP_MIN_SPEED = 1.2; // m/s
  const STOP_SKIP_TRACE_AHEAD_PTS = 12;

  /* =========================
     Mapbox
  ========================= */

  const mapElRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const meMarkerRef = useRef<mapboxgl.Marker | null>(null);

  const lineRef = useRef<[number, number][]>([]);
  const stopsRef = useRef<StopPoint[]>([]);

  const MAP_LINE_SRC = "line-src";
  const MAP_LINE_LAYER = "line-layer";
  const MAP_LINE_HALO = "line-halo";

  const MAP_ACTIVE_SRC = "active-src";
  const MAP_ACTIVE_LAYER = "active-layer";
  const MAP_ACTIVE_HALO = "active-halo";

  const MAP_STOPS_SRC = "stops-src";
  const MAP_STOPS_LAYER = "stops-layer";
  const MAP_STOPS_NUM_LAYER = "stops-num-layer";

  const ACTIVE_MIN_POINTS = 12;

  const JOIN_DIST_M = 35;
  const SNAP_MAX_DIST_M = 55;

  const manualZoomRef = useRef<number | null>(null);
  const manualZoomUntilRef = useRef<number>(0);

  function lockManualZoom(z: number, ms = 2500) {
    manualZoomRef.current = z;
    manualZoomUntilRef.current = Date.now() + ms;
  }

  function ensureMapToken() {
    const token = (import.meta as any).env?.VITE_MAPBOX_TOKEN || "";
    mapboxgl.accessToken = token;
    return token;
  }

  function ensureMeMarker() {
    const m = mapRef.current;
    if (!m) return null;
    if (meMarkerRef.current) return meMarkerRef.current;

    const wrap = document.createElement("div");
    wrap.style.width = "22px";
    wrap.style.height = "22px";
    wrap.style.borderRadius = "999px";
    wrap.style.background = "#2563eb";
    wrap.style.border = "3px solid #ffffff";
    wrap.style.boxShadow = "0 10px 18px rgba(0,0,0,.25)";
    wrap.style.pointerEvents = "none";
    wrap.style.position = "relative";

    const core = document.createElement("div");
    core.style.position = "absolute";
    core.style.left = "50%";
    core.style.top = "50%";
    core.style.transform = "translate(-50%, -50%)";
    core.style.width = "7px";
    core.style.height = "7px";
    core.style.borderRadius = "999px";
    core.style.background = "#ffffff";
    core.style.opacity = "0.95";

    wrap.appendChild(core);

    const mk = new mapboxgl.Marker({ element: wrap, anchor: "center" }).setLngLat([-73.0, 46.8]).addTo(m);
    meMarkerRef.current = mk;
    return mk;
  }

  function safeRemoveLayer(m: mapboxgl.Map, id: string) {
    try {
      if (m.getLayer(id)) m.removeLayer(id);
    } catch {}
  }
  function safeRemoveSource(m: mapboxgl.Map, id: string) {
    try {
      if (m.getSource(id)) m.removeSource(id);
    } catch {}
  }

  function buildLineGeoJSON(line: [number, number][]) {
    const coords: [number, number][] = line.map(([lat, lng]) => [lng, lat]);
    return { type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: coords } };
  }

  function buildActiveSegmentGeoJSON(line: [number, number][], startIdx: number, endIdx: number) {
    if (!line || line.length < 2) return buildLineGeoJSON([]);
    const s = clamp(Math.floor(startIdx), 0, line.length - 1);
    const e = clamp(Math.floor(endIdx), 0, line.length - 1);
    const a = Math.min(s, e);
    const b = Math.max(s, e);
    const slice = line.slice(a, b + 1);
    if (slice.length < 2) {
      const fallback = line.slice(Math.max(0, b - 1), b + 1);
      return buildLineGeoJSON(fallback);
    }
    return buildLineGeoJSON(slice);
  }

  function buildStopsGeoJSON(pts: StopPoint[], activeIdx: number) {
    return {
      type: "FeatureCollection" as const,
      features: pts.map((p, i) => ({
        type: "Feature" as const,
        properties: {
          idx: i,
          num: String(i + 1),
          label: p.label ?? "",
          active: i === activeIdx ? 1 : 0,
          t: stopTypeOrDefault(p.stop_type),
        },
        geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] as [number, number] },
      })),
    };
  }

  const FULL_LINE_WIDTH: any = ["interpolate", ["linear"], ["zoom"], 13, 3.8, 15, 5.0, 17, 6.3, 19, 7.4];
  const FULL_HALO_WIDTH: any = ["interpolate", ["linear"], ["zoom"], 13, 7.4, 15, 9.8, 17, 12.4, 19, 14.8];

  const ACTIVE_LINE_WIDTH: any = ["interpolate", ["linear"], ["zoom"], 13, 7.2, 15, 9.8, 17, 12.8, 19, 15.8];
  const ACTIVE_HALO_WIDTH: any = ["interpolate", ["linear"], ["zoom"], 13, 12.2, 15, 16.8, 17, 22.6, 19, 28.2];

  /* =========================
     Stop index sur trace (monotone forward)
  ========================= */

  const stopIdxOnTrace = useMemo(() => {
    if (!hasOfficial || officialLine.length < 2) return [];
    if (!points.length) return [];

    const line = officialLine;
    const out: number[] = [];

    const AHEAD_WINDOW = Math.min(2500, Math.max(400, Math.floor(line.length * 0.25)));

    const first = nearestLineIndex({ lat: points[0].lat, lng: points[0].lng }, line);
    let prevIdx = clamp(first?.idx ?? 0, 0, line.length - 1);
    out.push(prevIdx);

    for (let i = 1; i < points.length; i++) {
      const p = points[i];

      const near = nearestLineIndexWindow(
        { lat: p.lat, lng: p.lng },
        line,
        prevIdx,
        Math.min(line.length - 1, prevIdx + AHEAD_WINDOW)
      );

      const pick = near ?? nearestLineIndex({ lat: p.lat, lng: p.lng }, line);
      let idx = clamp(pick?.idx ?? prevIdx, 0, line.length - 1);

      if (idx <= prevIdx) idx = Math.min(prevIdx + 1, line.length - 1);

      out.push(idx);
      prevIdx = idx;
    }

    return out;
  }, [hasOfficial, officialLine, points]);

  function getActiveSegmentIdxs(fullLineLen: number) {
    const last = Math.max(0, fullLineLen - 1);

    const safeStop0 = stopIdxOnTrace[0];
    if (!stopIdxOnTrace.length || safeStop0 == null) {
      return { start: 0, end: clamp(ACTIVE_MIN_POINTS, 1, last) };
    }

    if (targetIdx <= 0) {
      return { start: 0, end: clamp(stopIdxOnTrace[0], 1, last) };
    }

    const prevStopTrace = clamp(stopIdxOnTrace[targetIdx - 1] ?? 0, 0, last);
    const curStopTrace = clamp(stopIdxOnTrace[targetIdx] ?? (prevStopTrace + 1), 0, last);

    const start = Math.min(prevStopTrace, curStopTrace);
    const end = Math.max(prevStopTrace, curStopTrace);

    if (end <= start) return { start: Math.max(0, end - 1), end };
    return { start, end };
  }

  function applyOverlays() {
    const m = mapRef.current;
    if (!m || !m.isStyleLoaded()) return;

    const fullLine = lineRef.current;
    const pts = stopsRef.current;

    safeRemoveLayer(m, MAP_LINE_LAYER);
    safeRemoveLayer(m, MAP_LINE_HALO);
    safeRemoveSource(m, MAP_LINE_SRC);

    safeRemoveLayer(m, MAP_ACTIVE_LAYER);
    safeRemoveLayer(m, MAP_ACTIVE_HALO);
    safeRemoveSource(m, MAP_ACTIVE_SRC);

    safeRemoveLayer(m, MAP_STOPS_NUM_LAYER);
    safeRemoveLayer(m, MAP_STOPS_LAYER);
    safeRemoveSource(m, MAP_STOPS_SRC);

    // TRACE COMPLETE
    if (fullLine && fullLine.length >= 2) {
      try {
        const geo = buildLineGeoJSON(fullLine);
        m.addSource(MAP_LINE_SRC, { type: "geojson", data: geo as any });

        m.addLayer({
          id: MAP_LINE_HALO,
          type: "line",
          source: MAP_LINE_SRC,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": "#FFFFFF", "line-width": FULL_HALO_WIDTH, "line-opacity": 0.55, "line-blur": 0.25 },
        });

        m.addLayer({
          id: MAP_LINE_LAYER,
          type: "line",
          source: MAP_LINE_SRC,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": "#2563eb", "line-width": FULL_LINE_WIDTH, "line-opacity": 0.58, "line-blur": 0.06 },
        });
      } catch (e) {
        console.error("Mapbox apply full line failed:", e);
      }
    }

    // TRACE ACTIVE
    if (fullLine && fullLine.length >= 2) {
      try {
        const { start, end } = getActiveSegmentIdxs(fullLine.length);
        const activeGeo = buildActiveSegmentGeoJSON(fullLine, start, end);

        m.addSource(MAP_ACTIVE_SRC, { type: "geojson", data: activeGeo as any });

        m.addLayer({
          id: MAP_ACTIVE_HALO,
          type: "line",
          source: MAP_ACTIVE_SRC,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": "#93c5fd", "line-width": ACTIVE_HALO_WIDTH, "line-opacity": 0.28, "line-blur": 1.15 },
        });

        m.addLayer({
          id: MAP_ACTIVE_LAYER,
          type: "line",
          source: MAP_ACTIVE_SRC,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": "#1d4ed8", "line-width": ACTIVE_LINE_WIDTH, "line-opacity": 1.0, "line-blur": 0.02 },
        });
      } catch (e) {
        console.error("Mapbox apply active line failed:", e);
      }
    }

    // STOPS
    if (pts && pts.length > 0) {
      const fc = buildStopsGeoJSON(pts, targetIdx);
      try {
        m.addSource(MAP_STOPS_SRC, { type: "geojson", data: fc as any });

        m.addLayer({
          id: MAP_STOPS_LAYER,
          type: "circle",
          source: MAP_STOPS_SRC,
          paint: {
            "circle-radius": 16,
            "circle-color": [
              "match",
              ["get", "t"],
              "school",
              "#ef4444",
              "school_uturn",
              "#f97316",
              "uturn",
              "#a855f7",
              "transfer",
              "#06b6d4",
              "ecole",
              "#22c55e",
              "#ef4444",
            ],
            "circle-stroke-width": 6,
            "circle-stroke-color": "#ffffff",
          },
        });

        m.addLayer({
          id: MAP_STOPS_NUM_LAYER,
          type: "symbol",
          source: MAP_STOPS_SRC,
          layout: {
            "text-field": ["get", "num"],
            "text-size": 16,
            "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
            "text-allow-overlap": true,
            "text-ignore-placement": true,
          },
          paint: { "text-color": "#ffffff", "text-halo-color": "rgba(0,0,0,0.55)", "text-halo-width": 1.6 },
        });
      } catch (e) {
        console.error("Mapbox apply stops failed:", e);
      }
    }
  }

  function upsertStopsOnMap() {
    const m = mapRef.current;
    if (!m || !m.isStyleLoaded()) return;

    try {
      const src = m.getSource(MAP_STOPS_SRC) as mapboxgl.GeoJSONSource | undefined;
      const data = buildStopsGeoJSON(stopsRef.current, targetIdx) as any;

      if (src) {
        src.setData(data);
        if (!m.getLayer(MAP_STOPS_LAYER) || !m.getLayer(MAP_STOPS_NUM_LAYER)) applyOverlays();
      } else {
        applyOverlays();
      }
    } catch (e) {
      console.error("upsertStopsOnMap failed:", e);
      applyOverlays();
    }
  }

  const lastActiveUpdateRef = useRef<{ t: number; targetIdx: number }>({ t: 0, targetIdx: -1 });

  function upsertActiveLineOnMap() {
    const m = mapRef.current;
    if (!m || !m.isStyleLoaded()) return;

    try {
      const full = lineRef.current;
      if (!full || full.length < 2) return;

      const now = performance.now();
      const last = lastActiveUpdateRef.current;
      const targetChanged = targetIdx !== last.targetIdx;
      const timeOk = now - last.t >= 250;

      if (!targetChanged && !timeOk) return;

      lastActiveUpdateRef.current = { t: now, targetIdx };

      const src = m.getSource(MAP_ACTIVE_SRC) as mapboxgl.GeoJSONSource | undefined;

      const { start, end } = getActiveSegmentIdxs(full.length);
      const data = buildActiveSegmentGeoJSON(full, start, end) as any;

      if (src) {
        src.setData(data);
        if (!m.getLayer(MAP_ACTIVE_LAYER) || !m.getLayer(MAP_ACTIVE_HALO)) applyOverlays();
      } else {
        applyOverlays();
      }

      const tt = stopTypeOrDefault(target?.stop_type);
      const halo = haloColorForType(tt);
      const lineCol = activeLineColorForType(tt);

      try {
        if (m.getLayer(MAP_ACTIVE_HALO)) m.setPaintProperty(MAP_ACTIVE_HALO, "line-color", halo);
        if (m.getLayer(MAP_ACTIVE_LAYER)) m.setPaintProperty(MAP_ACTIVE_LAYER, "line-color", lineCol);
      } catch {}
    } catch (e) {
      console.error("upsertActiveLineOnMap failed:", e);
      applyOverlays();
    }
  }

  function ensureMap() {
    if (mapRef.current) return mapRef.current;
    if (!mapElRef.current) return null;

    const token = ensureMapToken();
    if (!token) {
      setErr("Mapbox: token manquant (VITE_MAPBOX_TOKEN).");
      return null;
    }

    const m = new mapboxgl.Map({
      container: mapElRef.current,
      style: "mapbox://styles/mapbox/streets-v12",
      center: [-73.0, 46.8],
      zoom: 16.0,
      pitch: 55,
      bearing: 0,
      attributionControl: false,
    });

    mapRef.current = m;

    m.on("dragstart", (e: any) => e?.originalEvent && (followRef.current = false));
    m.on("pitchstart", (e: any) => e?.originalEvent && (followRef.current = false));
    m.on("rotatestart", (e: any) => e?.originalEvent && (followRef.current = false));
    m.on("zoomstart", (e: any) => e?.originalEvent && (followRef.current = false));

    m.on("load", () => {
      applyOverlays();
      try {
        m.resize();
      } catch {}
    });

    m.on("style.load", () => applyOverlays());

    return m;
  }

  function zoomIn() {
    const m = mapRef.current;
    if (!m) return;
    try {
      m.stop();
    } catch {}

    const z = clamp(m.getZoom() + 0.9, 2, 20);
    lockManualZoom(z);

    try {
      m.easeTo({ zoom: z, duration: 140, easing: (t) => t, essential: true });
    } catch {}
  }

  function zoomOut() {
    const m = mapRef.current;
    if (!m) return;
    try {
      m.stop();
    } catch {}

    const z = clamp(m.getZoom() - 0.9, 2, 20);
    lockManualZoom(z);

    try {
      m.easeTo({ zoom: z, duration: 140, easing: (t) => t, essential: true });
    } catch {}
  }

  function computeFollowOffsetPx(m: mapboxgl.Map) {
    const h = m.getCanvas().clientHeight || window.innerHeight;
    const usable = Math.max(280, h - 140);

    const v = speedRef.current ?? null;
    const kmh = v != null ? v * 3.6 : 0;

    const base = Math.round(usable * 0.22);
    const extra = Math.round(clamp(kmh * 0.6, 0, 35));
    const yOff = clamp(base + extra, 30, 120);

    return yOff;
  }

  function recenter() {
    followRef.current = true;

    const m = mapRef.current;
    const p = animPosRef.current ?? me;
    if (!m || !p) return;

    try {
      m.stop();
    } catch {}

    manualZoomRef.current = null;
    manualZoomUntilRef.current = 0;

    const v = speedRef.current ?? null;
    const kmh = v != null ? v * 3.6 : 0;
    const targetZoom = kmh >= 60 ? 17.2 : kmh >= 25 ? 16.6 : 16.1;

    const yOff = computeFollowOffsetPx(m);
    const b = wrap360((headingRef.current ?? lastBearingRef.current) || 0);

    try {
      (m as any).jumpTo({
        center: [p.lng, p.lat],
        zoom: targetZoom,
        pitch: 55,
        bearing: b,
        offset: [0, yOff],
      });
    } catch {}
  }

  function enableAudio() {
    if (audioOn) return;
    sfx.unlock();
    sfx.preloadAll();
    sfx.play("audioOn", { volume: 1.0, cooldownMs: 0 });
    setAudioOn(true);
  }

  function clearNoteNow() {
    setActiveNote(null);
  }

  function speakNoteTTS(text: string) {
    try {
      if (!(window as any).speechSynthesis) return;
      const s = (window as any).speechSynthesis as SpeechSynthesis;
      try {
        s.cancel();
      } catch {}
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "fr-CA";
      u.rate = 1.0;
      u.pitch = 1.0;
      s.speak(u);
    } catch {}
  }

  function resumeAfterNote() {
    noteSuppressForIdxRef.current.add(targetIdx);
    setPaused(false);
    clearNoteNow();
  }

  function stop() {
    setRunning(false);
    setFinished(false);

    stopTouchedRef.current = false;
    stopMinDistRef.current = Infinity;

    lastMeRef.current = null;
    travelSinceTargetSetRef.current = 0;
    initialDistToTargetRef.current = null;

    joinedTraceRef.current = false;

    setPaused(false);
    clearNoteNow();

    nav("/");
  }

  /* =========================
     PRO: refs distance "le long de la trace"
  ========================= */

  const cumRef = useRef<number[]>([]);
  const meAlongRef = useRef<number | null>(null);
  const meOffRef = useRef<number | null>(null);
  const stopAlongRef = useRef<number[]>([]);

  /* =========================
     Load circuit
  ========================= */

  async function loadCircuit() {
    if (!circuitId) throw new Error("Circuit manquant.");

    const r = await callFn<PointsResp>("circuits-api", { action: "get_active_points", circuit_id: circuitId });
    const pts: StopPoint[] = r.points.map((p) => ({
      lat: p.lat,
      lng: p.lng,
      label: p.label ?? null,

      stop_type: (p.stop_type ?? "school") as StopType,
      note: p.note ?? null,
      note_mode: (p.note_mode ?? "none") as NoteMode,
      note_trigger_m: p.note_trigger_m ?? null,
      note_once: p.note_once ?? null,
    }));
    if (pts.length === 0) throw new Error("Ce circuit n’a aucun arrêt enregistré.");

    const tr = await callFn<TraceResp>("circuits-api", { action: "get_latest_trace", circuit_id: circuitId });
    const line: [number, number][] = (tr.trail ?? []).map((p) => [p.lat, p.lng]);
    if (line.length < 2) throw new Error("Trace officielle introuvable (aucun trail).");

    // PRO: cumul + stopAlong
    const cum = cumulativeDistancesMeters(line);
    cumRef.current = cum;

    const stopAlong: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const pr = stopAlongMetersOnPolyline({ lat: pts[i].lat, lng: pts[i].lng }, line, cum);
      stopAlong[i] = pr?.alongM ?? (stopAlong[i - 1] ?? 0);
    }
    stopAlongRef.current = stopAlong;

    meAlongRef.current = null;
    meOffRef.current = null;

    setPoints(pts);
    setTargetIdx(0);

    setOfficialLine(line);
    setHasOfficial(true);

    setFinished(false);

    lastActiveUpdateRef.current = { t: 0, targetIdx: -1 };

    stopWarnRef.current = null;
    stopWarnMaxRef.current = null;
    stopDingRef.current = null;
    stopBannerLastMRef.current = null;
    setStopBanner({ show: false, meters: 0, label: null, max: 150 });

    stopTouchedRef.current = false;
    stopMinDistRef.current = Infinity;

    travelSinceTargetSetRef.current = 0;
    initialDistToTargetRef.current = null;

    setPaused(false);
    clearNoteNow();
    noteShownForIdxRef.current = new Set();
    noteLastShowAtRef.current = {};
    noteSuppressForIdxRef.current = new Set();

    lineRef.current = line;
    stopsRef.current = pts;

    const m = ensureMap();
    if (m) {
      applyOverlays();
      ensureMeMarker();
      upsertActiveLineOnMap();
    }
  }

  /* =========================
     AUTO START
  ========================= */

  async function startAuto() {
    setErr(null);

    if (!circuitId) {
      setErr("Circuit manquant.");
      return;
    }

    setRunning(true);

    tryEnterFullscreen();
    installAutoFullscreenOnce();

    const got = await new Promise<{ lat: number; lng: number; acc?: number | null }>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (p) =>
          resolve({
            lat: p.coords.latitude,
            lng: p.coords.longitude,
            acc: p.coords.accuracy ?? null,
          }),
        (e) => reject(new Error(e.message)),
        { enableHighAccuracy: true, maximumAge: 500, timeout: 15000 }
      );
    });

    const initial = { lat: got.lat, lng: got.lng };

    targetPosRef.current = initial;
    animPosRef.current = initial;

    setMe(initial);
    setAcc(got.acc ?? null);
    accRef.current = got.acc ?? null;

    lastMeRef.current = initial;
    travelSinceTargetSetRef.current = 0;
    initialDistToTargetRef.current = null;

    setTimeout(() => {
      ensureMap();
      ensureMeMarker();
    }, 0);

    await loadCircuit();

    try {
      const m = mapRef.current;
      if (m) {
        followRef.current = true;
        const yOff = computeFollowOffsetPx(m);
        (m as any).jumpTo({ center: [initial.lng, initial.lat], zoom: 16.1, bearing: 0, pitch: 55, offset: [0, yOff] });
      }
    } catch {}
  }

  useEffect(() => {
    if (!circuitId) return;
    if (running) return;

    startAuto().catch((e: any) => {
      setErr(e?.message || "Erreur démarrage.");
      setRunning(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [circuitId]);

  /* =========================
     GPS tracking
  ========================= */

  useEffect(() => {
    if (!running) return;

    let watchId: number | null = null;

    watchId = watchPos(
      (p) => {
        const raw = { lat: p.lat, lng: p.lng };
        targetPosRef.current = raw;

        setAcc(p.acc ?? null);
        setSpeed(p.speed ?? null);
        accRef.current = p.acc ?? null;
        speedRef.current = p.speed ?? null;

        const hd = p.heading ?? null;
        if (hd != null && Number.isFinite(hd)) {
          setHeading(hd);
          headingRef.current = hd;
          lastBearingRef.current = hd;
        } else {
          setHeading(null);
          headingRef.current = null;
        }
      },
      (m) => setErr(m)
    );

    return () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    };
  }, [running]);

  /* =========================
     Animation loop + follow + rotation
  ========================= */

  useEffect(() => {
    if (!running) return;

    let raf = 0;
    let lastT = performance.now();

    const tick = (t: number) => {
      const dt = Math.max(0, Math.min(0.05, (t - lastT) / 1000));
      lastT = t;

      const targetP = targetPosRef.current;
      if (targetP) {
        const cur = animPosRef.current ?? targetP;

        const k = 1 - Math.pow(0.001, dt);
        const next = {
          lat: cur.lat + (targetP.lat - cur.lat) * clamp(k * 6.0, 0.05, 0.9),
          lng: cur.lng + (targetP.lng - cur.lng) * clamp(k * 6.0, 0.05, 0.9),
        };

        const sp = speedRef.current ?? null;
        const movingEnough = sp == null ? true : sp >= 0.6;

        if ((headingRef.current == null || !Number.isFinite(headingRef.current)) && movingEnough) {
          const d = haversineMeters(cur, next);
          if (d >= 1.2) {
            const b = bearingDeg(cur, next);
            const prev = wrap360(lastBearingRef.current || 0);
            lastBearingRef.current = wrap360(smoothAngle(prev, b));
          }
        } else if (headingRef.current != null && Number.isFinite(headingRef.current)) {
          lastBearingRef.current = wrap360(headingRef.current);
        }

        animPosRef.current = next;
        setMe(next);

        const m = ensureMap();
        if (m) {
          ensureMeMarker()?.setLngLat([next.lng, next.lat]);

          // PRO: projection continue sur la trace (distance le long de la polyline)
          if (hasOfficial && lineRef.current.length >= 2) {
            const line = lineRef.current;
            const cum = cumRef.current;
            const pr = projectOnPolylineAlongMeters(next, line, cum);

            if (pr) {
              meAlongRef.current = pr.alongM;
              meOffRef.current = pr.offM;

              if (!joinedTraceRef.current) {
                if (pr.offM <= JOIN_DIST_M) joinedTraceRef.current = true;
              } else {
                if (pr.offM > SNAP_MAX_DIST_M * 1.8) joinedTraceRef.current = false;
              }
            } else {
              meAlongRef.current = null;
              meOffRef.current = null;
            }
          }

          upsertActiveLineOnMap();

          if (m.isStyleLoaded()) {
            if (!m.getLayer(MAP_LINE_LAYER) && lineRef.current.length >= 2) applyOverlays();
            if (!m.getLayer(MAP_STOPS_LAYER) && stopsRef.current.length > 0) applyOverlays();
            if (!m.getLayer(MAP_ACTIVE_LAYER) && lineRef.current.length >= 2) applyOverlays();
          }

          if (followRef.current) {
            const v = speedRef.current ?? null;
            const kmh = v != null ? v * 3.6 : 0;
            const computedZoom = kmh >= 60 ? 17.2 : kmh >= 25 ? 16.6 : 16.1;

            const zoomLocked = Date.now() < manualZoomUntilRef.current && manualZoomRef.current != null;
            const targetZoom = zoomLocked ? (manualZoomRef.current as number) : computedZoom;

            const yOff = computeFollowOffsetPx(m);
            const b = wrap360(lastBearingRef.current || 0);

            try {
              m.stop();
            } catch {}

            try {
              (m as any).easeTo({
                center: [next.lng, next.lat],
                zoom: targetZoom,
                pitch: 55,
                bearing: b,
                offset: [0, yOff],
                duration: 260,
                easing: (x: number) => x,
                essential: true,
              });
            } catch {}
          }
        }
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, hasOfficial, targetIdx, stopIdxOnTrace]);

  /* =========================
     Quand le targetIdx change
  ========================= */
  useEffect(() => {
    if (!running) return;
    upsertStopsOnMap();
    upsertActiveLineOnMap();

    setPaused(false);
    clearNoteNow();

    noteSuppressForIdxRef.current.delete(targetIdx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetIdx, running]);

  /* =========================
     Distance à la trace (info)
  ========================= */
  useEffect(() => {
    if (!running) return;
    const p = animPosRef.current ?? me;
    if (!p) return;
    if (!hasOfficial || officialLine.length < 2) return;

    // PRO: off-route stable
    const off = meOffRef.current ?? minDistanceToPolylineMeters(p, officialLine);
    setOffRouteM(off);
  }, [running, me, hasOfficial, officialLine]);

  /* =========================
     Stops + bandeau + sons + skip + notes (PRO)
  ========================= */
  useEffect(() => {
    if (!running) return;
    const p = animPosRef.current ?? me;
    if (!p || !target) return;
    if (finished) return;

    if (lastMeRef.current) travelSinceTargetSetRef.current += haversineMeters(lastMeRef.current, p);
    lastMeRef.current = p;

    if (initialDistToTargetRef.current == null && target) {
      initialDistToTargetRef.current = haversineMeters(p, target as any);
    }

    const t = stopTypeOrDefault(target.stop_type);

    // ✅ notes: proximité réelle au point (haversine) => trigger exact (20m = 20m)
    const dStop = haversineMeters(p, target as any);
    const rawStopM = Math.round(dStop);

    // ✅ bandeau/warn: distance "sur trace" (polyline)
    const meAlong = meAlongRef.current;
    const stopAlong = stopAlongRef.current[targetIdx] ?? null;

    let traceAheadM: number | null = null;
    if (meAlong != null && stopAlong != null) {
      traceAheadM = Math.max(0, stopAlong - meAlong);
    }

    const distForBanner = traceAheadM != null ? Math.round(traceAheadM) : rawStopM;
    const distForWarn = distForBanner;
    const distForNotes = rawStopM;

    const dynamicMax = warnStopMeters();
    if (stopWarnMaxRef.current == null) stopWarnMaxRef.current = dynamicMax;
    const WARN_STOP_M = stopWarnMaxRef.current ?? dynamicMax;

    // ✅ IMPORTANT: aucun minimum imposé (2m/5m/20m ok)
    const noteTriggerM = clamp(Number(target.note_trigger_m ?? WARN_STOP_M), 0, 1200);

    // Bandeau
    if (distForBanner > WARN_STOP_M) {
      if (stopBanner.show) setStopBanner({ show: false, meters: 0, label: null, max: WARN_STOP_M });
      stopBannerLastMRef.current = null;
    }

    if (distForBanner <= WARN_STOP_M && distForBanner > ARRIVE_STOP_M) {
      const prevShown = stopBannerLastMRef.current;
      let shown = prevShown == null ? distForBanner : Math.min(prevShown, distForBanner);
      shown = Math.round(shown / 5) * 5;
      stopBannerLastMRef.current = shown;

      setStopBanner({ show: true, meters: shown, label: target.label ?? null, max: WARN_STOP_M });
    }

    // ✅ Audio d’approche: dès qu’on ENTRE dans la zone WARN (1 fois)
    if (audioOn && stopWarnRef.current !== targetIdx) {
      if (distForWarn <= WARN_STOP_M && distForWarn > ARRIVE_STOP_M) {
        stopWarnRef.current = targetIdx;
        const key = audioKeyForStopType(t);
        sfx.play(key, { volume: 1.0, cooldownMs: 2500 });
      }
    }

    // Ding proche (proximité au point)
    if (audioOn && distForNotes <= DING_AT_M && distForNotes > 1) {
      if (stopDingRef.current !== targetIdx) {
        stopDingRef.current = targetIdx;
        sfx.play("ding", { volume: 1.0, cooldownMs: 900 });
      }
    }

    /* =========================
       NOTES
       - École/Transfert: overlay + pause + bouton Continuer (même si note_mode = none)
       - Autres: TTS seulement
       - Trigger respecté
       - Anti repop: après "Continuer", ne réaffiche pas tant qu'on reste dans la zone
    ========================= */

    const noteRaw = String(target.note ?? "").trim();
    const hasNote = noteRaw.length > 0;

    const inNoteZone = distForNotes <= noteTriggerM;

    // libère suppression quand on sort du rayon (+ hysteresis)
    if (noteSuppressForIdxRef.current.has(targetIdx) && distForNotes > noteTriggerM + NOTE_SUPPRESS_HYSTERESIS_M) {
      noteSuppressForIdxRef.current.delete(targetIdx);
    }

    if (hasNote && inNoteZone) {
      const once = Boolean(target.note_once ?? true);
      const alreadyOnce = noteShownForIdxRef.current.has(targetIdx);

      const now = Date.now();
      const last = noteLastShowAtRef.current[targetIdx] ?? 0;
      const cooldownOk = now - last >= NOTE_REPEAT_COOLDOWN_MS;

      const canShow = once ? !alreadyOnce : cooldownOk;
      const suppressed = noteSuppressForIdxRef.current.has(targetIdx);

      if (canShow && !suppressed) {
        noteLastShowAtRef.current[targetIdx] = now;
        if (once) noteShownForIdxRef.current.add(targetIdx);

        if (isBlockingType(t)) {
          setPaused(true);
          setActiveNote(noteRaw);
          if (audioOn) speakNoteTTS(noteRaw);
        } else {
          if (audioOn) speakNoteTTS(noteRaw);
        }
      }
    }

    // Paused => on bloque skip/arrive
    if (pausedRef.current) return;

    // SKIP arrêt manqué (conservé tel quel, basé sur traceIdxOnTrace)
    if (hasOfficial && officialLine.length >= 2) {
      const speedNow = speedRef.current ?? null;

      if (rawStopM < stopMinDistRef.current) stopMinDistRef.current = rawStopM;
      if (stopMinDistRef.current <= STOP_TOUCH_M) stopTouchedRef.current = true;

      const stopTraceIdx = stopIdxOnTrace[targetIdx] ?? 0;

      const movingOk = speedNow == null ? true : speedNow >= STOP_SKIP_MIN_SPEED;

      // (on garde un critère simple: si on s'éloigne beaucoup après avoir touché)
      const clearlyMovingAway = stopTouchedRef.current && rawStopM >= STOP_SKIP_CONFIRM_M;

      // fallback: si stopIdxOnTrace existe, on peut estimer un “past” en comparant distance sur trace
      let clearlyPastStopOnTrace = false;
      if (meAlong != null && stopAlong != null) {
        clearlyPastStopOnTrace = meAlong >= stopAlong + 35; // 35m après le stop le long de la trace
      } else {
        clearlyPastStopOnTrace = stopTraceIdx + STOP_SKIP_TRACE_AHEAD_PTS <= (stopIdxOnTrace[targetIdx] ?? stopTraceIdx);
      }

      if (movingOk && clearlyMovingAway && clearlyPastStopOnTrace) {
        const nextIdx = targetIdx + 1;
        if (nextIdx < points.length) {
          if (audioOn) sfx.play("stopMissed", { volume: 1.0, cooldownMs: 1200 });
          setTargetIdx(nextIdx);

          travelSinceTargetSetRef.current = 0;
          initialDistToTargetRef.current = null;

          stopTouchedRef.current = false;
          stopMinDistRef.current = Infinity;

          stopWarnRef.current = null;
          stopWarnMaxRef.current = null;
          stopDingRef.current = null;
          stopBannerLastMRef.current = null;
          setStopBanner({ show: false, meters: 0, label: null, max: warnStopMeters() });

          clearNoteNow();
          setPaused(false);

          return;
        }
      }
    }

    // ARRIVÉE (proximité point)
    const initD = initialDistToTargetRef.current;
    const allowArrive =
      initD == null || initD > ARRIVE_STOP_M + ARRIVE_EPS_M || travelSinceTargetSetRef.current >= MIN_TRAVEL_AFTER_TARGET_SET_M;

    if (dStop <= ARRIVE_STOP_M && allowArrive) {
      setStopBanner({ show: false, meters: 0, label: null, max: WARN_STOP_M });

      const nextIdx = targetIdx + 1;
      if (nextIdx < points.length) {
        travelSinceTargetSetRef.current = 0;
        const nextTarget = points[nextIdx] ?? null;
        initialDistToTargetRef.current = nextTarget ? haversineMeters(p, nextTarget as any) : null;

        if (audioOn) sfx.play("stopReached", { volume: 1.0, cooldownMs: 1200 });
        setTargetIdx(nextIdx);

        stopWarnRef.current = null;
        stopWarnMaxRef.current = null;
        stopDingRef.current = null;
        stopBannerLastMRef.current = null;

        stopTouchedRef.current = false;
        stopMinDistRef.current = Infinity;

        clearNoteNow();
        setPaused(false);
      } else {
        travelSinceTargetSetRef.current = 0;
        initialDistToTargetRef.current = null;

        if (audioOn) sfx.play("circuitDone", { volume: 1.0, cooldownMs: 1500 });
        setFinished(true);

        stopWarnRef.current = null;
        stopWarnMaxRef.current = null;
        stopDingRef.current = null;
        stopBannerLastMRef.current = null;

        stopTouchedRef.current = false;
        stopMinDistRef.current = Infinity;

        clearNoteNow();
        setPaused(false);
      }
    }
  }, [
    running,
    me,
    target,
    targetIdx,
    points,
    finished,
    stopBanner.show,
    hasOfficial,
    officialLine,
    stopIdxOnTrace,
    audioOn,
  ]);

  /* =========================
     UI
  ========================= */

  const overlayBtn: React.CSSProperties = {
    width: 48,
    height: 48,
    borderRadius: 14,
    border: "1px solid rgba(0,0,0,.12)",
    background: "#ffffff",
    boxShadow: "0 10px 24px rgba(0,0,0,.18)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 22,
    fontWeight: 900,
    cursor: "pointer",
    userSelect: "none",
    touchAction: "none",
    WebkitTapHighlightColor: "transparent",
    WebkitTouchCallout: "none",
  };

  const dangerBtn: React.CSSProperties = {
    ...overlayBtn,
    background: "#ef4444",
    color: "#fff",
    border: "1px solid rgba(0,0,0,.08)",
    boxShadow: "0 16px 34px rgba(0,0,0,.22)",
  };

  const hasBanner = !!stopBanner.show;

  const topStack: React.CSSProperties = {
    position: "absolute",
    top: "calc(env(safe-area-inset-top) + 10px)",
    left: 12,
    right: 12,
    zIndex: 20000,
    pointerEvents: "none",
    display: "grid",
    gap: hasBanner ? 10 : 0,
  };

  const topButtonsRow: React.CSSProperties = {
    pointerEvents: "auto",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
  };

  const zoomCol: React.CSSProperties = {
    display: "grid",
    gap: 10,
    pointerEvents: "auto",
  };

  // ✅ overlay note centré + gros texte
  const noteOverlayWrap: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    zIndex: 24000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    background: "rgba(0,0,0,.45)",
    pointerEvents: "auto",
  };

  const noteCard: React.CSSProperties = {
    width: "min(92vw, 900px)",
    background: "rgba(17,24,39,.96)",
    color: "#fff",
    border: "2px solid rgba(255,255,255,.15)",
    borderRadius: 24,
    padding: "28px 32px",
    boxShadow: "0 30px 80px rgba(0,0,0,.55)",
    display: "grid",
    gap: 22,
    textAlign: "center",
  };

  const noteHeaderRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10 };

  const noteBadge: React.CSSProperties = {
    width: 46,
    height: 46,
    borderRadius: 16,
    background: paused ? "#FBBF24" : "rgba(255,255,255,.14)",
    color: paused ? "#111827" : "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 22,
    fontWeight: 900,
    flex: "0 0 auto",
  };

  const noteBtn: React.CSSProperties = {
    width: "100%",
    height: 64,
    fontSize: 22,
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,.12)",
    background: "#FBBF24",
    color: "#111827",
    fontWeight: 950,
    cursor: "pointer",
    touchAction: "none",
    WebkitTapHighlightColor: "transparent",
  };

  const t = stopTypeOrDefault(target?.stop_type);

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative", overflow: "hidden", background: "#0b1220" }}>
      <div ref={mapElRef} style={{ width: "100%", height: "100%" }} />

      {/* Note overlay (bloquante pour transfert/ecole) */}
      {activeNote ? (
        <div style={noteOverlayWrap}>
          <div style={noteCard}>
            <div style={noteHeaderRow}>
              <div style={noteBadge} aria-hidden>
                {paused ? "⏸️" : "📝"}
              </div>

              <div style={{ flex: 1, textAlign: "left" }}>
                <div style={{ fontWeight: 950, fontSize: 18, lineHeight: 1.15 }}>{paused ? "Note (pause)" : "Note"}</div>
                <div style={{ fontSize: 13, opacity: 0.85 }}>
                  {t === "transfer"
                    ? "Transfert"
                    : t === "ecole"
                      ? "École"
                      : t === "uturn"
                        ? "Demi-tour"
                        : t === "school_uturn"
                          ? "Scolaire + demi-tour"
                          : "Scolaire"}
                </div>
              </div>

              {!paused ? (
                <button
                  style={{ ...overlayBtn, width: 46, height: 46, borderRadius: 16, fontSize: 18 }}
                  onPointerDown={tapHandler(clearNoteNow)}
                  onTouchStart={tapHandler(clearNoteNow)}
                  onClick={tapHandler(clearNoteNow)}
                  aria-label="Fermer note"
                  title="Fermer"
                >
                  ✕
                </button>
              ) : null}
            </div>

            <div
              style={{
                fontSize: 42,
                fontWeight: 950,
                lineHeight: 1.22,
                whiteSpace: "pre-wrap",
                letterSpacing: 0.2,
              }}
            >
              {activeNote}
            </div>

            {paused ? (
              <button
                style={noteBtn}
                onPointerDown={tapHandler(resumeAfterNote)}
                onTouchStart={tapHandler(resumeAfterNote)}
                onClick={tapHandler(resumeAfterNote)}
              >
                Continuer
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div style={topStack}>
        {stopBanner.show &&
          (() => {
            const MAX = Number.isFinite(stopBanner.max) ? stopBanner.max : 150;
            const meters = Number.isFinite(stopBanner.meters) ? stopBanner.meters : 0;
            const m = Math.max(0, Math.min(MAX, Math.round(meters)));
            const pct = Math.round((1 - m / MAX) * 100);

            const tt = stopTypeOrDefault(target?.stop_type);
            const title = bannerTitleForType(tt);
            const icon = bannerIconForType(tt);

            return (
              <div
                style={{
                  pointerEvents: "none",
                  zIndex: 20010,
                  background: "#FBBF24",
                  color: "#111827",
                  border: "1px solid rgba(0,0,0,.12)",
                  borderRadius: 18,
                  padding: "12px 14px",
                  boxShadow: "0 14px 30px rgba(0,0,0,.22)",
                  display: "grid",
                  gap: 10,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 14,
                      background: "#111827",
                      color: "#FBBF24",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 20,
                      fontWeight: 900,
                    }}
                    aria-hidden
                  >
                    {icon}
                  </div>

                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 950, fontSize: 20 }}>
                      {title} {m} m
                    </div>
                    <div style={{ fontSize: 13, opacity: 0.9 }}>{stopBanner.label ?? "Zone d’embarquement / débarquement"}</div>
                  </div>
                </div>

                <div style={{ height: 12, borderRadius: 999, background: "rgba(0,0,0,.18)", overflow: "hidden" }}>
                  <div
                    style={{
                      height: "100%",
                      width: `${pct}%`,
                      background: "#111827",
                      borderRadius: 999,
                      transition: "width 140ms linear",
                    }}
                  />
                </div>
              </div>
            );
          })()}

        <div style={topButtonsRow}>
          <button
            style={dangerBtn}
            onPointerDown={tapHandler(stop)}
            onTouchStart={tapHandler(stop)}
            onClick={tapHandler(stop)}
            title="Terminer"
            aria-label="Terminer"
          >
            ✕
          </button>

          <div style={zoomCol}>
            <button
              style={overlayBtn}
              onPointerDown={tapHandler(zoomIn)}
              onTouchStart={tapHandler(zoomIn)}
              onClick={tapHandler(zoomIn)}
              aria-label="Zoom in"
              title="Zoom +"
            >
              +
            </button>
            <button
              style={overlayBtn}
              onPointerDown={tapHandler(zoomOut)}
              onTouchStart={tapHandler(zoomOut)}
              onClick={tapHandler(zoomOut)}
              aria-label="Zoom out"
              title="Zoom -"
            >
              −
            </button>
            <button
              style={{ ...overlayBtn, fontSize: 20 }}
              onPointerDown={tapHandler(recenter)}
              onTouchStart={tapHandler(recenter)}
              onClick={tapHandler(recenter)}
              aria-label="Recentrer"
              title="Recentrer"
            >
              🎯
            </button>

            <button
              style={{
                ...overlayBtn,
                fontSize: 18,
                background: audioOn ? "#16a34a" : "#ffffff",
                color: audioOn ? "#fff" : "#111827",
                border: audioOn ? "1px solid rgba(0,0,0,.08)" : "1px solid rgba(0,0,0,.12)",
                boxShadow: audioOn ? "0 16px 34px rgba(0,0,0,.22)" : (overlayBtn as any).boxShadow,
              }}
              onPointerDown={tapHandler(enableAudio)}
              onTouchStart={tapHandler(enableAudio)}
              onClick={tapHandler(enableAudio)}
              aria-label={audioOn ? "Audio activé" : "Activer l'audio"}
              title={audioOn ? "Audio activé" : "Activer l'audio"}
            >
              🔊
            </button>
          </div>
        </div>
      </div>

      {err ? (
        <div
          style={{
            position: "absolute",
            right: 12,
            bottom: "calc(env(safe-area-inset-bottom) + 12px)",
            zIndex: 25000,
            background: "rgba(255,255,255,.92)",
            border: "1px solid rgba(0,0,0,.12)",
            borderRadius: 14,
            padding: "10px 12px",
            boxShadow: "0 12px 26px rgba(0,0,0,.18)",
            maxWidth: "82vw",
            fontSize: 12,
            fontWeight: 900,
            color: "#b91c1c",
          }}
        >
          {err}
        </div>
      ) : null}
    </div>
  );
}
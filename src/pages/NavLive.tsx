// src/pages/NavLive.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import mapboxgl from "mapbox-gl";

import { callFn } from "@/lib/api";
import { haversineMeters } from "@/lib/geo";
import { useWakeLock } from "@/lib/useWakeLock";

/* =========================
   Types
========================= */

type PointsResp = {
  version_id: string;
  points: { idx: number; lat: number; lng: number; label?: string | null }[];
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

// Approx meters using equirectangular projection around current latitude
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

/** index de point de la polyline le plus proche (vertex) */
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

/** ✅ index le plus proche mais CONTRAINT (fenêtre) */
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

/** Arrondi “style GPS” */
function roundMetersForDisplay(m: number) {
  const mm = Math.max(0, Math.round(m));
  if (mm >= 1000) return mm;
  if (mm >= 200) return Math.round(mm / 50) * 50;
  if (mm >= 60) return Math.round(mm / 10) * 10;
  return Math.round(mm / 5) * 5;
}
function fmtDist(m: number) {
  const mm = Math.max(0, Math.round(m));
  if (mm >= 1000) {
    const km = mm / 1000;
    const v = Math.round(km * 10) / 10;
    return `${v} km`;
  }
  return `${roundMetersForDisplay(mm)} m`;
}

/* =========================
   Ding + voix (arrêts seulement)
========================= */

function useDing() {
  const ctxRef = useRef<AudioContext | null>(null);

  function ensureCtx() {
    const AC = (window.AudioContext || (window as any).webkitAudioContext) as any;
    if (!AC) return null;
    if (!ctxRef.current) ctxRef.current = new AC();
    return ctxRef.current;
  }

  async function unlock() {
    try {
      const ctx = ensureCtx();
      if (!ctx) return;
      if (ctx.state === "suspended") await ctx.resume();
    } catch {}
  }

  function play() {
    try {
      const ctx = ensureCtx();
      if (!ctx) return;
      try {
        if (ctx.state === "suspended") ctx.resume();
      } catch {}

      const o = ctx.createOscillator();
      const g = ctx.createGain();

      o.type = "sine";
      o.frequency.setValueAtTime(1046.5, ctx.currentTime);
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.45, ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);

      o.connect(g);
      g.connect(ctx.destination);

      o.start();
      o.stop(ctx.currentTime + 0.24);
    } catch {}
  }

  return { unlock, play };
}

function useSpeaker() {
  const lastSpeakAtRef = useRef(0);
  const lastTextRef = useRef<string>("");

  useEffect(() => {
    try {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
    } catch {}
  }, []);

  function speak(text: string, opts?: { cooldownMs?: number; interrupt?: boolean; dedupe?: boolean }) {
    try {
      const t = (text ?? "").trim();
      if (!t) return;

      const now = Date.now();
      const cooldownMs = opts?.cooldownMs ?? 900;

      if (opts?.dedupe !== false) {
        if (t === lastTextRef.current) return;
      }
      if (now - lastSpeakAtRef.current < cooldownMs) return;

      lastSpeakAtRef.current = now;
      lastTextRef.current = t;

      const interrupt = opts?.interrupt ?? true;
      if (interrupt) window.speechSynthesis.cancel();

      const u = new SpeechSynthesisUtterance(t);
      const voices = window.speechSynthesis.getVoices?.() ?? [];
      const pick =
        voices.find((v) => (v.lang || "").toLowerCase() === "fr-ca") ||
        voices.find((v) => (v.lang || "").toLowerCase().startsWith("fr")) ||
        voices[0];

      if (pick) u.voice = pick;
      u.lang = pick?.lang || "fr-CA";

      u.rate = 1.0;
      u.pitch = 1.0;
      u.volume = 1.0;

      window.speechSynthesis.speak(u);
    } catch {}
  }

  function stopAll() {
    try {
      window.speechSynthesis.cancel();
    } catch {}
  }

  return { speak, stopAll };
}

/* =========================
   Fullscreen helpers (best-effort web)
========================= */

async function tryEnterFullscreen() {
  try {
    const el = document.documentElement as any;
    if (document.fullscreenElement) return;
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

  // capture=true pour passer avant Mapbox
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

/** ✅ bearing à partir du mouvement (fallback quand heading GPS est null) */
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
  // évite les sauts 359 -> 0
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
  const { speak, stopAll } = useSpeaker();
  const ding = useDing();

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
  const targetPosRef = useRef<LatLng | null>(null); // dernière position GPS brute
  const animPosRef = useRef<LatLng | null>(null); // position animée (60fps)
  const accRef = useRef<number | null>(null);
  const speedRef = useRef<number | null>(null);
  const headingRef = useRef<number | null>(null);
  const lastBearingRef = useRef<number>(0);

  // Stops
  const [points, setPoints] = useState<{ lat: number; lng: number; label?: string | null }[]>([]);
  const [targetIdx, setTargetIdx] = useState(0);
  const target = points[targetIdx] ?? null;

  // Trace officielle (recorded)
  const [officialLine, setOfficialLine] = useState<[number, number][]>([]);
  const [hasOfficial, setHasOfficial] = useState(false);

  // Distance à la polyline (info)
  const [offRouteM, setOffRouteM] = useState<number | null>(null);

  // Wake lock
  const { supported: wlSupported, active: wlActive } = useWakeLock(running);

  // Bandeau stop + ding
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

  // Progression sur trace (idx)
  const traceIdxRef = useRef<number>(0);

  // 🔒 “join” logique : au début on reste sur idx=0, puis on “rejoint” la trace quand on est proche
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

  // dernière trace + stops
  const lineRef = useRef<[number, number][]>([]);
  const stopsRef = useRef<{ lat: number; lng: number; label?: string | null }[]>([]);

  // Full trace (discrète)
  const MAP_LINE_SRC = "line-src";
  const MAP_LINE_LAYER = "line-layer";
  const MAP_LINE_HALO = "line-halo";

  // Active trace (fenêtre + halo)
  const MAP_ACTIVE_SRC = "active-src";
  const MAP_ACTIVE_LAYER = "active-layer";
  const MAP_ACTIVE_HALO = "active-halo";

  // Stops
  const MAP_STOPS_SRC = "stops-src";
  const MAP_STOPS_LAYER = "stops-layer";
  const MAP_STOPS_NUM_LAYER = "stops-num-layer";

  // Fenêtre active (distance vers l’avant)
  const ACTIVE_AHEAD_METERS = 520;
  const ACTIVE_MAX_POINTS = 140;
  const ACTIVE_MIN_POINTS = 12;

  // Join / snapping (anti-croisements)
  const JOIN_DIST_M = 35; // quand on est à <= 35m, on “rejoint” la trace
  const SNAP_MAX_DIST_M = 55; // si on “snap” plus loin que ça, on refuse (évite les croisements)
  const SNAP_AHEAD_PTS = 240; // fenêtre de recherche vers l’avant (points)
  const SNAP_BACK_PTS = 12; // un petit retour autorisé

  // Manual zoom lock (pour que +/− ne “revienne” pas)
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

  // Fenêtre active seulement vers l’avant, basée sur meters
  function buildActiveForwardGeoJSON(line: [number, number][], idx: number) {
    if (!line || line.length < 2) return buildLineGeoJSON([]);

    const s = clamp(Math.floor(idx), 0, Math.max(0, line.length - 2));
    let coords: [number, number][] = [];

    let total = 0;
    let count = 0;

    const start = line[s];
    coords.push([start[0], start[1]]);
    count++;

    for (let i = s; i < line.length - 1; i++) {
      const a = { lat: line[i][0], lng: line[i][1] };
      const b = { lat: line[i + 1][0], lng: line[i + 1][1] };
      const seg = haversineMeters(a, b);

      total += seg;
      coords.push([line[i + 1][0], line[i + 1][1]]);
      count++;

      if (count >= ACTIVE_MAX_POINTS) break;
      if (total >= ACTIVE_AHEAD_METERS && count >= ACTIVE_MIN_POINTS) break;
    }

    if (coords.length < 2) {
      const tail = line.slice(Math.max(0, line.length - 2));
      return buildLineGeoJSON(tail);
    }
    return buildLineGeoJSON(coords);
  }

  function buildStopsGeoJSON(pts: { lat: number; lng: number; label?: string | null }[], activeIdx: number) {
    return {
      type: "FeatureCollection" as const,
      features: pts.map((p, i) => ({
        type: "Feature" as const,
        properties: {
          idx: i,
          num: String(i + 1),
          label: p.label ?? "",
          active: i === activeIdx ? 1 : 0,
        },
        geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] as [number, number] },
      })),
    };
  }

  // FULL = visible, mais moins “dominant” que l’active
  const FULL_LINE_WIDTH: any = ["interpolate", ["linear"], ["zoom"], 13, 3.8, 15, 5.0, 17, 6.3, 19, 7.4];
  const FULL_HALO_WIDTH: any = ["interpolate", ["linear"], ["zoom"], 13, 7.4, 15, 9.8, 17, 12.4, 19, 14.8];

  // ACTIVE = nettement plus large
  const ACTIVE_LINE_WIDTH: any = ["interpolate", ["linear"], ["zoom"], 13, 7.2, 15, 9.8, 17, 12.8, 19, 15.8];
  const ACTIVE_HALO_WIDTH: any = ["interpolate", ["linear"], ["zoom"], 13, 12.2, 15, 16.8, 17, 22.6, 19, 28.2];

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
          paint: {
            "line-color": "#FFFFFF",
            "line-width": FULL_HALO_WIDTH,
            "line-opacity": 0.55,
            "line-blur": 0.25,
          },
        });

        m.addLayer({
          id: MAP_LINE_LAYER,
          type: "line",
          source: MAP_LINE_SRC,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": "#2563eb",
            "line-width": FULL_LINE_WIDTH,
            "line-opacity": 0.58,
            "line-blur": 0.06,
          },
        });
      } catch (e) {
        console.error("Mapbox apply full line failed:", e);
      }
    }

    // TRACE ACTIVE
    if (fullLine && fullLine.length >= 2) {
      try {
        const activeGeo = buildActiveForwardGeoJSON(fullLine, traceIdxRef.current);
        m.addSource(MAP_ACTIVE_SRC, { type: "geojson", data: activeGeo as any });

        m.addLayer({
          id: MAP_ACTIVE_HALO,
          type: "line",
          source: MAP_ACTIVE_SRC,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": "#93c5fd",
            "line-width": ACTIVE_HALO_WIDTH,
            "line-opacity": 0.28,
            "line-blur": 1.15,
          },
        });

        m.addLayer({
          id: MAP_ACTIVE_LAYER,
          type: "line",
          source: MAP_ACTIVE_SRC,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": "#1d4ed8",
            "line-width": ACTIVE_LINE_WIDTH,
            "line-opacity": 1.0,
            "line-blur": 0.02,
          },
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
            "circle-color": "#ff0000",
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
          paint: {
            "text-color": "#ffffff",
            "text-halo-color": "rgba(0,0,0,0.55)",
            "text-halo-width": 1.6,
          },
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

  // throttle: update active seulement si idx change ou si >250ms
  const lastActiveUpdateRef = useRef<{ idx: number; t: number }>({ idx: -1, t: 0 });

  function upsertActiveLineOnMap() {
    const m = mapRef.current;
    if (!m || !m.isStyleLoaded()) return;

    try {
      const full = lineRef.current;
      if (!full || full.length < 2) return;

      const now = performance.now();
      const idx = traceIdxRef.current;

      const last = lastActiveUpdateRef.current;
      const idxChanged = idx !== last.idx;
      const timeOk = now - last.t >= 250;

      if (!idxChanged && !timeOk) return;

      lastActiveUpdateRef.current = { idx, t: now };

      const src = m.getSource(MAP_ACTIVE_SRC) as mapboxgl.GeoJSONSource | undefined;
      const data = buildActiveForwardGeoJSON(full, idx) as any;

      if (src) {
        src.setData(data);
        if (!m.getLayer(MAP_ACTIVE_LAYER) || !m.getLayer(MAP_ACTIVE_HALO)) applyOverlays();
      } else {
        applyOverlays();
      }
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

  // ✅ Recentrer = jump immédiat + reprise follow “instant”
  function recenter() {
    followRef.current = true;

    const m = mapRef.current;
    const p = animPosRef.current ?? me;
    if (!m || !p) return;

    try {
      m.stop();
    } catch {}

    // quand on recentre, on “redonne” la main à l’auto-zoom
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

  async function enableAudio() {
    try {
      await ding.unlock();
    } catch {}
    try {
      ding.play();
      speak("Audio activé.", { cooldownMs: 0, interrupt: true, dedupe: false });
      setAudioOn(true);
    } catch {
      setAudioOn(true);
    }
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
    traceIdxRef.current = 0;

    stopAll();
    nav("/");
  }

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

  // ✅ Fenêtre autorisée sur la trace active, basée sur l’ordre croissant des arrêts
  function getActiveBounds(lineLen: number) {
    const clampIdx = (x: number) => clamp(Math.floor(x), 0, Math.max(0, lineLen - 1));

    const curStop = stopIdxOnTrace[targetIdx] ?? 0;
    const prevStop = targetIdx > 0 ? stopIdxOnTrace[targetIdx - 1] ?? 0 : 0;
    const nextStop =
      targetIdx + 1 < stopIdxOnTrace.length ? stopIdxOnTrace[targetIdx + 1] ?? curStop : curStop + SNAP_AHEAD_PTS;

    const minIdx = clampIdx(Math.min(prevStop, curStop));
    const maxIdx = clampIdx(Math.max(curStop, nextStop) + 80); // petit buffer après le prochain arrêt

    return { minIdx, maxIdx };
  }

  /* =========================
     Load circuit
  ========================= */

  async function loadCircuit() {
    if (!circuitId) throw new Error("Circuit manquant.");

    const r = await callFn<PointsResp>("circuits-api", { action: "get_active_points", circuit_id: circuitId });
    const pts = r.points.map((p) => ({ lat: p.lat, lng: p.lng, label: p.label ?? null }));
    if (pts.length === 0) throw new Error("Ce circuit n’a aucun arrêt enregistré.");

    const tr = await callFn<TraceResp>("circuits-api", { action: "get_latest_trace", circuit_id: circuitId });
    const line: [number, number][] = (tr.trail ?? []).map((p) => [p.lat, p.lng]);
    if (line.length < 2) throw new Error("Trace officielle introuvable (aucun trail).");

    setPoints(pts);
    setTargetIdx(0);

    setOfficialLine(line);
    setHasOfficial(true);

    setFinished(false);

    // ✅ IMPORTANT: au chargement, on démarre TOUJOURS au début de la trace
    traceIdxRef.current = 0;
    joinedTraceRef.current = false;
    lastActiveUpdateRef.current = { idx: -1, t: 0 };

    stopWarnRef.current = null;
    stopWarnMaxRef.current = null;
    stopDingRef.current = null;
    stopBannerLastMRef.current = null;
    setStopBanner({ show: false, meters: 0, label: null, max: 150 });

    stopTouchedRef.current = false;
    stopMinDistRef.current = Infinity;

    travelSinceTargetSetRef.current = 0;
    initialDistToTargetRef.current = null;

    lineRef.current = line;
    stopsRef.current = pts;

    const m = ensureMap();
    if (m) {
      applyOverlays();
      ensureMeMarker();
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

    // ✅ tente fullscreen tout de suite + fallback au 1er tap
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

    // ✅ jump instant au démarrage (pas de easing long)
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
        const movingEnough = sp == null ? true : sp >= 0.6; // m/s
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

          // ✅ Trace idx = commence au début (sans exception), puis rejoint et suit ta position courante,
          //    MAIS dans une fenêtre autorisée par l'ordre croissant des arrêts (anti-croisements).
          if (hasOfficial && lineRef.current.length >= 2) {
            const line = lineRef.current;
            const { minIdx, maxIdx } = getActiveBounds(line.length);

            if (!joinedTraceRef.current) {
              // ✅ sans exception: fenêtre active au début de la trace
              traceIdxRef.current = 0;

              const d = minDistanceToPolylineMeters(next, line);
              if (d != null && d <= JOIN_DIST_M) {
                joinedTraceRef.current = true;

                // ✅ au join: snap sur ta position courante, mais uniquement dans les bornes des arrêts
                const pick =
                  nearestLineIndexWindow(next, line, minIdx, maxIdx) ??
                  nearestLineIndexWindow(next, line, 0, Math.min(line.length - 1, SNAP_AHEAD_PTS)) ??
                  nearestLineIndex(next, line);

                if (pick && pick.dist <= SNAP_MAX_DIST_M) {
                  const floorIdx = Math.max(minIdx, traceIdxRef.current);
                  traceIdxRef.current = clamp(pick.idx, floorIdx, maxIdx);
                } else {
                  traceIdxRef.current = 0;
                }
              }
            } else {
              // ✅ déjà rejoint: on suit ta position courante, monotone forward, borné par les arrêts
              const floorIdx = Math.max(minIdx, traceIdxRef.current);
              const ceilIdx = Math.max(floorIdx, maxIdx);

              const pick =
                nearestLineIndexWindow(next, line, floorIdx, ceilIdx) ??
                nearestLineIndexWindow(next, line, floorIdx, Math.min(line.length - 1, floorIdx + SNAP_AHEAD_PTS));

              if (pick && pick.dist <= SNAP_MAX_DIST_M) {
                traceIdxRef.current = clamp(pick.idx, floorIdx, ceilIdx);
              } else {
                // trop loin -> on garde l'idx courant
              }
            }

            upsertActiveLineOnMap();
          }

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

            // ✅ stop l’animation en cours pour éviter la “reprise lente”
            try {
              m.stop();
            } catch {}

            // follow fluide mais rapide
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
  }, [running, hasOfficial, stopIdxOnTrace, targetIdx]);

  /* =========================
     Quand le targetIdx change: maj visuelle stops
  ========================= */
  useEffect(() => {
    if (!running) return;
    upsertStopsOnMap();
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

    const dLine = minDistanceToPolylineMeters(p, officialLine);
    setOffRouteM(dLine);
  }, [running, me, hasOfficial, officialLine]);

  /* =========================
     Stops + bandeau + ding + skip
  ========================= */

  useEffect(() => {
    if (!running) return;
    const p = animPosRef.current ?? me;
    if (!p || !target) return;
    if (finished) return;

    if (lastMeRef.current) travelSinceTargetSetRef.current += haversineMeters(lastMeRef.current, p);
    lastMeRef.current = p;

    if (initialDistToTargetRef.current == null && target) {
      initialDistToTargetRef.current = haversineMeters(p, target);
    }

    const dStop = haversineMeters(p, target);
    const rawStopM = Math.round(dStop);

    const dynamicMax = warnStopMeters();
    if (stopWarnMaxRef.current == null) stopWarnMaxRef.current = dynamicMax;
    const WARN_STOP_M = stopWarnMaxRef.current ?? dynamicMax;

    if (hasOfficial && officialLine.length >= 2) {
      const speedNow = speedRef.current ?? null;

      if (rawStopM < stopMinDistRef.current) stopMinDistRef.current = rawStopM;
      if (stopMinDistRef.current <= STOP_TOUCH_M) stopTouchedRef.current = true;

      const stopTraceIdx = stopIdxOnTrace[targetIdx] ?? 0;

      const movingOk = speedNow == null ? true : speedNow >= STOP_SKIP_MIN_SPEED;
      const clearlyPastStopOnTrace = traceIdxRef.current >= stopTraceIdx + STOP_SKIP_TRACE_AHEAD_PTS;
      const clearlyMovingAway = stopTouchedRef.current && rawStopM >= STOP_SKIP_CONFIRM_M;

      if (movingOk && clearlyMovingAway && clearlyPastStopOnTrace) {
        const nextIdx = targetIdx + 1;
        if (nextIdx < points.length) {
          if (audioOn) speak("Arrêt manqué. Prochain arrêt.", { cooldownMs: 1200, interrupt: true });
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
          return;
        }
      }
    }

    if (rawStopM > WARN_STOP_M) {
      if (stopBanner.show) setStopBanner({ show: false, meters: 0, label: null, max: WARN_STOP_M });
      stopBannerLastMRef.current = null;
    }

    if (rawStopM <= WARN_STOP_M && rawStopM > ARRIVE_STOP_M) {
      const prevShown = stopBannerLastMRef.current;
      let shown = prevShown == null ? rawStopM : Math.min(prevShown, rawStopM);
      shown = Math.round(shown / 5) * 5;
      stopBannerLastMRef.current = shown;

      setStopBanner({ show: true, meters: shown, label: target.label ?? null, max: WARN_STOP_M });

      if (audioOn && stopWarnRef.current !== targetIdx) {
        stopWarnRef.current = targetIdx;
        speak(`Arrêt scolaire dans ${WARN_STOP_M} mètres.`, { cooldownMs: 1400, interrupt: true });
      }
    }

    if (audioOn && rawStopM <= DING_AT_M && rawStopM > 1) {
      if (stopDingRef.current !== targetIdx) {
        stopDingRef.current = targetIdx;
        ding.play();
      }
    }

    const initD = initialDistToTargetRef.current;
    const allowArrive =
      initD == null || initD > ARRIVE_STOP_M + ARRIVE_EPS_M || travelSinceTargetSetRef.current >= MIN_TRAVEL_AFTER_TARGET_SET_M;

    if (dStop <= ARRIVE_STOP_M && allowArrive) {
      setStopBanner({ show: false, meters: 0, label: null, max: WARN_STOP_M });

      const nextIdx = targetIdx + 1;
      if (nextIdx < points.length) {
        const nextTarget = points[nextIdx] ?? null;
        const distNext = nextTarget ? Math.round(haversineMeters(p, nextTarget)) : 0;

        travelSinceTargetSetRef.current = 0;
        initialDistToTargetRef.current = nextTarget ? haversineMeters(p, nextTarget) : null;

        if (audioOn) speak(`Arrêt atteint. Prochain embarquement dans ${fmtDist(distNext)}.`, { cooldownMs: 1400, interrupt: true });
        setTargetIdx(nextIdx);

        stopWarnRef.current = null;
        stopWarnMaxRef.current = null;
        stopDingRef.current = null;
        stopBannerLastMRef.current = null;

        stopTouchedRef.current = false;
        stopMinDistRef.current = Infinity;
      } else {
        travelSinceTargetSetRef.current = 0;
        initialDistToTargetRef.current = null;

        if (audioOn) speak("Circuit terminé.", { cooldownMs: 1200, interrupt: true });
        setFinished(true);

        stopWarnRef.current = null;
        stopWarnMaxRef.current = null;
        stopDingRef.current = null;
        stopBannerLastMRef.current = null;

        stopTouchedRef.current = false;
        stopMinDistRef.current = Infinity;
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
    speak,
    ding,
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

    // ✅ iOS: empêcher Safari de “voler” le tap / double-tap zoom
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

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative", overflow: "hidden", background: "#0b1220" }}>
      <div ref={mapElRef} style={{ width: "100%", height: "100%" }} />

      <div style={topStack}>
        {stopBanner.show &&
          (() => {
            const MAX = Number.isFinite(stopBanner.max) ? stopBanner.max : 150;
            const meters = Number.isFinite(stopBanner.meters) ? stopBanner.meters : 0;
            const m = Math.max(0, Math.min(MAX, Math.round(meters)));
            const pct = Math.round((1 - m / MAX) * 100);

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
                    🧒
                  </div>

                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 950, fontSize: 20 }}>Arrêt scolaire dans {m} m</div>
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
              onPointerDown={tapHandler(() => {
                enableAudio();
              })}
              onTouchStart={tapHandler(() => {
                enableAudio();
              })}
              onClick={tapHandler(() => {
                enableAudio();
              })}
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
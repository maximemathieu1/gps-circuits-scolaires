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

/** ✅ index le plus proche mais CONTRAINT (pour éviter de "snapper" sur un autre croisement après stop 2, 3...) */
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

  // Trace officielle
  const [officialLine, setOfficialLine] = useState<[number, number][]>([]);
  const [hasOfficial, setHasOfficial] = useState(false);

  // Distance à la polyline (info)
  const [offRouteM, setOffRouteM] = useState<number | null>(null);

  const { supported: wlSupported, active: wlActive } = useWakeLock(running);

  // Bandeau stop + ding
  const stopWarnRef = useRef<number | null>(null);
  const stopWarnMaxRef = useRef<number | null>(null);
  const stopDingRef = useRef<number | null>(null);

  const [stopBanner, setStopBanner] = useState<{ show: boolean; meters: number; label?: string | null; max: number }>({
    show: false,
    meters: 0,
    label: null,
    max: 150,
  });
  const stopBannerLastMRef = useRef<number | null>(null);

  // Mode intelligent (skip arrêt manqué)
  const stopTouchedRef = useRef(false);
  const stopMinDistRef = useRef<number>(Infinity);

  // Progression sur trace (bleu)
  const traceIdxRef = useRef<number>(0);

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

  // on conserve toujours la dernière trace + stops
  const lineRef = useRef<[number, number][]>([]);
  const stopsRef = useRef<{ lat: number; lng: number; label?: string | null }[]>([]);
  const activeLineRef = useRef<[number, number][]>([]);

  const MAP_REMAIN_SRC = "remain-src";
  const MAP_REMAIN_LAYER = "remain-layer";
  const MAP_REMAIN_HALO = "remain-halo";

  const MAP_ACTIVE_SRC = "active-trace-src";
  const MAP_ACTIVE_LAYER = "active-trace-layer";
  const MAP_ACTIVE_HALO = "active-trace-halo";

  const MAP_STOPS_SRC = "stops-src";
  const MAP_STOPS_LAYER = "stops-layer";

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

  function buildStopsGeoJSON(pts: { lat: number; lng: number; label?: string | null }[]) {
    return {
      type: "FeatureCollection" as const,
      features: pts.map((p, i) => ({
        type: "Feature" as const,
        properties: { idx: i, label: p.label ?? "" },
        geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] as [number, number] },
      })),
    };
  }

  function applyOverlays() {
    const m = mapRef.current;
    if (!m || !m.isStyleLoaded()) return;

    const fullLine = lineRef.current;
    const pts = stopsRef.current;
    const active = activeLineRef.current;

    safeRemoveLayer(m, MAP_REMAIN_LAYER);
    safeRemoveLayer(m, MAP_REMAIN_HALO);
    safeRemoveSource(m, MAP_REMAIN_SRC);

    safeRemoveLayer(m, MAP_ACTIVE_LAYER);
    safeRemoveLayer(m, MAP_ACTIVE_HALO);
    safeRemoveSource(m, MAP_ACTIVE_SRC);

    safeRemoveLayer(m, MAP_STOPS_LAYER);
    safeRemoveSource(m, MAP_STOPS_SRC);

    // TRACE BLEUE (FIXE — ne s'efface plus)
    if (fullLine && fullLine.length >= 2) {
      const remain = fullLine;

      if (remain.length >= 2) {
        const geojson = buildLineGeoJSON(remain);
        try {
          m.addSource(MAP_REMAIN_SRC, { type: "geojson", data: geojson as any });

          m.addLayer({
            id: MAP_REMAIN_HALO,
            type: "line",
            source: MAP_REMAIN_SRC,
            layout: { "line-join": "round", "line-cap": "round" },
            paint: { "line-color": "#93c5fd", "line-width": 12, "line-opacity": 0.22 },
          });

          m.addLayer({
            id: MAP_REMAIN_LAYER,
            type: "line",
            source: MAP_REMAIN_SRC,
            layout: { "line-join": "round", "line-cap": "round" },
            paint: { "line-color": "#2563eb", "line-width": 7, "line-opacity": 0.95 },
          });
        } catch (e) {
          console.error("Mapbox apply remain failed:", e);
        }
      }
    }

    // ACTIVE SEGMENT (rose)
    if (active && active.length >= 2) {
      const geojsonA = buildLineGeoJSON(active);
      try {
        m.addSource(MAP_ACTIVE_SRC, { type: "geojson", data: geojsonA as any });

        m.addLayer({
          id: MAP_ACTIVE_HALO,
          type: "line",
          source: MAP_ACTIVE_SRC,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": "#fbcfe8", "line-width": 16, "line-opacity": 0.35 },
        });

        m.addLayer({
          id: MAP_ACTIVE_LAYER,
          type: "line",
          source: MAP_ACTIVE_SRC,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": "#ec4899", "line-width": 9, "line-opacity": 1.0 },
        });
      } catch (e) {
        console.error("Mapbox apply active segment failed:", e);
      }
    }

    // STOPS
    if (pts && pts.length > 0) {
      const fc = buildStopsGeoJSON(pts);
      try {
        m.addSource(MAP_STOPS_SRC, { type: "geojson", data: fc as any });
        m.addLayer({
          id: MAP_STOPS_LAYER,
          type: "circle",
          source: MAP_STOPS_SRC,
          paint: {
            "circle-radius": 6,
            "circle-color": "#111827",
            "circle-stroke-width": 3,
            "circle-stroke-color": "#FBBF24",
          },
        });
      } catch (e) {
        console.error("Mapbox apply stops failed:", e);
      }
    }
  }

  function upsertActiveSegmentOnMap(line: [number, number][]) {
    activeLineRef.current = Array.isArray(line) ? line : [];

    const m = mapRef.current;
    if (!m || !m.isStyleLoaded()) return;

    try {
      const src = m.getSource(MAP_ACTIVE_SRC) as mapboxgl.GeoJSONSource | undefined;
      const data = buildLineGeoJSON(activeLineRef.current) as any;

      if (src) {
        src.setData(data);
        if (!m.getLayer(MAP_ACTIVE_LAYER) || !m.getLayer(MAP_ACTIVE_HALO)) applyOverlays();
      } else {
        applyOverlays();
      }
    } catch (e) {
      console.error("upsertActiveSegmentOnMap failed:", e);
      applyOverlays();
    }
  }

  // ✅ NOUVEAU: force la mise à jour du segment rose immédiatement (sans attendre setTargetIdx/useEffect)
  function forcePinkForTarget(nextTargetIdx: number) {
    if (!hasOfficial || officialLine.length < 2) return;
    if (!points.length) return;

    // si on est au dernier arrêt, plus de segment
    if (nextTargetIdx >= points.length - 1) {
      upsertActiveSegmentOnMap([]);
      return;
    }

    const aIdx = stopIdxOnTrace[nextTargetIdx] ?? null;
    const bIdx = stopIdxOnTrace[nextTargetIdx + 1] ?? null;
    if (aIdx == null || bIdx == null) return;

    const from = clamp(Math.min(aIdx, bIdx), 0, officialLine.length - 1);
    const to = clamp(Math.max(aIdx, bIdx), 0, officialLine.length - 1);

    let seg = officialLine.slice(from, to + 1);
    // si jamais indices inversés, on garde le sens "vers l'avant"
    if (aIdx > bIdx) seg = seg.slice().reverse();

    if (seg.length >= 2) upsertActiveSegmentOnMap(seg);
    else upsertActiveSegmentOnMap([]);
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
      style: "mapbox://styles/mapbox/navigation-day-v1",
      center: [-73.0, 46.8],
      zoom: 16.0,
      pitch: 55,
      bearing: 0,
      attributionControl: false,
    });

    mapRef.current = m;

    // follow OFF uniquement sur geste utilisateur
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
    try {
      mapRef.current?.zoomIn({ duration: 200 });
    } catch {}
  }
  function zoomOut() {
    try {
      mapRef.current?.zoomOut({ duration: 200 });
    } catch {}
  }

  function computeFollowOffsetPx(m: mapboxgl.Map) {
    const h = m.getCanvas().clientHeight || window.innerHeight;
    const usable = Math.max(280, h - 170);

    const v = speedRef.current ?? null;
    const kmh = v != null ? v * 3.6 : 0;

    const base = Math.round(usable * 0.22);
    const extra = Math.round(clamp(kmh * 0.6, 0, 35));
    const yOff = clamp(base + extra, 30, 120);

    return yOff;
  }

  function recenter() {
    followRef.current = true;
    tryEnterFullscreen();

    const m = mapRef.current;
    const p = animPosRef.current ?? me;
    if (!m || !p) return;

    const v = speedRef.current ?? null;
    const kmh = v != null ? v * 3.6 : 0;
    const targetZoom = kmh >= 60 ? 17.2 : kmh >= 25 ? 16.6 : 16.1;

    const yOff = computeFollowOffsetPx(m);

    const b = wrap360((headingRef.current ?? lastBearingRef.current) || 0);

    m.easeTo({
      center: [p.lng, p.lat],
      zoom: targetZoom,
      pitch: 55,
      bearing: b,
      offset: [0, yOff],
      duration: 450,
      easing: (t: number) => t,
      essential: true,
    });
  }

  /* =========================
     ✅ Stop index sur trace (FIX: monotone forward)
  ========================= */

  const stopIdxOnTrace = useMemo(() => {
    if (!hasOfficial || officialLine.length < 2) return [];
    if (!points.length) return [];

    const line = officialLine;
    const out: number[] = [];

    const AHEAD_WINDOW = Math.min(2500, Math.max(400, Math.floor(line.length * 0.25)));

    // stop 0: nearest global
    const first = nearestLineIndex({ lat: points[0].lat, lng: points[0].lng }, line);
    let prevIdx = clamp(first?.idx ?? 0, 0, line.length - 1);
    out.push(prevIdx);

    for (let i = 1; i < points.length; i++) {
      const p = points[i];

      // recherche seulement vers l'avant
      const near = nearestLineIndexWindow(
        { lat: p.lat, lng: p.lng },
        line,
        prevIdx,
        Math.min(line.length - 1, prevIdx + AHEAD_WINDOW)
      );

      const pick = near ?? nearestLineIndex({ lat: p.lat, lng: p.lng }, line);
      let idx = clamp(pick?.idx ?? prevIdx, 0, line.length - 1);

      // forcer strictement croissant
      if (idx <= prevIdx) idx = Math.min(prevIdx + 1, line.length - 1);

      out.push(idx);
      prevIdx = idx;
    }

    return out;
  }, [hasOfficial, officialLine, points]);

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
    traceIdxRef.current = 0;

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
    activeLineRef.current = [];

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

    try {
      await ding.unlock();
    } catch {}

    setRunning(true);

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

    // init animation refs
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
        m.jumpTo({ center: [initial.lng, initial.lat], zoom: 16.1, bearing: 0, pitch: 55 });
      }
    } catch {}
  }

  function stop() {
    setRunning(false);
    setFinished(false);

    stopTouchedRef.current = false;
    stopMinDistRef.current = Infinity;

    lastMeRef.current = null;
    travelSinceTargetSetRef.current = 0;
    initialDistToTargetRef.current = null;

    stopAll();
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
     GPS tracking (on met à jour targetPosRef)
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
     Animation loop (fluide) + follow + rotation
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

        // interpolation stable
        const k = 1 - Math.pow(0.001, dt);
        const next = {
          lat: cur.lat + (targetP.lat - cur.lat) * clamp(k * 6.0, 0.05, 0.9),
          lng: cur.lng + (targetP.lng - cur.lng) * clamp(k * 6.0, 0.05, 0.9),
        };

        // rotation fallback
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

          // progress trace idx (on le garde, mais la bleue reste fixe)
          if (hasOfficial && lineRef.current.length >= 2) {
            const near = nearestLineIndex(next, lineRef.current);
            if (near) traceIdxRef.current = near.idx;

            // refresh remain (bleu) — FIXE
            try {
              const src = m.getSource(MAP_REMAIN_SRC) as mapboxgl.GeoJSONSource | undefined;
              const data = buildLineGeoJSON(lineRef.current) as any;
              if (src) src.setData(data);
            } catch {}
          }

          if (m.isStyleLoaded()) {
            if (!m.getLayer(MAP_REMAIN_LAYER) && lineRef.current.length >= 2) applyOverlays();
            if (!m.getLayer(MAP_ACTIVE_LAYER) && activeLineRef.current.length >= 2) applyOverlays();
          }

          // follow "au volant"
          if (followRef.current) {
            const v = speedRef.current ?? null;
            const kmh = v != null ? v * 3.6 : 0;
            const targetZoom = kmh >= 60 ? 17.2 : kmh >= 25 ? 16.6 : 16.1;

            const yOff = computeFollowOffsetPx(m);
            const b = wrap360(lastBearingRef.current || 0);

            m.easeTo({
              center: [next.lng, next.lat],
              zoom: targetZoom,
              pitch: 55,
              bearing: b,
              offset: [0, yOff],
              duration: 260,
              easing: (x: number) => x,
              essential: true,
            });
          }
        }
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, hasOfficial]);

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
     Active segment (ROSE) = arrêt courant -> prochain
     (useEffect = filet de sécurité; le "switch instantané" se fait via forcePinkForTarget())
  ========================= */

  useEffect(() => {
    if (!running) return;
    if (!hasOfficial || officialLine.length < 2) return;
    if (!points.length) return;

    if (targetIdx >= points.length - 1) {
      upsertActiveSegmentOnMap([]);
      return;
    }

    const aIdx = stopIdxOnTrace[targetIdx] ?? null;
    const bIdx = stopIdxOnTrace[targetIdx + 1] ?? null;
    if (aIdx == null || bIdx == null) {
      upsertActiveSegmentOnMap([]);
      return;
    }

    const from = clamp(Math.min(aIdx, bIdx), 0, officialLine.length - 1);
    const to = clamp(Math.max(aIdx, bIdx), 0, officialLine.length - 1);

    let seg = officialLine.slice(from, to + 1);
    if (aIdx > bIdx) seg = seg.slice().reverse();

    if (seg.length >= 2) upsertActiveSegmentOnMap(seg);
    else upsertActiveSegmentOnMap([]);

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, hasOfficial, officialLine, targetIdx, points.length, stopIdxOnTrace]);

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
        const next = targetIdx + 1;
        if (next < points.length) {
          speak("Arrêt manqué. Prochain arrêt.", { cooldownMs: 1200, interrupt: true });

          // ✅ Switch visuel immédiat du segment rose (next -> next+1)
          forcePinkForTarget(next);

          setTargetIdx(next);

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

      if (stopWarnRef.current !== targetIdx) {
        stopWarnRef.current = targetIdx;
        speak(`Arrêt scolaire dans ${WARN_STOP_M} mètres.`, { cooldownMs: 1400, interrupt: true });
      }
    }

    if (rawStopM <= DING_AT_M && rawStopM > 1) {
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

      const next = targetIdx + 1;
      if (next < points.length) {
        const nextTarget = points[next] ?? null;
        const distNext = nextTarget ? Math.round(haversineMeters(p, nextTarget)) : 0;

        travelSinceTargetSetRef.current = 0;
        initialDistToTargetRef.current = nextTarget ? haversineMeters(p, nextTarget) : null;

        speak(`Arrêt atteint. Prochain embarquement dans ${fmtDist(distNext)}.`, { cooldownMs: 1400, interrupt: true });

        // ✅ IMPORTANT: Switch visuel immédiat du segment rose (next -> next+1)
        forcePinkForTarget(next);

        setTargetIdx(next);

        stopWarnRef.current = null;
        stopWarnMaxRef.current = null;
        stopDingRef.current = null;
        stopBannerLastMRef.current = null;

        stopTouchedRef.current = false;
        stopMinDistRef.current = Infinity;
      } else {
        travelSinceTargetSetRef.current = 0;
        initialDistToTargetRef.current = null;

        speak("Circuit terminé.", { cooldownMs: 1200, interrupt: true });
        setFinished(true);

        // fin => plus de segment rose
        upsertActiveSegmentOnMap([]);

        stopWarnRef.current = null;
        stopWarnMaxRef.current = null;
        stopDingRef.current = null;
        stopBannerLastMRef.current = null;

        stopTouchedRef.current = false;
        stopMinDistRef.current = Infinity;
      }
    }
  }, [running, me, target, targetIdx, points, finished, stopBanner.show, hasOfficial, officialLine, stopIdxOnTrace]);

  /* =========================
     UI
  ========================= */

  const overlayBtn: React.CSSProperties = {
    width: 46,
    height: 46,
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
  };

  const topBar: React.CSSProperties = {
    position: "absolute",
    top: 12,
    left: 12,
    right: 12,
    zIndex: 9000,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
    pointerEvents: "none",
  };

  const backWrap: React.CSSProperties = { pointerEvents: "auto" };

  const zoomCol: React.CSSProperties = {
    position: "absolute",
    right: 12,
    top: 74,
    zIndex: 9000,
    display: "grid",
    gap: 10,
    pointerEvents: "auto",
  };

  const bottomPanel: React.CSSProperties = {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 12,
    zIndex: 9000,
    background: "rgba(255,255,255,.92)",
    border: "1px solid rgba(0,0,0,.10)",
    borderRadius: 18,
    boxShadow: "0 12px 28px rgba(0,0,0,.18)",
    padding: "12px 14px",
    display: "grid",
    gap: 6,
    pointerEvents: "none",
  };

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative", overflow: "hidden", background: "#0b1220" }}>
      {/* MAP FULLSCREEN */}
      <div ref={mapElRef} style={{ width: "100%", height: "100%" }} />

      {/* TOP BAR */}
      <div style={topBar}>
        <div style={backWrap}>
          <button style={{ ...overlayBtn, width: 56, justifyContent: "center", gap: 8 }} onClick={() => nav("/")} title="Retour">
            ←
          </button>
        </div>

        <div
          style={{
            pointerEvents: "none",
            background: "rgba(17,24,39,.78)",
            color: "white",
            border: "1px solid rgba(255,255,255,.10)",
            borderRadius: 14,
            padding: "10px 12px",
            fontWeight: 900,
            fontSize: 14,
          }}
        >
          {finished ? "✅ Terminé" : "Suivi (trace + arrêts)"} {wlSupported ? (wlActive ? "• Écran: ON" : "• Écran: OFF") : ""}{" "}
          {heading != null ? "• cap GPS" : "• cap calculé"}
        </div>
      </div>

      {/* ZOOM + / - + RECENTER */}
      <div style={zoomCol}>
        <button style={overlayBtn} onClick={zoomIn} aria-label="Zoom in" title="Zoom +">
          +
        </button>
        <button style={overlayBtn} onClick={zoomOut} aria-label="Zoom out" title="Zoom -">
          −
        </button>
        <button style={{ ...overlayBtn, fontSize: 18 }} onClick={recenter} aria-label="Recentrer" title="Recentrer">
          ⤾
        </button>
      </div>

      {/* BANDEAU STOP (jaune) */}
      {stopBanner.show &&
        (() => {
          const MAX = Number.isFinite(stopBanner.max) ? stopBanner.max : 150;
          const meters = Number.isFinite(stopBanner.meters) ? stopBanner.meters : 0;
          const m = Math.max(0, Math.min(MAX, Math.round(meters)));
          const pct = Math.round((1 - m / MAX) * 100);

          return (
            <div
              style={{
                position: "absolute",
                top: 12,
                left: 76,
                right: 76,
                zIndex: 9999,
                background: "#FBBF24",
                color: "#111827",
                border: "1px solid rgba(0,0,0,.12)",
                borderRadius: 18,
                padding: "12px 14px",
                boxShadow: "0 10px 26px rgba(0,0,0,.18)",
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

      {/* BOTTOM PANEL */}
      <div style={bottomPanel}>
        <div style={{ fontWeight: 950, fontSize: 16, color: "#111827" }}>
          Prochain arrêt : {Math.min(targetIdx + 1, points.length)} / {points.length}
        </div>
        <div style={{ fontSize: 14, color: "rgba(17,24,39,.82)", fontWeight: 700 }}>{target?.label ? target.label : "—"}</div>
        {acc != null && (
          <div style={{ fontSize: 12, color: "rgba(17,24,39,.72)" }}>
            GPS ~{Math.round(acc)} m • Vitesse ~{Math.round((speed ?? 0) * 3.6)} km/h
          </div>
        )}
        {offRouteM != null && (
          <div style={{ fontSize: 12, color: "rgba(17,24,39,.72)" }}>Écart trace: {Math.round(offRouteM)} m</div>
        )}
        {err && <div style={{ fontSize: 12, color: "#b91c1c", fontWeight: 900 }}>{err}</div>}
      </div>

      {/* STOP BTN */}
      <div style={{ position: "absolute", left: 12, bottom: 92, zIndex: 9000, pointerEvents: "auto" }}>
        <button
          style={{
            ...overlayBtn,
            width: 120,
            height: 44,
            borderRadius: 16,
            fontSize: 14,
            fontWeight: 950,
          }}
          onClick={stop}
          title="Terminer"
        >
          Terminer
        </button>
      </div>
    </div>
  );
}
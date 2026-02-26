// src/pages/NavLive.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import mapboxgl from "mapbox-gl";

import { callFn } from "@/lib/api";
import { haversineMeters } from "@/lib/geo";
import { useWakeLock } from "@/lib/useWakeLock";
import { page, container, card, h1, muted, row, btn, bigBtn } from "@/ui";

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

type LockedTurn = {
  id: string;
  text: string;
  arrow: string;
  turnIdx: number;
  turnPoint: LatLng;
};

/* =========================
   GeoJSON minimal (évite "Cannot find namespace GeoJSON")
========================= */

type GPoint = { type: "Point"; coordinates: [number, number] };
type GLineString = { type: "LineString"; coordinates: [number, number][] };

type GFeature<G> = {
  type: "Feature";
  properties: Record<string, any>;
  geometry: G;
};

type GFeatureCollection<G> = {
  type: "FeatureCollection";
  features: Array<GFeature<G>>;
};

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
    { enableHighAccuracy: true, maximumAge: 800, timeout: 15000 }
  );
}

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

function smoothPos(prev: LatLng | null, next: LatLng, alpha: number) {
  if (!prev) return next;
  return {
    lat: prev.lat + (next.lat - prev.lat) * alpha,
    lng: prev.lng + (next.lng - prev.lng) * alpha,
  };
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

/** index de point de la polyline le plus proche */
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

function linePoint(line: [number, number][], idx: number): LatLng {
  const i = clamp(idx, 0, Math.max(0, line.length - 1));
  return { lat: line[i][0], lng: line[i][1] };
}

function walkForward(line: [number, number][], fromIdx: number, metersAhead: number) {
  let i = clamp(fromIdx, 0, Math.max(0, line.length - 2));
  let left = metersAhead;

  while (i < line.length - 1 && left > 0) {
    const a = linePoint(line, i);
    const b = linePoint(line, i + 1);
    const d = haversineMeters(a, b);
    if (d <= 0.01) {
      i++;
      continue;
    }
    if (d >= left) return { idx: i + 1, at: b };
    left -= d;
    i++;
  }
  return { idx: line.length - 1, at: linePoint(line, line.length - 1) };
}

function angleDeg(a: LatLng, b: LatLng, c: LatLng) {
  const ax = a.lng - b.lng;
  const ay = a.lat - b.lat;
  const cx = c.lng - b.lng;
  const cy = c.lat - b.lat;

  const dot = ax * cx + ay * cy;
  const det = ax * cy - ay * cx;
  const ang = Math.atan2(det, dot) * (180 / Math.PI);
  return ang; // signed
}

function turnTextFromAngle(signedAngle: number) {
  const a = Math.abs(signedAngle);
  if (a < 25) return null;

  if (a >= 25 && a < 55) return signedAngle > 0 ? "Prenez la bretelle à gauche" : "Prenez la bretelle à droite";
  if (a >= 55 && a < 140) return signedAngle > 0 ? "Tournez à gauche" : "Tournez à droite";
  return signedAngle > 0 ? "Faites demi-tour à gauche" : "Faites demi-tour à droite";
}

function arrowFromText(txt: string) {
  if (txt.includes("droite")) return "➡️";
  if (txt.includes("gauche")) return "⬅️";
  return "⬆️";
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
   Voix + Ding
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
   Fullscreen helpers
========================= */

async function tryEnterFullscreen() {
  try {
    const el = document.documentElement as any;
    if (document.fullscreenElement) return;
    if (el.requestFullscreen) await el.requestFullscreen();
    else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
  } catch {}
}

async function tryExitFullscreen() {
  try {
    const d: any = document;
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (d.webkitFullscreenElement) await d.webkitExitFullscreen();
  } catch {}
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

  // GPS
  const [me, setMe] = useState<LatLng | null>(null);
  const meSmoothRef = useRef<LatLng | null>(null);

  const [acc, setAcc] = useState<number | null>(null);
  const accRef = useRef<number | null>(null);

  const [speed, setSpeed] = useState<number | null>(null);
  const speedRef = useRef<number | null>(null);

  const [heading, setHeading] = useState<number | null>(null);
  const headingRef = useRef<number | null>(null);
  const lastBearingRef = useRef<number>(0);

  const [err, setErr] = useState<string | null>(null);

  // Stops
  const [points, setPoints] = useState<{ lat: number; lng: number; label?: string | null }[]>([]);
  const [targetIdx, setTargetIdx] = useState(0);
  const target = points[targetIdx] ?? null;

  // Trace officielle
  const [officialLine, setOfficialLine] = useState<[number, number][]>([]);
  const [hasOfficial, setHasOfficial] = useState(false);

  // Distance à la polyline (pour état “sur trace”)
  const [offRouteM, setOffRouteM] = useState<number | null>(null);
  const onTraceRef = useRef(false);
  const onTraceAnnouncedRef = useRef(false);

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

  // Turn guidance (UNIQUEMENT quand sur trace)
  const lockedTurnRef = useRef<LockedTurn | null>(null);
  const [lockedTurnUI, setLockedTurnUI] = useState<LockedTurn | null>(null);
  const turnVoiceStageRef = useRef<{ id: string; stage: "none" | "soon" | "now" } | null>(null);

  // Progression sur trace
  const traceIdxRef = useRef<number>(0);

  // ====== Tuning ======
  const ARRIVE_STOP_M = 45;
  const DING_AT_M = 10;

  function warnStopMeters() {
    const v = speedRef.current ?? null;
    const kmh = v != null ? v * 3.6 : 0;
    return kmh >= 80 ? 200 : 150;
  }

  // “Sur trace”
  const ON_TRACE_M = 18; // <= 18m => sur trace
  const MIN_SPEED_FOR_TURNS = 1.0; // m/s
  const MAX_ACC_FOR_TURNS = 40; // m

  // Arrêt manqué
  const STOP_TOUCH_M = 35;
  const STOP_SKIP_CONFIRM_M = 90;
  const STOP_SKIP_MIN_SPEED = 1.2; // m/s
  const STOP_SKIP_TRACE_AHEAD_PTS = 12;

  // Turns (niveau 1)
  const TURN_LOOKAHEAD_M = 55;
  const TURN_SOON_AT_M = 260;
  const TURN_NOW_AT_M = 70;
  const TURN_MIN_ANGLE = 25;

  // index de chaque arrêt sur la trace
  const stopIdxOnTrace = useMemo(() => {
    if (!hasOfficial || officialLine.length < 2) return [];
    return points.map((p) => {
      const near = nearestLineIndex({ lat: p.lat, lng: p.lng }, officialLine);
      return near?.idx ?? 0;
    });
  }, [hasOfficial, officialLine, points]);

  /* =========================
     Mapbox
  ========================= */

  const mapElRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const busMarkerRef = useRef<mapboxgl.Marker | null>(null);

  const MAP_TRACE_SRC = "trace-src";
  const MAP_TRACE_LAYER = "trace-layer";
  const MAP_TRACE_HALO = "trace-layer-halo";
  const MAP_STOPS_SRC = "stops-src";
  const MAP_STOPS_LAYER = "stops-layer";

  function ensureMapToken() {
    const token = (import.meta as any).env?.VITE_MAPBOX_TOKEN || "";
    mapboxgl.accessToken = token;
    return token;
  }

  function ensureMap() {
    if (mapRef.current) return mapRef.current;
    if (!mapElRef.current) return null;

    const token = ensureMapToken();
    if (!token) {
      console.error("❌ Mapbox: VITE_MAPBOX_TOKEN manquant (page blanche probable).");
      setErr("Mapbox: token manquant (VITE_MAPBOX_TOKEN).");
      return null;
    }

    const m = new mapboxgl.Map({
      container: mapElRef.current,
      style: "mapbox://styles/mapbox/navigation-day-v1",
      center: [-73.0, 46.8],
      zoom: 15,
      pitch: 60,
      bearing: 0,
      attributionControl: false,
    });

    m.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "bottom-right");

    mapRef.current = m;

    // IMPORTANT: si Mapbox recharge le style (rare), on doit remettre les layers
    m.on("style.load", () => {
      // On remettra les sources/layers via effect quand officialLine/points sont là
    });

    return m;
  }

  function ensureBusMarker() {
    const m = mapRef.current;
    if (!m) return null;
    if (busMarkerRef.current) return busMarkerRef.current;

    const el = document.createElement("div");
    el.style.width = "34px";
    el.style.height = "34px";
    el.style.borderRadius = "18px";
    el.style.background = "#111827";
    el.style.display = "flex";
    el.style.alignItems = "center";
    el.style.justifyContent = "center";
    el.style.boxShadow = "0 10px 26px rgba(0,0,0,.25)";
    el.style.border = "3px solid #60a5fa";

    const icon = document.createElement("div");
    icon.textContent = "🚌";
    icon.style.fontSize = "18px";
    icon.style.transformOrigin = "50% 50%";
    icon.setAttribute("data-bus-icon", "1");
    el.appendChild(icon);

    const mk = new mapboxgl.Marker({ element: el, anchor: "center" }).setLngLat([-73.0, 46.8]).addTo(m);
    busMarkerRef.current = mk;
    return mk;
  }

  function setBusRotation(deg: number) {
    const mk = busMarkerRef.current;
    if (!mk) return;
    const el = mk.getElement();
    const icon = el.querySelector('[data-bus-icon="1"]') as HTMLDivElement | null;
    if (!icon) return;
    icon.style.transform = `rotate(${deg}deg)`;
  }

  function updateCamera(mePos: LatLng, bearing: number) {
    const m = mapRef.current;
    if (!m) return;

    const v = speedRef.current ?? null;
    const kmh = v != null ? v * 3.6 : 0;
    const targetZoom = kmh >= 60 ? 17.5 : kmh >= 25 ? 16.8 : 16.2;

    m.easeTo({
      center: [mePos.lng, mePos.lat],
      zoom: targetZoom,
      pitch: 60,
      bearing,
      duration: 450,
      easing: (t: number) => t,
    });
  }

  function upsertTraceOnMap(line: [number, number][]) {
    const m = mapRef.current;
    if (!m) return;
    if (!line || line.length < 2) return;

    // GeoJSON coords: [lng, lat]
    const coords: [number, number][] = line.map(([lat, lng]) => [lng, lat]);

    const geojson: GFeature<GLineString> = {
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: coords },
    };

    const addOrUpdate = () => {
      // source
      const src = m.getSource(MAP_TRACE_SRC) as mapboxgl.GeoJSONSource | undefined;
      if (!src) {
        m.addSource(MAP_TRACE_SRC, { type: "geojson", data: geojson });

        // halo d'abord (dessous)
        m.addLayer({
          id: MAP_TRACE_HALO,
          type: "line",
          source: MAP_TRACE_SRC,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": "#93c5fd",
            "line-width": 12,
            "line-opacity": 0.28,
          },
        });

        // ligne principale au-dessus
        m.addLayer({
          id: MAP_TRACE_LAYER,
          type: "line",
          source: MAP_TRACE_SRC,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": "#2563eb",
            "line-width": 7,
            "line-opacity": 0.95,
          },
        });
      } else {
        src.setData(geojson as any);
      }
    };

    if (m.loaded()) addOrUpdate();
    else m.once("load", addOrUpdate);
  }

  function upsertStopsOnMap(pts: { lat: number; lng: number; label?: string | null }[]) {
    const m = mapRef.current;
    if (!m) return;
    if (!pts || pts.length === 0) return;

    const fc: GFeatureCollection<GPoint> = {
      type: "FeatureCollection",
      features: pts.map((p, i) => ({
        type: "Feature",
        properties: { idx: i, label: p.label ?? "" },
        geometry: { type: "Point", coordinates: [p.lng, p.lat] },
      })),
    };

    const addOrUpdate = () => {
      const src = m.getSource(MAP_STOPS_SRC) as mapboxgl.GeoJSONSource | undefined;
      if (!src) {
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
      } else {
        src.setData(fc as any);
      }
    };

    if (m.loaded()) addOrUpdate();
    else m.once("load", addOrUpdate);
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
    traceIdxRef.current = 0;

    // reset UI refs
    stopWarnRef.current = null;
    stopWarnMaxRef.current = null;
    stopDingRef.current = null;
    stopBannerLastMRef.current = null;
    setStopBanner({ show: false, meters: 0, label: null, max: 150 });

    stopTouchedRef.current = false;
    stopMinDistRef.current = Infinity;

    lockedTurnRef.current = null;
    setLockedTurnUI(null);
    turnVoiceStageRef.current = null;

    onTraceRef.current = false;
    onTraceAnnouncedRef.current = false;

    // Map layers
    const m = ensureMap();
    if (m) {
      upsertTraceOnMap(line);
      upsertStopsOnMap(pts);
      ensureBusMarker();

      // Si tu veux “centrer” sur la trace au départ:
      // on se contente de laisser la caméra suivre le GPS ensuite.
    }
  }

  /* =========================
     Start / Stop
  ========================= */

  async function start() {
    setErr(null);

    if (!circuitId) {
      alert("Circuit manquant. Reviens au portail.");
      return;
    }

    await ding.unlock();
    await tryEnterFullscreen();

    const got = await new Promise<{ lat: number; lng: number; acc?: number | null }>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (p) =>
          resolve({
            lat: p.coords.latitude,
            lng: p.coords.longitude,
            acc: p.coords.accuracy ?? null,
          }),
        (e) => reject(new Error(e.message)),
        { enableHighAccuracy: true, maximumAge: 800, timeout: 15000 }
      );
    });

    const initial = { lat: got.lat, lng: got.lng };
    meSmoothRef.current = initial;
    setMe(initial);

    setAcc(got.acc ?? null);
    accRef.current = got.acc ?? null;

    ensureMap();
    ensureBusMarker();

    await loadCircuit();

    setRunning(true);
    speak("Navigation démarrée.", { cooldownMs: 300, interrupt: true });
  }

  function stop() {
    setRunning(false);
    setFinished(false);

    lockedTurnRef.current = null;
    setLockedTurnUI(null);
    turnVoiceStageRef.current = null;

    stopTouchedRef.current = false;
    stopMinDistRef.current = Infinity;

    onTraceRef.current = false;
    onTraceAnnouncedRef.current = false;

    stopAll();
    tryExitFullscreen();
  }

  /* =========================
     GPS tracking (lissage + heading)
  ========================= */

  useEffect(() => {
    if (!running) return;

    let watchId: number | null = null;

    watchId = watchPos(
      (p) => {
        const raw = { lat: p.lat, lng: p.lng };

        const v = p.speed ?? null;
        const alpha = v != null ? clamp(0.18 + v * 0.02, 0.18, 0.38) : 0.22;

        const sm = smoothPos(meSmoothRef.current, raw, alpha);
        meSmoothRef.current = sm;
        setMe(sm);

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
     Off-route distance + sur-trace flag
  ========================= */

  useEffect(() => {
    if (!running) return;
    if (!me) return;
    if (!hasOfficial || officialLine.length < 2) return;

    const dLine = minDistanceToPolylineMeters(me, officialLine);
    setOffRouteM(dLine);

    const isOn = dLine != null && dLine <= ON_TRACE_M;
    if (isOn && !onTraceRef.current) {
      onTraceRef.current = true;

      // annonce 1 seule fois quand on embarque sur la trace
      if (!onTraceAnnouncedRef.current) {
        onTraceAnnouncedRef.current = true;
        speak("Trajet repris.", { cooldownMs: 900, interrupt: true });
      }
    }
    if (!isOn) {
      onTraceRef.current = false;
      // IMPORTANT: aucun reroute, aucun recalcul, juste “rejoindre le trajet”
      // On remet aussi les manœuvres pour éviter des annonces hors trace
      lockedTurnRef.current = null;
      setLockedTurnUI(null);
      turnVoiceStageRef.current = null;
    }
  }, [running, me, hasOfficial, officialLine]);

  /* =========================
     Map updates (marker + caméra “au volant”)
  ========================= */

  useEffect(() => {
    if (!running) return;
    if (!me) return;

    const m = ensureMap();
    if (!m) return;

    const mk = ensureBusMarker();
    if (!mk) return;

    mk.setLngLat([me.lng, me.lat]);

    const bearing = (headingRef.current ?? lastBearingRef.current) || 0;

    setBusRotation(bearing);
    updateCamera(me, bearing);
  }, [running, me, heading]);

  /* =========================
     Stops + bandeau jaune + ding + skip arrêt manqué
     (indépendant du fait d’être sur la trace : bandeau reste crucial)
  ========================= */

  useEffect(() => {
    if (!running) return;
    if (!me || !target) return;
    if (finished) return;

    const dStop = haversineMeters(me, target);
    const rawStopM = Math.round(dStop);

    const dynamicMax = warnStopMeters();
    if (stopWarnMaxRef.current == null) stopWarnMaxRef.current = dynamicMax;
    const WARN_STOP_M = stopWarnMaxRef.current ?? dynamicMax;

    // Mode intelligent: arrêt manqué (si trace existe)
    if (hasOfficial && officialLine.length >= 2) {
      const speedNow = speedRef.current ?? null;
      const nearMe = nearestLineIndex(me, officialLine);
      if (nearMe) traceIdxRef.current = Math.max(traceIdxRef.current, nearMe.idx);

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
          setTargetIdx(next);

          stopTouchedRef.current = false;
          stopMinDistRef.current = Infinity;

          stopWarnRef.current = null;
          stopWarnMaxRef.current = null;
          stopDingRef.current = null;
          stopBannerLastMRef.current = null;
          setStopBanner({ show: false, meters: 0, label: null, max: warnStopMeters() });

          // Reset manœuvre
          lockedTurnRef.current = null;
          setLockedTurnUI(null);
          turnVoiceStageRef.current = null;
          return;
        }
      }
    }

    // hors zone
    if (rawStopM > WARN_STOP_M) {
      if (stopBanner.show) setStopBanner({ show: false, meters: 0, label: null, max: WARN_STOP_M });
      stopBannerLastMRef.current = null;
    }

    // dans zone -> bandeau + annonce 1x
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

    // ding à 10m
    if (rawStopM <= DING_AT_M && rawStopM > 1) {
      if (stopDingRef.current !== targetIdx) {
        stopDingRef.current = targetIdx;
        ding.play();
      }
    }

    // arrivé arrêt -> prochain
    if (dStop <= ARRIVE_STOP_M) {
      setStopBanner({ show: false, meters: 0, label: null, max: WARN_STOP_M });

      const next = targetIdx + 1;
      if (next < points.length) {
        const nextTarget = points[next] ?? null;
        const distNext = nextTarget ? Math.round(haversineMeters(me, nextTarget)) : 0;

        speak(`Arrêt atteint. Prochain embarquement dans ${fmtDist(distNext)}.`, { cooldownMs: 1400, interrupt: true });
        setTargetIdx(next);

        stopWarnRef.current = null;
        stopWarnMaxRef.current = null;
        stopDingRef.current = null;
        stopBannerLastMRef.current = null;

        stopTouchedRef.current = false;
        stopMinDistRef.current = Infinity;

        lockedTurnRef.current = null;
        setLockedTurnUI(null);
        turnVoiceStageRef.current = null;
      } else {
        speak("Circuit terminé.", { cooldownMs: 1200, interrupt: true });
        setFinished(true);

        stopWarnRef.current = null;
        stopWarnMaxRef.current = null;
        stopDingRef.current = null;
        stopBannerLastMRef.current = null;

        stopTouchedRef.current = false;
        stopMinDistRef.current = Infinity;

        lockedTurnRef.current = null;
        setLockedTurnUI(null);
        turnVoiceStageRef.current = null;
      }
    }
  }, [running, me, target, targetIdx, points, finished, stopBanner.show, hasOfficial, officialLine, stopIdxOnTrace]);

  /* =========================
     ✅ Directions UNIQUEMENT sur la trace
     - Aucun reroute
     - Si hors trace => juste "Rejoindre le trajet"
  ========================= */

  useEffect(() => {
    if (!running) return;
    if (!me) return;
    if (!hasOfficial || officialLine.length < 2) return;
    if (finished) return;

    if (!onTraceRef.current) {
      // hors trace : pas de directions
      lockedTurnRef.current = null;
      setLockedTurnUI(null);
      turnVoiceStageRef.current = null;
      return;
    }

    // garde-fous
    const a = accRef.current ?? null;
    if (a != null && a > MAX_ACC_FOR_TURNS) return;

    const v = speedRef.current ?? null;
    if (v != null && v < MIN_SPEED_FOR_TURNS) return;

    const near = nearestLineIndex(me, officialLine);
    if (!near) return;

    traceIdxRef.current = Math.max(traceIdxRef.current, near.idx);
    const baseIdx = traceIdxRef.current;

    const existing = lockedTurnRef.current;
    if (existing) {
      const distToTurn = haversineMeters(me, existing.turnPoint);

      const passedByIndex = baseIdx >= existing.turnIdx + 8;
      const passedByDistance = distToTurn <= 18;

      if (passedByDistance || passedByIndex) {
        lockedTurnRef.current = null;
        setLockedTurnUI(null);
        turnVoiceStageRef.current = null;
      } else {
        const stage = turnVoiceStageRef.current;
        const id = existing.id;

        if ((!stage || stage.id !== id) && distToTurn <= TURN_SOON_AT_M && distToTurn > TURN_NOW_AT_M) {
          turnVoiceStageRef.current = { id, stage: "soon" };
          speak(`${existing.text} dans ${fmtDist(distToTurn)}.`, { cooldownMs: 1200, interrupt: true });
        }

        if ((stage?.id !== id || stage.stage !== "now") && distToTurn <= TURN_NOW_AT_M) {
          turnVoiceStageRef.current = { id, stage: "now" };
          speak(`${existing.text} maintenant.`, { cooldownMs: 900, interrupt: true });
        }

        setLockedTurnUI(existing);
        return;
      }
    }

    const ahead1 = walkForward(officialLine, baseIdx, TURN_LOOKAHEAD_M);
    const ahead2 = walkForward(officialLine, ahead1.idx, TURN_LOOKAHEAD_M);

    const A = linePoint(officialLine, baseIdx);
    const B = ahead1.at;
    const C = ahead2.at;

    const ang = angleDeg(A, B, C);
    const txt = turnTextFromAngle(ang);

    if (!txt || Math.abs(ang) < TURN_MIN_ANGLE) {
      lockedTurnRef.current = null;
      setLockedTurnUI(null);
      turnVoiceStageRef.current = null;
      return;
    }

    const distToTurn = haversineMeters(me, B);
    if (distToTurn > 650) {
      setLockedTurnUI(null);
      return;
    }

    const id = `t:${ahead1.idx}:${txt}`;
    const locked: LockedTurn = {
      id,
      text: txt,
      arrow: arrowFromText(txt),
      turnIdx: ahead1.idx,
      turnPoint: B,
    };

    lockedTurnRef.current = locked;
    setLockedTurnUI(locked);

    if (distToTurn <= TURN_SOON_AT_M && distToTurn > TURN_NOW_AT_M) {
      turnVoiceStageRef.current = { id, stage: "soon" };
      speak(`${txt} dans ${fmtDist(distToTurn)}.`, { cooldownMs: 1200, interrupt: true });
    }
  }, [running, me, hasOfficial, officialLine, finished]);

  const turnDistanceText =
    finished
      ? ""
      : lockedTurnUI && me
      ? `dans ${fmtDist(haversineMeters(me, lockedTurnUI.turnPoint))}`
      : "";

  /* =========================
     UI
  ========================= */

  const statusText = finished
    ? "Terminé"
    : onTraceRef.current
    ? "Sur le trajet"
    : "Hors trajet (rejoindre la ligne bleue)";

  const mainInstruction = finished
    ? "✅ Circuit terminé"
    : onTraceRef.current
    ? lockedTurnUI
      ? lockedTurnUI.text
      : "Suivez la ligne bleue"
    : "Rejoindre le trajet";

  const arrow = finished ? "✅" : onTraceRef.current ? lockedTurnUI?.arrow ?? "⬆️" : "⬆️";

  return (
    <div style={{ ...page, minHeight: "100vh" }}>
      <div style={{ ...container, maxWidth: 980 }}>
        <div style={card}>
          <div style={row}>
            <div style={{ flex: 1 }}>
              <h1 style={h1}>Navigation (Map + trajet)</h1>
              <div style={muted}>
                {hasOfficial ? <>Trace officielle active.</> : <>Trace officielle requise.</>}{" "}
                {wlSupported ? `Écran allumé: ${wlActive ? "Oui" : "Non"}` : ""}
              </div>
              {acc != null && <div style={muted}>Précision GPS: ~{Math.round(acc)} m</div>}
              {speed != null && <div style={muted}>Vitesse: ~{Math.round(speed * 3.6)} km/h</div>}
              <div style={muted}>
                État: <b>{statusText}</b>
              </div>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button style={btn("ghost")} onClick={() => nav("/")}>
                Retour
              </button>
              <button style={btn("ghost")} onClick={stop}>
                Terminer
              </button>
            </div>
          </div>
        </div>

        {!running ? (
          <div style={card}>
            <button style={bigBtn} onClick={() => start().catch((e) => alert(e.message))} disabled={!circuitId}>
              Démarrer
            </button>
            {!circuitId && <div style={{ ...muted, marginTop: 10 }}>Circuit manquant. Reviens au portail.</div>}
          </div>
        ) : (
          <div style={{ ...card, position: "relative", padding: 0, overflow: "hidden" }}>
            {/* Map */}
            <div style={{ position: "relative" }}>
              <div ref={mapElRef} style={{ height: 520, width: "100%" }} />

              {/* Bandeau jaune (CRUCIAL) */}
              {stopBanner.show &&
                (() => {
                  const MAX = Number.isFinite(stopBanner.max) ? stopBanner.max : 150;
                  const meters = Number.isFinite(stopBanner.meters) ? stopBanner.meters : 0;
                  const m = Math.max(0, Math.min(MAX, Math.round(meters)));
                  const pct = Math.round((1 - m / MAX) * 100);

                  const bg = "#FBBF24";
                  const accent = "#111827";
                  const iconBg = "#111827";
                  const iconColor = "#FBBF24";

                  return (
                    <div
                      style={{
                        position: "absolute",
                        top: 10,
                        left: 10,
                        right: 10,
                        zIndex: 9999,
                        background: bg,
                        color: accent,
                        border: "1px solid rgba(0,0,0,.12)",
                        borderRadius: 16,
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
                            background: iconBg,
                            color: iconColor,
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
                          <div style={{ fontSize: 13, opacity: 0.9 }}>
                            {stopBanner.label ?? "Zone d’embarquement / débarquement"}
                          </div>
                        </div>
                      </div>

                      <div style={{ height: 12, borderRadius: 999, background: "rgba(0,0,0,.18)", overflow: "hidden" }}>
                        <div
                          style={{
                            height: "100%",
                            width: `${pct}%`,
                            background: accent,
                            borderRadius: 999,
                            transition: "width 140ms linear",
                          }}
                        />
                      </div>
                    </div>
                  );
                })()}
            </div>

            {/* Panneau conduite */}
            <div style={{ padding: 16, display: "grid", gap: 10 }}>
              <div style={{ fontWeight: 900, fontSize: 18 }}>
                Prochain arrêt : {targetIdx + 1} / {points.length}
              </div>
              <div style={{ ...muted, fontSize: 16 }}>{target?.label ? target.label : "—"}</div>

              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ fontSize: 64, lineHeight: "64px" }}>{arrow}</div>

                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 950, fontSize: 34, lineHeight: "38px" }}>{mainInstruction}</div>

                  {/* Distance seulement si on est sur trace + manœuvre active */}
                  {!finished && onTraceRef.current && turnDistanceText && (
                    <div style={{ fontSize: 24, opacity: 0.85, marginTop: 8 }}>
                      <b>{turnDistanceText}</b>
                    </div>
                  )}
                </div>
              </div>

              {err && <div style={{ color: "#b91c1c", fontWeight: 900, fontSize: 16 }}>{err}</div>}

              {offRouteM != null && (
                <div style={{ ...muted, fontSize: 14 }}>
                  Écart: <b>{Math.round(offRouteM)} m</b>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
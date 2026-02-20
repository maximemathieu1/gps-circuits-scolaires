// src/pages/NavLive.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { MapContainer, Polyline, TileLayer, Marker, useMap } from "react-leaflet";
import L from "leaflet";

import { callFn } from "@/lib/api";
import { haversineMeters } from "@/lib/geo";
import { useWakeLock } from "@/lib/useWakeLock";
import { page, container, card, h1, muted, row, btn, bigBtn } from "@/ui";

/* =========================
   Types
========================= */

type Step = {
  distance: number;
  duration: number;
  name: string;
  instruction: string;
  type: string;
  modifier: string;
  location: { lat: number; lng: number };
};

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

function normDeg(d: number) {
  let x = d % 360;
  if (x < 0) x += 360;
  return x;
}

function bearingDeg(from: { lat: number; lng: number }, to: { lat: number; lng: number }) {
  const toRad = (v: number) => (v * Math.PI) / 180;
  const toDeg = (v: number) => (v * 180) / Math.PI;

  const φ1 = toRad(from.lat);
  const φ2 = toRad(to.lat);
  const Δλ = toRad(to.lng - from.lng);

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return normDeg(toDeg(Math.atan2(y, x)));
}

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

/** Lissage position (anti-jitter) */
function smoothPos(prev: { lat: number; lng: number } | null, next: { lat: number; lng: number }, alpha: number) {
  if (!prev) return next;
  return {
    lat: prev.lat + (next.lat - prev.lat) * alpha,
    lng: prev.lng + (next.lng - prev.lng) * alpha,
  };
}

function angDiffDeg(a: number, b: number) {
  let d = normDeg(b) - normDeg(a);
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

// Approx meters using equirectangular projection around current latitude
function projectMeters(originLat: number, p: { lat: number; lng: number }) {
  const R = 6371000;
  const lat = (p.lat * Math.PI) / 180;
  const lng = (p.lng * Math.PI) / 180;
  const lat0 = (originLat * Math.PI) / 180;
  return {
    x: R * lng * Math.cos(lat0),
    y: R * lat,
  };
}

function distPointToSegmentMeters(
  originLat: number,
  p: { lat: number; lng: number },
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
) {
  const P = projectMeters(originLat, p);
  const A = projectMeters(originLat, a);
  const B = projectMeters(originLat, b);

  const ABx = B.x - A.x;
  const ABy = B.y - A.y;
  const APx = P.x - A.x;
  const APy = P.y - A.y;

  const denom = ABx * ABx + ABy * ABy;
  if (denom <= 1e-9) {
    const dx = P.x - A.x;
    const dy = P.y - A.y;
    return Math.hypot(dx, dy);
  }

  const t = clamp((APx * ABx + APy * ABy) / denom, 0, 1);
  const cx = A.x + t * ABx;
  const cy = A.y + t * ABy;

  return Math.hypot(P.x - cx, P.y - cy);
}

function minDistanceToPolylineMeters(me: { lat: number; lng: number }, line: [number, number][]) {
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

/** Voix "béton" + fallback FR */
function speak(text: string) {
  try {
    const t = (text ?? "").trim();
    if (!t) return;

    window.speechSynthesis.cancel();

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
  } catch {
    // ignore
  }
}

function maneuverArrow(mod?: string) {
  const m = (mod || "").toLowerCase();
  if (m.includes("uturn")) return "⤴️";
  if (m.includes("left")) return "⬅️";
  if (m.includes("right")) return "➡️";
  if (m.includes("straight")) return "⬆️";
  return "⬆️";
}

/** Ding court (WebAudio) — sans fichier externe */
function playDing() {
  try {
    const AC = (window.AudioContext || (window as any).webkitAudioContext) as any;
    if (!AC) return;

    const ctx = new AC();
    const o = ctx.createOscillator();
    const g = ctx.createGain();

    o.type = "sine";
    o.frequency.setValueAtTime(880, ctx.currentTime); // La
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);

    o.connect(g);
    g.connect(ctx.destination);

    o.start();
    o.stop(ctx.currentTime + 0.2);

    // ferme proprement
    o.onended = () => {
      try {
        ctx.close?.();
      } catch {
        // ignore
      }
    };
  } catch {
    // ignore
  }
}

/* =========================
   Leaflet icons
========================= */

const meIcon = new L.DivIcon({
  className: "",
  html: `<div style="width:14px;height:14px;border-radius:999px;background:#2F6FDB;border:3px solid #fff;box-shadow:0 2px 10px rgba(0,0,0,.25)"></div>`,
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

function headingIcon(deg: number) {
  const d = normDeg(deg);
  return new L.DivIcon({
    className: "",
    html: `
      <div style="
        width:0;height:0;
        border-left:9px solid transparent;
        border-right:9px solid transparent;
        border-bottom:18px solid #1A73E8;
        filter: drop-shadow(0 2px 6px rgba(0,0,0,.25));
        transform: rotate(${d}deg) translateZ(0);
        transform-origin: 50% 60%;
      "></div>
    `,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

// Icône "enfant / zone scolaire" (plus parlant que STOP)
const schoolStopIcon = new L.DivIcon({
  className: "",
  html: `
    <div style="display:flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:999px;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.25);border:2px solid #f59e0b;">
      <div style="width:26px;height:26px;border-radius:8px;background:#f59e0b;display:flex;align-items:center;justify-content:center;color:#111827;font-weight:900;font-size:16px;">
        🧒
      </div>
    </div>
  `,
  iconSize: [38, 38],
  iconAnchor: [19, 19],
});

/* =========================
   Map helpers components
========================= */

function FollowMe({ me, follow }: { me: { lat: number; lng: number } | null; follow: boolean }) {
  const map = useMap();
  const lastRef = useRef<{ lat: number; lng: number } | null>(null);
  const lastPanAtRef = useRef(0);

  useEffect(() => {
    if (!follow || !me) return;

    // throttle: max 4x/sec
    const now = Date.now();
    if (now - lastPanAtRef.current < 250) return;
    lastPanAtRef.current = now;

    const last = lastRef.current;
    if (last) {
      const moved = haversineMeters(me, last);
      if (moved < 6) return; // anti-jitter
    }
    lastRef.current = me;

    // Zoom "GPS" stable
    const z = clamp(map.getZoom(), 16, 18);
    map.setView([me.lat, me.lng], z, { animate: false });

    // Décale le point vers le bas (feeling "au volant")
    const size = map.getSize();
    map.panBy([0, Math.round(size.y * 0.18)], { animate: false });
  }, [me, follow, map]);

  return null;
}

function RotateMap({ enabled, bearingDeg }: { enabled: boolean; bearingDeg: number | null }) {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();
    const pane = container.querySelector(".leaflet-map-pane") as HTMLElement | null;
    if (!pane) return;

    pane.style.willChange = "transform";
    pane.style.transformOrigin = "50% 50%";
    (pane.style as any).backfaceVisibility = "hidden";
    pane.style.webkitTransformStyle = "preserve-3d";
    pane.style.transformStyle = "preserve-3d";

    if (!enabled || bearingDeg == null) {
      pane.style.transform = "translateZ(0)";
      return;
    }

    const rot = -normDeg(bearingDeg);
    pane.style.transform = `rotate(${rot}deg) translateZ(0)`;
  }, [map, enabled, bearingDeg]);

  return null;
}

/* =========================
   Main
========================= */

export default function NavLive() {
  const q = useQuery();
  const nav = useNavigate();

  const circuitId = q.get("circuit") || "";

  const [running, setRunning] = useState(false);
  const [follow, setFollow] = useState(true);

  // Rotation carte
  const [rotateMap, setRotateMap] = useState(true);
  const [bearing, setBearing] = useState<number | null>(null);
  const bearingSmoothRef = useRef<number | null>(null);
  const [bearingSmooth, setBearingSmooth] = useState<number | null>(null);

  // Data circuit (arrêts)
  const [points, setPoints] = useState<{ lat: number; lng: number; label?: string | null }[]>([]);
  const [targetIdx, setTargetIdx] = useState(0);
  const target = points[targetIdx] ?? null;

  // Trace officielle (trajet habituel)
  const [officialLine, setOfficialLine] = useState<[number, number][]>([]);
  const [hasOfficial, setHasOfficial] = useState(false);

  // GPS
  const [me, setMe] = useState<{ lat: number; lng: number } | null>(null);
  const meSmoothRef = useRef<{ lat: number; lng: number } | null>(null);

  const [acc, setAcc] = useState<number | null>(null);
  const accRef = useRef<number | null>(null);

  const [speed, setSpeed] = useState<number | null>(null);
  const speedRef = useRef<number | null>(null);

  const [err, setErr] = useState<string | null>(null);

  // Route Mapbox (aide / retour sur la route)
  const [routeLine, setRouteLine] = useState<[number, number][]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [stepIdx, setStepIdx] = useState(0);

  // Breadcrumb (trajet réel)
  const [trail, setTrail] = useState<[number, number][]>([]);

  // Off-route + reroute anti-stress
  const [offRouteM, setOffRouteM] = useState<number | null>(null);
  const offRouteStrikeRef = useRef(0);
  const lastRerouteAtRef = useRef(0);

  const { supported: wlSupported, active: wlActive } = useWakeLock(running);

  // Annonces
  const spokenNearStepRef = useRef<number | null>(null);
  const stopWarn200Ref = useRef<number | null>(null);
  const lastArrivedIdxRef = useRef<number | null>(null);

  // Bandeau arrêt scolaire (UI)
  const [stopBanner, setStopBanner] = useState<{ show: boolean; meters: number; label?: string | null }>({
    show: false,
    meters: 0,
    label: null,
  });

  // Pour bearing fallback
  const lastMeForBearingRef = useRef<{ lat: number; lng: number } | null>(null);

  // Cache route Mapbox
  const routeCacheRef = useRef(new Map<string, { line: [number, number][]; steps: Step[]; at: number }>());
  const routeInFlightRef = useRef<AbortController | null>(null);

  const ARRIVE_STOP_M = 45;
  const WARN_STOP_M = 200;
  const SAY_NEAR_M = 80;
  const STEP_ADVANCE_M = 14;

  const OFF_ROUTE_M = 35;
  const ON_ROUTE_M = 18;

  // Rotation: plus stable si on évite quand très lent
  const ROTATE_MIN_SPEED = 2.5; // m/s ~9 km/h
  const ROTATE_MIN_CHANGE = 6; // degrés

  // Warmup voix iOS
  useEffect(() => {
    try {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
    } catch {
      // ignore
    }
  }, []);

  async function loadCircuit(): Promise<{ pts: { lat: number; lng: number; label?: string | null }[]; hasOfficial: boolean }> {
    if (!circuitId) throw new Error("Circuit manquant.");

    // 1) Arrêts
    const r = await callFn<PointsResp>("circuits-api", { action: "get_active_points", circuit_id: circuitId });
    const pts = r.points.map((p) => ({ lat: p.lat, lng: p.lng, label: p.label ?? null }));
    if (pts.length === 0) throw new Error("Ce circuit n’a aucun arrêt enregistré.");

    setPoints(pts);
    setTargetIdx(0);

    // reset nav hints
    setStepIdx(0);
    setSteps([]);
    setRouteLine([]);
    spokenNearStepRef.current = null;

    // reset breadcrumb
    setTrail([]);

    // reset offroute
    setOffRouteM(null);
    offRouteStrikeRef.current = 0;
    lastRerouteAtRef.current = 0;

    // reset stop warning
    stopWarn200Ref.current = null;
    lastArrivedIdxRef.current = null;
    setStopBanner({ show: false, meters: 0, label: null });

    // reset bearing smooth
    bearingSmoothRef.current = null;
    setBearing(null);
    setBearingSmooth(null);
    lastMeForBearingRef.current = null;

    // reset smoothing me
    meSmoothRef.current = null;

    // 2) Trace officielle (optionnel)
    let ok = false;
    try {
      const tr = await callFn<TraceResp>("circuits-api", { action: "get_latest_trace", circuit_id: circuitId });
      const line: [number, number][] = (tr.trail ?? []).map((p) => [p.lat, p.lng]);
      if (line.length >= 2) {
        setOfficialLine(line);
        setHasOfficial(true);
        ok = true;
      } else {
        setOfficialLine([]);
        setHasOfficial(false);
      }
    } catch {
      setOfficialLine([]);
      setHasOfficial(false);
    }

    return { pts, hasOfficial: ok };
  }

  function cacheKey(from: { lat: number; lng: number }, to: { lat: number; lng: number }) {
    const rf = (v: number) => Math.round(v * 10000) / 10000;
    return `${rf(from.lat)},${rf(from.lng)}->${rf(to.lat)},${rf(to.lng)}`;
  }

  async function calcRoute(from: { lat: number; lng: number }, to: { lat: number; lng: number }) {
    try {
      routeInFlightRef.current?.abort();
    } catch {}
    const ctl = new AbortController();
    routeInFlightRef.current = ctl;

    const key = cacheKey(from, to);
    const cached = routeCacheRef.current.get(key);
    const now = Date.now();

    if (cached && now - cached.at < 10 * 60 * 1000 && cached.line.length >= 2) {
      setRouteLine(cached.line);
      setSteps(cached.steps);
      setStepIdx(0);
      spokenNearStepRef.current = null;
      return;
    }

    const timeout = setTimeout(() => {
      try {
        ctl.abort();
      } catch {}
    }, 8000);

    try {
      const r = await callFn<{ geometry: any; steps: Step[] }>(
        "nav-api",
        { action: "route", from, to },
        // @ts-ignore
        { signal: ctl.signal }
      );

      const coords: [number, number][] = (r.geometry?.coordinates ?? []).map((c: any) => [c[1], c[0]]);
      const st = r.steps ?? [];

      setRouteLine(coords);
      setSteps(st);
      setStepIdx(0);
      spokenNearStepRef.current = null;

      routeCacheRef.current.set(key, { line: coords, steps: st, at: now });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function start() {
    setErr(null);

    if (!circuitId) {
      alert("Circuit manquant. Reviens au portail.");
      return;
    }

    const got = await new Promise<{ lat: number; lng: number; acc?: number | null; heading?: number | null }>(
      (resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
          (p) =>
            resolve({
              lat: p.coords.latitude,
              lng: p.coords.longitude,
              acc: p.coords.accuracy ?? null,
              heading: (p.coords as any).heading ?? null,
            }),
          (e) => reject(new Error(e.message)),
          { enableHighAccuracy: true, maximumAge: 800, timeout: 15000 }
        );
      }
    );

    const initial = { lat: got.lat, lng: got.lng };
    meSmoothRef.current = initial;
    setMe(initial);

    setAcc(got.acc ?? null);
    accRef.current = got.acc ?? null;

    if (got.heading != null && Number.isFinite(got.heading)) setBearing(normDeg(got.heading as number));

    const { pts, hasOfficial: officialOk } = await loadCircuit();

    if (!officialOk) {
      const firstTarget = pts[0] ?? null;
      if (firstTarget) {
        try {
          await calcRoute(initial, firstTarget);
        } catch (e: any) {
          setErr(e?.message ?? "Erreur itinéraire");
        }
      }
    }

    setRunning(true);
    speak("Navigation démarrée.");
  }

  function stop() {
    setRunning(false);
    try {
      routeInFlightRef.current?.abort();
    } catch {}
    window.speechSynthesis.cancel();
  }

  // GPS tracking (avec lissage position)
  useEffect(() => {
    if (!running) return;

    let watchId: number | null = null;

    watchId = watchPos(
      (p) => {
        const raw = { lat: p.lat, lng: p.lng };

        // alpha selon vitesse: plus lent => plus lissé
        const v = p.speed ?? null;
        const alpha = v != null ? clamp(0.18 + v * 0.02, 0.18, 0.38) : 0.22;

        const sm = smoothPos(meSmoothRef.current, raw, alpha);
        meSmoothRef.current = sm;
        setMe(sm);

        setAcc(p.acc ?? null);
        setSpeed(p.speed ?? null);
        accRef.current = p.acc ?? null;
        speedRef.current = p.speed ?? null;

        setTrail((prev) => {
          const next: [number, number][] = [...prev, [sm.lat, sm.lng]];
          if (next.length > 1400) next.splice(0, next.length - 1400);
          return next;
        });

        // Bearing: utiliser raw pour direction + stabilité
        const hd = p.heading;
        if (hd != null && Number.isFinite(hd)) {
          setBearing(normDeg(hd));
          lastMeForBearingRef.current = raw;
        } else {
          const last = lastMeForBearingRef.current;
          if (last) {
            const moved = haversineMeters(raw, last);
            if (moved >= 10) {
              setBearing(bearingDeg(last, raw));
              lastMeForBearingRef.current = raw;
            }
          } else {
            lastMeForBearingRef.current = raw;
          }
        }
      },
      (m) => setErr(m)
    );

    return () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    };
  }, [running]);

  // Bearing smoothing (+ stabilité rotation à basse vitesse)
  useEffect(() => {
    if (bearing == null) return;

    const v = speedRef.current ?? null;
    if (v != null && v < ROTATE_MIN_SPEED) {
      // trop lent: on fige la rotation (évite shakiness au feu rouge)
      return;
    }

    const prev = bearingSmoothRef.current;
    if (prev == null) {
      bearingSmoothRef.current = bearing;
      setBearingSmooth(bearing);
      return;
    }

    const diff = angDiffDeg(prev, bearing);
    if (Math.abs(diff) < ROTATE_MIN_CHANGE) {
      // petits changements => ignore
      return;
    }

    const alpha = 0.14; // un peu plus stable
    const next = normDeg(prev + diff * alpha);

    bearingSmoothRef.current = next;
    setBearingSmooth(next);
  }, [bearing]);

  // ✅ REROUTE ANTI-STRESS
  useEffect(() => {
    if (!running) return;
    if (!me || !target) return;

    const lineForOffRoute =
      hasOfficial && officialLine.length >= 2 ? officialLine : routeLine.length >= 2 ? routeLine : null;

    if (!lineForOffRoute) return;

    const dLine = minDistanceToPolylineMeters(me, lineForOffRoute);
    setOffRouteM(dLine);

    const a = accRef.current ?? null;
    if (a != null && a > 35) return;

    const v = speedRef.current ?? null; // m/s
    if (v != null && v < 1.2) return; // ~4.3 km/h

    const now = Date.now();

    const isOff = dLine != null && dLine > OFF_ROUTE_M;
    if (isOff) offRouteStrikeRef.current += 1;
    else if (dLine != null && dLine < ON_ROUTE_M) offRouteStrikeRef.current = 0;

    const COOLDOWN_MS = 12000;
    if (now - lastRerouteAtRef.current < COOLDOWN_MS) return;

    const needHelp = offRouteStrikeRef.current >= 3;
    if (!needHelp) return;

    lastRerouteAtRef.current = now;
    offRouteStrikeRef.current = 0;

    speak("Recalcul de l’itinéraire.");
    calcRoute(me, target).catch((e: any) => setErr(e?.message ?? "Erreur reroute"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, me, targetIdx, hasOfficial, officialLine, routeLine]);

  // Arrêts + annonces + bandeau + steps
  useEffect(() => {
    if (!running) return;
    if (!me || !target) return;

    const dStop = haversineMeters(me, target);

    // Bandeau visuel (200m -> arrivée)
    if (dStop <= WARN_STOP_M && dStop > ARRIVE_STOP_M) {
      setStopBanner({
        show: true,
        meters: Math.max(0, Math.round(dStop)),
        label: target.label ?? null,
      });
    } else {
      setStopBanner((s) => (s.show ? { show: false, meters: 0, label: null } : s));
    }

    // ✅ Annonce arrêt à 200m (ding + voix) — une seule fois
    if (dStop <= WARN_STOP_M && dStop > ARRIVE_STOP_M) {
      if (stopWarn200Ref.current !== targetIdx) {
        stopWarn200Ref.current = targetIdx;
        playDing();
        speak("Ralentissez. Arrêt scolaire dans deux cents mètres.");
      }
    }

    // ✅ Arrivée arrêt
    if (dStop <= ARRIVE_STOP_M) {
      if (lastArrivedIdxRef.current !== targetIdx) {
        lastArrivedIdxRef.current = targetIdx;

        const next = targetIdx + 1;
        if (next < points.length) {
          const nextTarget = points[next] ?? null;
          const distNext = nextTarget ? Math.round(haversineMeters(me, nextTarget)) : 0;

          speak(`Arrêt atteint. Prochain embarquement dans ${distNext} mètres.`);
          setTargetIdx(next);

          stopWarn200Ref.current = null;
          setStopBanner({ show: false, meters: 0, label: null });

          if (!hasOfficial) {
            if (nextTarget) calcRoute(me, nextTarget).catch((e: any) => setErr(e?.message ?? "Erreur itinéraire"));
          }
        } else {
          speak("Circuit terminé.");
          stop();
        }
      }
      return;
    }

    // ✅ Instructions Mapbox (1 seule annonce proche, pas de “NOW”)
    const currStep = steps[stepIdx];
    if (!currStep?.location) return;

    const dManeuver = haversineMeters(me, currStep.location);

    if (dManeuver <= SAY_NEAR_M) {
      if (spokenNearStepRef.current !== stepIdx) {
        spokenNearStepRef.current = stepIdx;
        speak(`${currStep.instruction} dans ${Math.round(dManeuver)} mètres`);
      }
    }

    if (dManeuver <= STEP_ADVANCE_M && stepIdx < steps.length - 1) {
      setStepIdx((i) => i + 1);
      spokenNearStepRef.current = null;
    }
  }, [running, me, target, points.length, targetIdx, steps, stepIdx, hasOfficial]);

  const center: [number, number] = me
    ? [me.lat, me.lng]
    : points[0]
    ? [points[0].lat, points[0].lng]
    : [46.8, -71.2];

  const nextStep = steps[stepIdx];

  return (
    <div style={page}>
      <div style={container}>
        <div style={card}>
          <div style={row}>
            <div style={{ flex: 1 }}>
              <h1 style={h1}>Navigation continue</h1>
              <div style={muted}>
                {hasOfficial ? (
                  <>
                    Trajet officiel : <b>ligne bleue</b>. Mapbox sert juste si tu t’éloignes.
                  </>
                ) : (
                  <>Mode fallback : itinéraire calculé par Mapbox.</>
                )}{" "}
                {wlSupported ? `Écran allumé: ${wlActive ? "Oui" : "Non"}` : ""}
              </div>
              {acc != null && <div style={muted}>Précision GPS: ~{Math.round(acc)} m</div>}
              {speed != null && <div style={muted}>Vitesse: ~{Math.round(speed * 3.6)} km/h</div>}
            </div>
            <button style={btn("ghost")} onClick={() => nav("/")}>
              Retour
            </button>
          </div>
        </div>

        {!running ? (
          <div style={card}>
            <button style={bigBtn} onClick={() => start().catch((e) => alert(e.message))} disabled={!circuitId}>
              Démarrer
            </button>

            <button
              style={{ ...bigBtn, marginTop: 10, background: "#fff", color: "#111827", border: "1px solid #e5e7eb" }}
              onClick={() => {
                playDing();
                speak("Test de navigation. La voix fonctionne.");
              }}
            >
              Tester la voix
            </button>

            {!circuitId && <div style={{ ...muted, marginTop: 10 }}>Circuit manquant. Reviens au portail.</div>}
          </div>
        ) : (
          <>
            <div style={card}>
              <div style={{ display: "grid", gap: 10 }}>
                <div style={{ fontWeight: 900 }}>
                  Prochain arrêt : {targetIdx + 1} / {points.length}
                </div>
                <div style={muted}>{target?.label ? target.label : "—"}</div>

                {me && target && (
                  <div style={muted}>
                    Distance arrêt : <b>{Math.round(haversineMeters(me, target))} m</b>
                  </div>
                )}

                {offRouteM != null && (
                  <div style={muted}>
                    Écart à {hasOfficial ? "la trace" : "la route"} : <b>{Math.round(offRouteM)} m</b>
                    {offRouteM > OFF_ROUTE_M ? " (aide auto…)" : ""}
                  </div>
                )}

                <div style={{ height: 4 }} />

                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ fontSize: 34, lineHeight: "34px" }}>{maneuverArrow(nextStep?.modifier)}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 900, fontSize: 16 }}>
                      {nextStep?.instruction ? nextStep.instruction : hasOfficial ? "Suis la ligne bleue…" : "Calcul en cours…"}
                    </div>
                    {me && nextStep?.location && (
                      <div style={muted}>
                        Dans <b>{Math.round(haversineMeters(me, nextStep.location))} m</b>
                      </div>
                    )}
                  </div>
                </div>

                {err && <div style={{ color: "#b91c1c", fontWeight: 800 }}>{err}</div>}

                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button style={{ ...btn("ghost"), flex: 1, minWidth: 150 }} onClick={() => setFollow((v) => !v)}>
                    Suivi carte: {follow ? "ON" : "OFF"}
                  </button>

                  <button style={{ ...btn("ghost"), flex: 1, minWidth: 150 }} onClick={() => setRotateMap((v) => !v)}>
                    Rotation: {rotateMap ? "ON" : "OFF"}
                  </button>

                  <button
                    style={{ ...btn("ghost"), flex: 1, minWidth: 150 }}
                    onClick={() => {
                      playDing();
                      speak("Test de navigation. La voix fonctionne.");
                    }}
                  >
                    Test voix
                  </button>
                </div>

                <button style={{ ...bigBtn, background: "#fff", color: "#111827", border: "1px solid #e5e7eb" }} onClick={stop}>
                  Arrêter
                </button>
              </div>
            </div>

            <div style={{ ...card, padding: 10 }}>
              <div style={{ height: 460, borderRadius: 14, overflow: "hidden", position: "relative" }}>
                {/* Bandeau Waze-like + barre progression intelligente */}
                {stopBanner.show ? (
                  (() => {
                    const MAX = 200;
                    const meters = Number.isFinite(stopBanner.meters) ? stopBanner.meters : 0;
                    const m = Math.max(0, Math.min(MAX, Math.round(meters)));
                    const pct = Math.round((1 - m / MAX) * 100);

                    let bg = "#FBBF24";
                    let accent = "#111827";
                    let iconBg = "#111827";
                    let iconColor = "#FBBF24";

                    if (m <= 40) {
                      bg = "#EF4444";
                      accent = "#ffffff";
                      iconBg = "#ffffff";
                      iconColor = "#EF4444";
                    } else if (m <= 80) {
                      bg = "#F97316";
                      accent = "#111827";
                      iconBg = "#111827";
                      iconColor = "#F97316";
                    }

                    const pulse = m <= 40;

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
                          borderRadius: 14,
                          padding: "10px 12px",
                          boxShadow: pulse
                            ? "0 0 0 4px rgba(239,68,68,.35), 0 8px 22px rgba(0,0,0,.18)"
                            : "0 8px 22px rgba(0,0,0,.18)",
                          display: "grid",
                          gap: 8,
                          transition: "background 180ms ease, box-shadow 180ms ease",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <div
                            style={{
                              width: 34,
                              height: 34,
                              borderRadius: 12,
                              background: iconBg,
                              color: iconColor,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontSize: 18,
                              fontWeight: 900,
                              transition: "all 180ms ease",
                            }}
                            aria-hidden
                          >
                            🧒
                          </div>

                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 900 }}>Arrêt scolaire dans {m} m</div>
                            <div style={{ fontSize: 12, opacity: 0.85 }}>
                              {stopBanner.label ?? "Zone d’embarquement / débarquement"}
                            </div>
                          </div>
                        </div>

                        <div
                          style={{
                            height: 10,
                            borderRadius: 999,
                            background: "rgba(0,0,0,.2)",
                            overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              height: "100%",
                              width: `${pct}%`,
                              background: accent,
                              borderRadius: 999,
                              transition: "width 140ms linear, background 180ms ease",
                            }}
                          />
                        </div>
                      </div>
                    );
                  })()
                ) : null}

               <MapContainer
  center={center}
  zoom={17}
  style={{ height: "100%", width: "100%" }}
  preferCanvas={true}
>
                  <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

                  <FollowMe me={me} follow={follow} />
                  <RotateMap enabled={rotateMap} bearingDeg={bearingSmooth} />

                  {/* Breadcrumb (trajet réel) */}
                  {trail.length >= 2 && (
                    <Polyline
                      positions={trail}
                      pathOptions={{ color: "#8ab4f8", weight: 4, opacity: 0.55, lineCap: "round", lineJoin: "round" }}
                    />
                  )}

                  {/* Trace officielle */}
                  {hasOfficial && officialLine.length > 0 && (
                    <>
                      <Polyline
                        positions={officialLine}
                        pathOptions={{ color: "#ffffff", weight: 12, opacity: 0.92, lineCap: "round", lineJoin: "round" }}
                      />
                      <Polyline
                        positions={officialLine}
                        pathOptions={{ color: "#1A73E8", weight: 7, opacity: 0.95, lineCap: "round", lineJoin: "round" }}
                      />
                    </>
                  )}

                  {/* Route Mapbox (aide / retour) */}
                  {routeLine.length > 0 && (
                    <>
                      <Polyline
                        positions={routeLine}
                        pathOptions={{ color: "#ffffff", weight: 10, opacity: 0.75, lineCap: "round", lineJoin: "round" }}
                      />
                      <Polyline
                        positions={routeLine}
                        pathOptions={{ color: "#1A73E8", weight: 6, opacity: 0.75, lineCap: "round", lineJoin: "round" }}
                      />
                    </>
                  )}

                  {/* Moi */}
                  {me && <Marker position={[me.lat, me.lng]} icon={meIcon} />}
                  {me && bearingSmooth != null && <Marker position={[me.lat, me.lng]} icon={headingIcon(bearingSmooth)} />}

                  {/* Prochain arrêt (icône enfant) */}
                  {target && <Marker position={[target.lat, target.lng]} icon={schoolStopIcon} />}
                </MapContainer>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
// src/pages/NavLive.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

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
  // angle between vectors BA and BC (signed via cross)
  const ax = a.lng - b.lng;
  const ay = a.lat - b.lat;
  const cx = c.lng - b.lng;
  const cy = c.lat - b.lat;

  const dot = ax * cx + ay * cy;
  const det = ax * cy - ay * cx;
  const ang = Math.atan2(det, dot) * (180 / Math.PI);
  return ang; // signed: + = left, - = right (approx)
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
  const unlockedRef = useRef(false);

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
      unlockedRef.current = true;
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

  return { unlock, play, isUnlocked: () => unlockedRef.current };
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

type LockedTurn = {
  id: string; // stable key
  text: string;
  arrow: string;
  turnIdx: number; // index on trace near the turn point
  turnPoint: LatLng; // point to measure distance
};

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

  const [err, setErr] = useState<string | null>(null);

  // Stops
  const [points, setPoints] = useState<{ lat: number; lng: number; label?: string | null }[]>([]);
  const [targetIdx, setTargetIdx] = useState(0);
  const target = points[targetIdx] ?? null;

  // Trace officielle
  const [officialLine, setOfficialLine] = useState<[number, number][]>([]);
  const [hasOfficial, setHasOfficial] = useState(false);

  // Mode nav
  const [mode, setMode] = useState<"to_start" | "on_trace">("to_start");
  const entryPointRef = useRef<LatLng | null>(null);

  // nav-api (seulement pour rejoindre entry/rejoin)
  const [routeLine, setRouteLine] = useState<[number, number][]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [stepIdx, setStepIdx] = useState(0);

  // Progression trace
  const traceIdxRef = useRef<number>(0);

  // Off-route + reroute
  const [offRouteM, setOffRouteM] = useState<number | null>(null);
  const offRouteStrikeRef = useRef(0);
  const lastRerouteAtRef = useRef(0);

  const { supported: wlSupported, active: wlActive } = useWakeLock(running);

  // Stops warnings + ding
  const stopWarnRef = useRef<number | null>(null);
  const stopWarnMaxRef = useRef<number | null>(null);
  const stopDingRef = useRef<number | null>(null);

  const [stopBanner, setStopBanner] = useState<{ show: boolean; meters: number; label?: string | null; max: number }>(
    { show: false, meters: 0, label: null, max: 150 }
  );
  const stopBannerLastMRef = useRef<number | null>(null);

  // Locked turn + voice stages (niveau 1)
  const lockedTurnRef = useRef<LockedTurn | null>(null);
  const [lockedTurnUI, setLockedTurnUI] = useState<LockedTurn | null>(null);
  const turnVoiceStageRef = useRef<{ id: string; stage: "none" | "soon" | "now" } | null>(null);

  // Cache nav-api routes (entry/rejoin only)
  const routeCacheRef = useRef(new Map<string, { line: [number, number][]; steps: Step[]; at: number }>());
  const routeInFlightRef = useRef<AbortController | null>(null);

  // ====== Tuning ======
  const ARRIVE_STOP_M = 45;
  const DING_AT_M = 10;

  function warnStopMeters() {
    const v = speedRef.current ?? null;
    const kmh = v != null ? v * 3.6 : 0;
    return kmh >= 80 ? 200 : 150;
  }

  const OFF_ROUTE_M = 28;
  const ON_ROUTE_M = 14;
  const REROUTE_COOLDOWN_MS = 7000;

  // Turn detection on trace (niveau 1)
  const TURN_LOOKAHEAD_M = 55;
  const TURN_SOON_AT_M = 260; // “Dans X…”
  const TURN_NOW_AT_M = 70; // “Maintenant”
  const TURN_MIN_ANGLE = 25;

  function cacheKey(from: LatLng, to: LatLng) {
    const rf = (v: number) => Math.round(v * 10000) / 10000;
    return `${rf(from.lat)},${rf(from.lng)}->${rf(to.lat)},${rf(to.lng)}`;
  }

  async function calcRoute(from: LatLng, to: LatLng) {
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
      return;
    }

    const timeout = setTimeout(() => {
      try {
        ctl.abort();
      } catch {}
    }, 9000);

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

      routeCacheRef.current.set(key, { line: coords, steps: st, at: now });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function loadCircuit() {
    if (!circuitId) throw new Error("Circuit manquant.");

    const r = await callFn<PointsResp>("circuits-api", { action: "get_active_points", circuit_id: circuitId });
    const pts = r.points.map((p) => ({ lat: p.lat, lng: p.lng, label: p.label ?? null }));
    if (pts.length === 0) throw new Error("Ce circuit n’a aucun arrêt enregistré.");

    setPoints(pts);
    setTargetIdx(0);

    setRouteLine([]);
    setSteps([]);
    setStepIdx(0);

    setOffRouteM(null);
    offRouteStrikeRef.current = 0;
    lastRerouteAtRef.current = 0;

    stopWarnRef.current = null;
    stopWarnMaxRef.current = null;
    stopDingRef.current = null;
    stopBannerLastMRef.current = null;
    setStopBanner({ show: false, meters: 0, label: null, max: 150 });

    setFinished(false);
    traceIdxRef.current = 0;

    // Reset locked turn
    lockedTurnRef.current = null;
    setLockedTurnUI(null);
    turnVoiceStageRef.current = null;

    // Trace officielle: indispensable
    const tr = await callFn<TraceResp>("circuits-api", { action: "get_latest_trace", circuit_id: circuitId });
    const line: [number, number][] = (tr.trail ?? []).map((p) => [p.lat, p.lng]);

    if (line.length >= 2) {
      setOfficialLine(line);
      setHasOfficial(true);
    } else {
      setOfficialLine([]);
      setHasOfficial(false);
      throw new Error("Trace officielle introuvable (aucun trail).");
    }

    return pts;
  }

  function computeEntryPointForStop1(line: [number, number][], stop1: LatLng) {
    const near = nearestLineIndex(stop1, line);
    const stopIdxOnTrace = near ? near.idx : 0;

    let idx = stopIdxOnTrace;
    let left = 80;

    while (idx > 0 && left > 0) {
      const a = linePoint(line, idx);
      const b = linePoint(line, idx - 1);
      const d = haversineMeters(a, b);
      if (d <= 0.01) {
        idx--;
        continue;
      }
      left -= d;
      idx--;
    }

    return { entryIdx: Math.max(0, idx), entry: linePoint(line, Math.max(0, idx)), stopIdxOnTrace };
  }

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

    await loadCircuit();

    setRunning(true);
    setMode("to_start");

    speak("Navigation démarrée.", { cooldownMs: 300, interrupt: true });
  }

  function stop() {
    setRunning(false);
    setFinished(false);
    setMode("to_start");
    entryPointRef.current = null;

    lockedTurnRef.current = null;
    setLockedTurnUI(null);
    turnVoiceStageRef.current = null;

    try {
      routeInFlightRef.current?.abort();
    } catch {}
    stopAll();
    tryExitFullscreen();
  }

  // Quand officialLine est chargé et qu’on est running: calcule entry + route vers entry
  useEffect(() => {
    if (!running) return;
    if (!hasOfficial || officialLine.length < 2) return;
    if (!points[0]) return;
    if (!me) return;

    if (entryPointRef.current) return;

    const stop1 = points[0];
    const { entryIdx, entry } = computeEntryPointForStop1(officialLine, stop1);

    entryPointRef.current = entry;
    traceIdxRef.current = entryIdx;

    calcRoute(me, entry)
      .then(() => speak("Rejoignez le trajet enregistré.", { cooldownMs: 900, interrupt: true }))
      .catch((e: any) => setErr(e?.message ?? "Erreur itinéraire vers départ"));
  }, [running, hasOfficial, officialLine, points, me]);

  // GPS tracking (lissage)
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
      },
      (m) => setErr(m)
    );

    return () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    };
  }, [running]);

  // Off-route distance (trace si possible)
  useEffect(() => {
    if (!running) return;
    if (!me) return;

    const line = hasOfficial && officialLine.length >= 2 ? officialLine : routeLine.length >= 2 ? routeLine : null;
    if (!line) return;

    const dLine = minDistanceToPolylineMeters(me, line);
    setOffRouteM(dLine);
  }, [running, me, hasOfficial, officialLine, routeLine]);

  // REROUTE: toujours “retour à la trace”
  useEffect(() => {
    if (!running) return;
    if (!me) return;
    if (!hasOfficial || officialLine.length < 2) return;
    if (finished) return;

    const a = accRef.current ?? null;
    if (a != null && a > 35) return;

    const v = speedRef.current ?? null;
    if (v != null && v < 1.0) return;

    const now = Date.now();
    if (now - lastRerouteAtRef.current < REROUTE_COOLDOWN_MS) return;

    const near = nearestLineIndex(me, officialLine);
    if (!near) return;

    let idx = near.idx;
    if (idx < traceIdxRef.current) idx = traceIdxRef.current;

    const off = near.dist;
    const isOff = off > OFF_ROUTE_M;
    if (isOff) offRouteStrikeRef.current += 1;
    else if (off < ON_ROUTE_M) offRouteStrikeRef.current = 0;

    if (offRouteStrikeRef.current < 2) return;

    offRouteStrikeRef.current = 0;
    lastRerouteAtRef.current = now;

    const ahead = walkForward(officialLine, idx, 25);
    const rejoin = ahead.at;

    setMode("to_start");
    entryPointRef.current = rejoin;

    // On “déverrouille” la manœuvre car on n’est plus sûr du contexte
    lockedTurnRef.current = null;
    setLockedTurnUI(null);
    turnVoiceStageRef.current = null;

    calcRoute(me, rejoin)
      .then(() => speak("Recalcul en cours. Revenez sur le trajet.", { cooldownMs: 900, interrupt: true }))
      .catch((e: any) => setErr(e?.message ?? "Erreur recalculation"));
  }, [running, me, hasOfficial, officialLine, finished]);

  // Stops + banner + ding + bascule mode on_trace
  useEffect(() => {
    if (!running) return;
    if (!me || !target) return;

    // Bascule vers on_trace quand on est proche du point d’entrée/rejoin
    if (hasOfficial && officialLine.length >= 2 && entryPointRef.current) {
      const dEntry = haversineMeters(me, entryPointRef.current);
      if (mode !== "on_trace" && dEntry <= 35) {
        setMode("on_trace");
        const nearMe = nearestLineIndex(me, officialLine);
        if (nearMe) traceIdxRef.current = Math.max(traceIdxRef.current, nearMe.idx);
        speak("Trajet enregistré repris.", { cooldownMs: 900, interrupt: true });
      }
    }

    // STOP ZONE (bandeau jaune monotone + ding)
    const dStop = haversineMeters(me, target);
    const rawStopM = Math.round(dStop);

    const dynamicMax = warnStopMeters();
    if (stopWarnMaxRef.current == null) stopWarnMaxRef.current = dynamicMax;
    const WARN_STOP_M = stopWarnMaxRef.current ?? dynamicMax;

    if (rawStopM > WARN_STOP_M) {
      if (stopBanner.show) setStopBanner({ show: false, meters: 0, label: null, max: WARN_STOP_M });
      stopBannerLastMRef.current = null;
    }

    if (!finished && rawStopM <= WARN_STOP_M && rawStopM > ARRIVE_STOP_M) {
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

    if (!finished && rawStopM <= DING_AT_M && rawStopM > 1) {
      if (stopDingRef.current !== targetIdx) {
        stopDingRef.current = targetIdx;
        ding.play();
      }
    }

    // Arrivée arrêt => enchaîne
    if (!finished && dStop <= ARRIVE_STOP_M) {
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

        if (hasOfficial && officialLine.length >= 2) {
          const nearMe = nearestLineIndex(me, officialLine);
          if (nearMe) traceIdxRef.current = Math.max(traceIdxRef.current, nearMe.idx);
        }

        setMode("on_trace");
        entryPointRef.current = null;
        setRouteLine([]);
        setSteps([]);
        setStepIdx(0);

        // Reset manœuvre verrouillée à chaque arrêt (ça évite des fausses instructions)
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
      }
    }
  }, [running, me, target, targetIdx, points, finished, stopBanner.show, hasOfficial, officialLine, mode]);

  // ===== Niveau 1: Turn guidance stable (verrouillage + 2 annonces) =====
  useEffect(() => {
    if (!running) return;
    if (!me) return;
    if (!hasOfficial || officialLine.length < 2) return;
    if (finished) return;

    if (mode !== "on_trace") {
      lockedTurnRef.current = null;
      setLockedTurnUI(null);
      turnVoiceStageRef.current = null;
      return;
    }

    const near = nearestLineIndex(me, officialLine);
    if (!near) return;

    traceIdxRef.current = Math.max(traceIdxRef.current, near.idx);
    const baseIdx = traceIdxRef.current;

    // Si on a déjà une manœuvre verrouillée, on la garde tant qu’elle n’est pas “passée”
    const existing = lockedTurnRef.current;
    if (existing) {
      const distToTurn = haversineMeters(me, existing.turnPoint);

      // passé si on est très proche puis on dépasse, OU si on a avancé sur trace au-delà de turnIdx + marge
      const passedByIndex = baseIdx >= existing.turnIdx + 8;
      const passedByDistance = distToTurn <= 18;

      if (passedByDistance || passedByIndex) {
        lockedTurnRef.current = null;
        setLockedTurnUI(null);
        turnVoiceStageRef.current = null;
      } else {
        // Annonces 2 étapes (soon / now) sans spam
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

        // UI: garder instruction + distance arrondie
        setLockedTurnUI(existing);
        return;
      }
    }

    // Sinon: on détecte une nouvelle manœuvre en regardant la géométrie “en avant”
    const ahead1 = walkForward(officialLine, baseIdx, TURN_LOOKAHEAD_M);
    const ahead2 = walkForward(officialLine, ahead1.idx, TURN_LOOKAHEAD_M);

    const A = linePoint(officialLine, baseIdx);
    const B = ahead1.at; // point de “virage”
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

    // On ne verrouille que si la manœuvre est dans une fenêtre raisonnable (sinon ça “panique” trop tôt)
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

    // Et on fait l’annonce “soon” dès qu’on rentre dans la zone
    if (distToTurn <= TURN_SOON_AT_M && distToTurn > TURN_NOW_AT_M) {
      turnVoiceStageRef.current = { id, stage: "soon" };
      speak(`${txt} dans ${fmtDist(distToTurn)}.`, { cooldownMs: 1200, interrupt: true });
    }
  }, [running, me, hasOfficial, officialLine, finished, mode]);

  // UI instruction affichée
  const showNavStep = mode !== "on_trace" ? steps[stepIdx] : null;

  // avance nav-api step (mode to_start seulement)
  useEffect(() => {
    if (!running) return;
    if (!me) return;
    if (mode === "on_trace") return;
    if (!showNavStep?.location) return;

    const d = haversineMeters(me, showNavStep.location);
    if (d <= 16 && stepIdx < steps.length - 1) setStepIdx((i) => i + 1);
  }, [running, me, mode, showNavStep, stepIdx, steps.length]);

  const turnDistanceText =
    finished
      ? ""
      : mode === "on_trace"
      ? lockedTurnUI
        ? `dans ${fmtDist(haversineMeters(me!, lockedTurnUI.turnPoint))}`
        : ""
      : me && showNavStep?.location
      ? `dans ${fmtDist(haversineMeters(me, showNavStep.location))}`
      : "";

  return (
    <div style={{ ...page, minHeight: "100vh" }}>
      <div style={{ ...container, maxWidth: 900 }}>
        <div style={card}>
          <div style={row}>
            <div style={{ flex: 1 }}>
              <h1 style={h1}>Navigation (GPS fidèle)</h1>
              <div style={muted}>
                {hasOfficial ? <>Trace officielle active. Trajet identique à l’enregistrement.</> : <>Trace officielle requise.</>}{" "}
                {wlSupported ? `Écran allumé: ${wlActive ? "Oui" : "Non"}` : ""}
              </div>
              {acc != null && <div style={muted}>Précision GPS: ~{Math.round(acc)} m</div>}
              {speed != null && <div style={muted}>Vitesse: ~{Math.round(speed * 3.6)} km/h</div>}
              <div style={muted}>
                Mode: <b>{mode === "on_trace" ? "Trajet enregistré" : "Rejoindre le trajet"}</b>
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
          <div style={{ ...card, position: "relative" }}>
            {/* Bandeau jaune (crucial) */}
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

            {/* UI conduite */}
            <div style={{ display: "grid", gap: 14, paddingTop: 86 }}>
              <div style={{ fontWeight: 900, fontSize: 18 }}>
                Prochain arrêt : {targetIdx + 1} / {points.length}
              </div>

              <div style={{ ...muted, fontSize: 16 }}>{target?.label ? target.label : "—"}</div>

              {/* ✅ IMPORTANT: on a ENLEVÉ le gros compteur “XXX m” ici */}

              <div style={{ height: 8 }} />

              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ fontSize: 72, lineHeight: "72px" }}>
                  {finished ? "✅" : mode === "on_trace" ? lockedTurnUI?.arrow ?? "⬆️" : "⬆️"}
                </div>

                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 950, fontSize: 40, lineHeight: "44px" }}>
                    {finished
                      ? "✅ Circuit terminé"
                      : mode === "on_trace"
                      ? lockedTurnUI
                        ? lockedTurnUI.text
                        : "Suivez le trajet enregistré"
                      : showNavStep?.instruction
                      ? showNavStep.instruction
                      : "Rejoindre le trajet…"}
                  </div>

                  {!finished && turnDistanceText && (
                    <div style={{ fontSize: 28, opacity: 0.85, marginTop: 10 }}>
                      <b>{turnDistanceText}</b>
                    </div>
                  )}
                </div>
              </div>

              {err && <div style={{ color: "#b91c1c", fontWeight: 900, fontSize: 18 }}>{err}</div>}

              {offRouteM != null && (
                <div style={{ ...muted, marginTop: 4, fontSize: 16 }}>
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
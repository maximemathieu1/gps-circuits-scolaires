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
  name: string; // nom de rue si dispo
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

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

function smoothPos(prev: { lat: number; lng: number } | null, next: { lat: number; lng: number }, alpha: number) {
  if (!prev) return next;
  return {
    lat: prev.lat + (next.lat - prev.lat) * alpha,
    lng: prev.lng + (next.lng - prev.lng) * alpha,
  };
}

/** Approx meters using equirectangular projection around current latitude */
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
  if (denom <= 1e-9) return Math.hypot(P.x - A.x, P.y - A.y);

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

/* =========================
   Voix + Ding (GPS standard)
========================= */

function playDing() {
  try {
    const AC = (window.AudioContext || (window as any).webkitAudioContext) as any;
    if (!AC) return;

    const ctx = new AC();
    const o = ctx.createOscillator();
    const g = ctx.createGain();

    o.type = "sine";
    o.frequency.setValueAtTime(880, ctx.currentTime);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);

    o.connect(g);
    g.connect(ctx.destination);

    o.start();
    o.stop(ctx.currentTime + 0.2);

    o.onended = () => {
      try {
        ctx.close?.();
      } catch {}
    };
  } catch {}
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

function maneuverArrow(mod?: string) {
  const m = (mod || "").toLowerCase();
  if (m.includes("uturn")) return "⤴️";
  if (m.includes("left")) return "⬅️";
  if (m.includes("right")) return "➡️";
  if (m.includes("straight")) return "⬆️";
  return "⬆️";
}

/** Filtre "GPS standard" : virages utiles + bretelles, pas les micro "slight" inutiles */
function isActionableStep(s: Step | undefined) {
  if (!s?.instruction || !s.location) return false;

  const t = (s.type || "").toLowerCase();
  const mod = (s.modifier || "").toLowerCase();
  const ins = (s.instruction || "").toLowerCase();
  const name = (s.name || "").toLowerCase();

  // Jamais
  if (t.includes("arrive") || t.includes("depart")) return false;

  // Pas d'annonces d'arrêts / waypoint
  if (ins.includes("arrêt") || ins.includes("stop") || ins.includes("destination")) return false;

  // mots clés "utile GPS"
  const isRamp =
    ins.includes("bretelle") ||
    ins.includes("rampe") ||
    ins.includes("merge") ||
    ins.includes("autoroute") ||
    ins.includes("sortie") ||
    ins.includes("exit") ||
    t.includes("merge") ||
    t.includes("fork") ||
    t.includes("ramp") ||
    t.includes("roundabout") ||
    t.includes("exit");

  // "slight left/right" seulement si bretelle/merge/sortie etc.
  if (mod.includes("slight")) return isRamp;

  // "continue / straight" seulement si bretelle/sortie/autoroute (sinon inutile)
  if (t.includes("continue") || mod.includes("straight")) return isRamp;

  // virages classiques
  if (mod.includes("left") || mod.includes("right") || mod.includes("uturn")) return true;

  // fallback: si instruction parle clairement de sortie / bretelle
  if (isRamp) return true;

  // évite d’annoncer du bruit
  if (name && name.length >= 3 && (ins.includes("tournez") || ins.includes("prenez"))) return true;

  return false;
}

function stepPhrase(s: Step) {
  const base = (s.instruction || "").trim();
  const name = (s.name || "").trim();
  if (!name) return base;
  const b = base.toLowerCase();
  const n = name.toLowerCase();
  if (n.length >= 4 && b.includes(n)) return base;
  // standard gps: instruction + rue
  return `${base} sur ${name}`;
}

/* =========================
   Main
========================= */

export default function NavLive() {
  const q = useQuery();
  const nav = useNavigate();
  const { speak, stopAll } = useSpeaker();

  const circuitId = q.get("circuit") || "";

  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);

  // GPS
  const [me, setMe] = useState<{ lat: number; lng: number } | null>(null);
  const meSmoothRef = useRef<{ lat: number; lng: number } | null>(null);

  const [acc, setAcc] = useState<number | null>(null);
  const accRef = useRef<number | null>(null);

  const [speed, setSpeed] = useState<number | null>(null);
  const speedRef = useRef<number | null>(null);

  const [err, setErr] = useState<string | null>(null);

  // Data circuit (arrêts)
  const [points, setPoints] = useState<{ lat: number; lng: number; label?: string | null }[]>([]);
  const [targetIdx, setTargetIdx] = useState(0);
  const target = points[targetIdx] ?? null;

  // Trace officielle (trajet habituel) — utilisé seulement pour "écart"
  const [officialLine, setOfficialLine] = useState<[number, number][]>([]);
  const [hasOfficial, setHasOfficial] = useState(false);

  // Route Mapbox (guidage)
  const [routeLine, setRouteLine] = useState<[number, number][]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [stepIdx, setStepIdx] = useState(0);

  // Off-route + reroute
  const [offRouteM, setOffRouteM] = useState<number | null>(null);
  const offRouteStrikeRef = useRef(0);
  const lastRerouteAtRef = useRef(0);

  const { supported: wlSupported, active: wlActive } = useWakeLock(running);

  // Annonces virage: 2 niveaux max (loin/près) et seulement pour étapes "action"
  const spokenFarRef = useRef<number | null>(null);
  const spokenNearRef = useRef<number | null>(null);

  // Arrêts: avertissement (150/200) + ding 10m
  const stopWarnRef = useRef<number | null>(null);
  const stopWarnMaxRef = useRef<number | null>(null);
  const stopDingRef = useRef<number | null>(null);

  // Bandeau jaune monotone
  const [stopBanner, setStopBanner] = useState<{ show: boolean; meters: number; label?: string | null; max: number }>({
    show: false,
    meters: 0,
    label: null,
    max: 150,
  });
  const stopBannerLastMRef = useRef<number | null>(null);

  // Cache route
  const routeCacheRef = useRef(new Map<string, { line: [number, number][]; steps: Step[]; at: number }>());
  const routeInFlightRef = useRef<AbortController | null>(null);

  // ====== Tuning ======
  const ARRIVE_STOP_M = 45;

  // Zone jaune: 150 si <80 km/h, sinon 200 (figé par arrêt)
  function warnStopMeters() {
    const v = speedRef.current ?? null;
    const kmh = v != null ? v * 3.6 : 0;
    return kmh >= 80 ? 200 : 150;
  }

  // Virages GPS standard: 2 annonces max
  const TURN_FAR_M = 220; // annonce "prépare-toi" (si loin)
  const TURN_NEAR_M = 65; // annonce "maintenant" (unique)
  const STEP_ADVANCE_M = 16;

  // Reroute
  const OFF_ROUTE_M = 28;
  const ON_ROUTE_M = 14;

  // Ding arrêt
  const DING_AT_M = 10;

  async function loadCircuit(): Promise<{ pts: { lat: number; lng: number; label?: string | null }[]; hasOfficial: boolean }> {
    if (!circuitId) throw new Error("Circuit manquant.");

    const r = await callFn<PointsResp>("circuits-api", { action: "get_active_points", circuit_id: circuitId });
    const pts = r.points.map((p) => ({ lat: p.lat, lng: p.lng, label: p.label ?? null }));
    if (pts.length === 0) throw new Error("Ce circuit n’a aucun arrêt enregistré.");

    setPoints(pts);
    setTargetIdx(0);

    setStepIdx(0);
    setSteps([]);
    setRouteLine([]);

    setOffRouteM(null);
    offRouteStrikeRef.current = 0;
    lastRerouteAtRef.current = 0;

    spokenFarRef.current = null;
    spokenNearRef.current = null;

    stopWarnRef.current = null;
    stopWarnMaxRef.current = null;
    stopDingRef.current = null;

    stopBannerLastMRef.current = null;
    setStopBanner({ show: false, meters: 0, label: null, max: 150 });

    meSmoothRef.current = null;
    setFinished(false);

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

  function firstActionIndex(all: Step[]) {
    for (let i = 0; i < all.length; i++) {
      if (isActionableStep(all[i])) return i;
    }
    return 0;
  }

  function nextActionIndex(all: Step[], from: number) {
    for (let i = from + 1; i < all.length; i++) {
      if (isActionableStep(all[i])) return i;
    }
    return Math.min(from + 1, Math.max(0, all.length - 1));
  }

  async function calcRoute(from: { lat: number; lng: number }, to: { lat: number; lng: number }, opts?: { announceStart?: boolean }) {
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

      const idx0 = firstActionIndex(cached.steps);
      setStepIdx(idx0);
      spokenFarRef.current = null;
      spokenNearRef.current = null;

      if (opts?.announceStart) {
        const s0 = cached.steps[idx0];
        if (isActionableStep(s0)) speak(`Pour démarrer, ${stepPhrase(s0)}.`, { cooldownMs: 400, interrupt: true });
      }
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

      const idx0 = firstActionIndex(st);
      setStepIdx(idx0);
      spokenFarRef.current = null;
      spokenNearRef.current = null;

      routeCacheRef.current.set(key, { line: coords, steps: st, at: now });

      // ✅ annonce de départ (garage / stationnement) : 1 fois, tout de suite
      if (opts?.announceStart) {
        const s0 = st[idx0];
        if (isActionableStep(s0)) speak(`Pour démarrer, ${stepPhrase(s0)}.`, { cooldownMs: 400, interrupt: true });
      }
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

    const { pts } = await loadCircuit();

    const firstTarget = pts[0] ?? null;
    if (firstTarget) {
      try {
        await calcRoute(initial, firstTarget, { announceStart: true });
      } catch (e: any) {
        setErr(e?.message ?? "Erreur itinéraire");
      }
    }

    setRunning(true);
    speak("Navigation démarrée.", { cooldownMs: 300, interrupt: true });
  }

  function stop() {
    setRunning(false);
    try {
      routeInFlightRef.current?.abort();
    } catch {}
    stopAll();
  }

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

  // ✅ REROUTE "GPS standard" (vraiment)
  useEffect(() => {
    if (!running) return;
    if (!me || !target) return;
    if (finished) return;

    const lineForOffRoute = routeLine.length >= 2 ? routeLine : hasOfficial && officialLine.length >= 2 ? officialLine : null;
    if (!lineForOffRoute) return;

    const dLine = minDistanceToPolylineMeters(me, lineForOffRoute);
    setOffRouteM(dLine);

    const a = accRef.current ?? null;
    if (a != null && a > 35) return;

    const v = speedRef.current ?? null;
    if (v != null && v < 1.0) return;

    const now = Date.now();

    const isOff = dLine != null && dLine > OFF_ROUTE_M;
    if (isOff) offRouteStrikeRef.current += 1;
    else if (dLine != null && dLine < ON_ROUTE_M) offRouteStrikeRef.current = 0;

    const COOLDOWN_MS = 7000;
    if (now - lastRerouteAtRef.current < COOLDOWN_MS) return;

    // 2 strikes = reroute
    if (offRouteStrikeRef.current < 2) return;

    lastRerouteAtRef.current = now;
    offRouteStrikeRef.current = 0;

    calcRoute(me, target, { announceStart: false }).catch((e: any) => setErr(e?.message ?? "Erreur reroute"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, me, targetIdx, routeLine, hasOfficial, officialLine, finished]);

  // Arrêts + bandeau jaune + ding + virages GPS standard
  useEffect(() => {
    if (!running) return;
    if (!me || !target) return;

    /* ---------- STOP ZONE (150/200 + jaune monotone + ding 10m) ---------- */
    const dStop = haversineMeters(me, target);
    const rawStopM = Math.round(dStop);

    const dynamicMax = warnStopMeters();
    if (stopWarnMaxRef.current == null) stopWarnMaxRef.current = dynamicMax;
    const WARN_STOP_M = stopWarnMaxRef.current ?? dynamicMax;

    // hors zone -> cache + reset monotone
    if (rawStopM > WARN_STOP_M) {
      if (stopBanner.show) setStopBanner({ show: false, meters: 0, label: null, max: WARN_STOP_M });
      stopBannerLastMRef.current = null;
    }

    // dans zone -> monotone
    if (!finished && rawStopM <= WARN_STOP_M && rawStopM > ARRIVE_STOP_M) {
      const prevShown = stopBannerLastMRef.current;
      let shown = prevShown == null ? rawStopM : Math.min(prevShown, rawStopM);
      shown = Math.round(shown / 5) * 5; // anti-jitter
      stopBannerLastMRef.current = shown;

      setStopBanner({ show: true, meters: shown, label: target.label ?? null, max: WARN_STOP_M });

      // annonce unique 150/200
      if (stopWarnRef.current !== targetIdx) {
        stopWarnRef.current = targetIdx;
        speak(`Ralentissez. Arrêt scolaire dans ${WARN_STOP_M} mètres.`, { cooldownMs: 1400, interrupt: true });
      }
    }

    // ding 10m avant
    if (!finished && rawStopM <= DING_AT_M && rawStopM > 1) {
      if (stopDingRef.current !== targetIdx) {
        stopDingRef.current = targetIdx;
        playDing();
      }
    }

    // arrivée arrêt => enchaîne
    if (!finished && dStop <= ARRIVE_STOP_M) {
      setStopBanner({ show: false, meters: 0, label: null, max: WARN_STOP_M });

      const next = targetIdx + 1;
      if (next < points.length) {
        const nextTarget = points[next] ?? null;
        const distNext = nextTarget ? Math.round(haversineMeters(me, nextTarget)) : 0;

        speak(`Arrêt atteint. Prochain embarquement dans ${distNext} mètres.`, { cooldownMs: 1400, interrupt: true });
        setTargetIdx(next);

        // reset stop refs
        stopWarnRef.current = null;
        stopWarnMaxRef.current = null;
        stopDingRef.current = null;
        stopBannerLastMRef.current = null;

        // reset virages refs
        spokenFarRef.current = null;
        spokenNearRef.current = null;

        // calc vers prochain arrêt + annonce de départ du prochain segment
        if (nextTarget) calcRoute(me, nextTarget, { announceStart: true }).catch((e: any) => setErr(e?.message ?? "Erreur itinéraire"));
      } else {
        speak("Circuit terminé.", { cooldownMs: 1200, interrupt: true });
        setFinished(true);

        stopWarnRef.current = null;
        stopWarnMaxRef.current = null;
        stopDingRef.current = null;
        stopBannerLastMRef.current = null;
      }
      return;
    }

    /* ---------- TURN (GPS standard: virages/bretelles seulement) ---------- */
    if (finished) return;

    const curr = steps[stepIdx];
    if (!isActionableStep(curr)) {
      // saute automatiquement jusqu'à prochaine étape utile
      const ni = nextActionIndex(steps, stepIdx);
      if (ni !== stepIdx) {
        setStepIdx(ni);
        spokenFarRef.current = null;
        spokenNearRef.current = null;
      }
      return;
    }

    const dTurn = haversineMeters(me, curr.location);

    // annonce "loin" (max 1 fois)
    if (dTurn <= TURN_FAR_M && dTurn > TURN_NEAR_M) {
      if (spokenFarRef.current !== stepIdx) {
        spokenFarRef.current = stepIdx;
        const msg = `${stepPhrase(curr)} dans ${Math.round(dTurn)} mètres.`;
        speak(msg, { cooldownMs: 1200, interrupt: true });
      }
    }

    // annonce "près" (max 1 fois)
    if (dTurn <= TURN_NEAR_M) {
      if (spokenNearRef.current !== stepIdx) {
        spokenNearRef.current = stepIdx;
        const msg = `${stepPhrase(curr)} maintenant.`;
        speak(msg, { cooldownMs: 900, interrupt: true });
      }
    }

    // advance step (et saute aux étapes utiles)
    if (dTurn <= STEP_ADVANCE_M && stepIdx < steps.length - 1) {
      const ni = nextActionIndex(steps, stepIdx);
      setStepIdx(ni);
      spokenFarRef.current = null;
      spokenNearRef.current = null;
    }
  }, [running, me, target, targetIdx, points.length, steps, stepIdx, finished, stopBanner.show, routeLine, hasOfficial, officialLine]);

  const nextStep = steps[stepIdx];
  const showTurn = isActionableStep(nextStep) ? nextStep : undefined;

  return (
    <div style={page}>
      <div style={container}>
        <div style={card}>
          <div style={row}>
            <div style={{ flex: 1 }}>
              <h1 style={h1}>Navigation (GPS)</h1>
              <div style={muted}>
                {hasOfficial ? <>Trace officielle détectée. Recalcul GPS actif.</> : <>Recalcul GPS actif.</>}{" "}
                {wlSupported ? `Écran allumé: ${wlActive ? "Oui" : "Non"}` : ""}
              </div>
              {acc != null && <div style={muted}>Précision GPS: ~{Math.round(acc)} m</div>}
              {speed != null && <div style={muted}>Vitesse: ~{Math.round(speed * 3.6)} km/h</div>}
            </div>

            {/* ✅ SEULS BOUTONS AUTORISÉS */}
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
            {/* Bandeau jaune 150/200 (monotone) */}
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
                        <div style={{ fontSize: 13, opacity: 0.9 }}>{stopBanner.label ?? "Zone d’embarquement / débarquement"}</div>
                      </div>
                    </div>

                    <div style={{ height: 12, borderRadius: 999, background: "rgba(0,0,0,.18)", overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${pct}%`, background: accent, borderRadius: 999, transition: "width 140ms linear" }} />
                    </div>
                  </div>
                );
              })()}

            {/* UI conduite (plus gros) */}
            <div style={{ display: "grid", gap: 14, paddingTop: 86 }}>
              <div style={{ fontWeight: 900, fontSize: 18 }}>
                Prochain arrêt : {targetIdx + 1} / {points.length}
              </div>

              <div style={{ ...muted, fontSize: 16 }}>{target?.label ? target.label : "—"}</div>

              {me && target && (
                <div style={{ fontSize: 54, fontWeight: 950, letterSpacing: -0.8, lineHeight: "56px" }}>
                  {Math.round(haversineMeters(me, target))} m
                </div>
              )}

              <div style={{ height: 8 }} />

              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ fontSize: 72, lineHeight: "72px" }}>{maneuverArrow(showTurn?.modifier)}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 950, fontSize: 40, lineHeight: "44px" }}>
                    {finished ? "✅ Circuit terminé" : showTurn?.instruction ? showTurn.instruction : "…"}
                  </div>

                  {!finished && showTurn?.name && (
                    <div style={{ fontSize: 24, opacity: 0.8, marginTop: 8 }}>
                      <b>{showTurn.name}</b>
                    </div>
                  )}

                  {!finished && me && showTurn?.location && (
                    <div style={{ fontSize: 28, opacity: 0.85, marginTop: 10 }}>
                      dans <b>{Math.round(haversineMeters(me, showTurn.location))} m</b>
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
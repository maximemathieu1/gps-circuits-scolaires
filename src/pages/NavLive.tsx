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

/** Lissage position (anti-jitter) */
function smoothPos(prev: { lat: number; lng: number } | null, next: { lat: number; lng: number }, alpha: number) {
  if (!prev) return next;
  return {
    lat: prev.lat + (next.lat - prev.lat) * alpha,
    lng: prev.lng + (next.lng - prev.lng) * alpha,
  };
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

/* =========================
   Voix + Ding
========================= */

/** Ding court (WebAudio) — sans fichier externe */
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

/** Voix "béton" + anti-spam + fallback FR */
function useSpeaker() {
  const lastSpeakAtRef = useRef(0);

  // warmup iOS
  useEffect(() => {
    try {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
    } catch {}
  }, []);

  function speak(text: string, opts?: { cooldownMs?: number; interrupt?: boolean }) {
    try {
      const t = (text ?? "").trim();
      if (!t) return;

      const now = Date.now();
      const cooldownMs = opts?.cooldownMs ?? 1200;

      if (now - lastSpeakAtRef.current < cooldownMs) return;
      lastSpeakAtRef.current = now;

      // interrupt par défaut pour éviter l’empilement
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

/** Ajoute le nom de rue si dispo (et si pas déjà dans l'instruction) */
function enrichInstruction(step: Step | undefined) {
  if (!step?.instruction) return "";
  const base = (step.instruction ?? "").trim();
  const name = (step.name ?? "").trim();

  if (!name) return base;

  const b = base.toLowerCase();
  const n = name.toLowerCase();
  const already = n.length >= 4 && b.includes(n);

  return already ? base : `${base} sur ${name}`;
}

/** Filtre "légèrement" : on garde juste si bretelle/sortie, sinon c'est mêlant */
function isRampLike(step: Step) {
  const t = (step.type || "").toLowerCase();
  const i = (step.instruction || "").toLowerCase();
  const n = (step.name || "").toLowerCase();
  const keywords = ["bretelle", "rampe", "sortie", "entrée", "autoroute", "merge", "fork", "ramp", "exit", "slip", "junction"];
  return keywords.some((k) => t.includes(k) || i.includes(k) || n.includes(k));
}

function isMinorSlight(step: Step) {
  const m = (step.modifier || "").toLowerCase();
  const isSlight = m.includes("slight") || m.includes("bear") || m.includes("keep");
  if (!isSlight) return false;
  if (isRampLike(step)) return false; // OK on garde pour bretelles
  if (step.distance != null && step.distance < 180) return true;
  if (step.duration != null && step.duration < 20) return true;
  return true;
}

function normalizeInstruction(step: Step | undefined) {
  if (!step?.instruction) return "";

  if (isMinorSlight(step)) {
    return step.name ? `Continuez sur ${step.name}` : "Continuez tout droit";
  }

  const m = (step.modifier || "").toLowerCase();

  if (m.includes("uturn")) return "Faites demi-tour";
  if (m.includes("left")) return step.name ? `Tournez à gauche sur ${step.name}` : "Tournez à gauche";
  if (m.includes("right")) return step.name ? `Tournez à droite sur ${step.name}` : "Tournez à droite";

  if ((m.includes("slight") || m.includes("bear") || m.includes("keep")) && isRampLike(step)) {
    const dir = m.includes("left") ? "à gauche" : m.includes("right") ? "à droite" : "";
    if (step.name) return dir ? `Prenez la bretelle ${dir} vers ${step.name}` : `Prenez la bretelle vers ${step.name}`;
    return dir ? `Prenez la bretelle ${dir}` : "Prenez la bretelle";
  }

  return step.name ? `Continuez sur ${step.name}` : "Continuez tout droit";
}

function maneuverArrow(mod?: string) {
  const m = (mod || "").toLowerCase();
  if (m.includes("uturn")) return "⤴️";
  if (m.includes("left")) return "⬅️";
  if (m.includes("right")) return "➡️";
  return "⬆️";
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

  // Trace officielle (trajet habituel)
  const [officialLine, setOfficialLine] = useState<[number, number][]>([]);
  const [hasOfficial, setHasOfficial] = useState(false);

  // Route Mapbox (guidage texte)
  const [routeLine, setRouteLine] = useState<[number, number][]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [stepIdx, setStepIdx] = useState(0);

  // Off-route + reroute anti-stress (texte)
  const [offRouteM, setOffRouteM] = useState<number | null>(null);
  const offRouteStrikeRef = useRef(0);
  const lastRerouteAtRef = useRef(0);

  const { supported: wlSupported, active: wlActive } = useWakeLock(running);

  // ✅ annonces : 1 seule fois
  const spokenStepRef = useRef<number | null>(null); // step annoncé une seule fois
  const stopWarnRef = useRef<number | null>(null); // annonce 150/200 une seule fois
  const stopWarnMaxRef = useRef<number | null>(null); // 150 ou 200 figé pour l’arrêt courant

  // ✅ ding 10m avant arrêt (une seule fois)
  const stopDingRef = useRef<number | null>(null);

  // Bandeau arrêt scolaire (UI) — max figé + distance monotone
  const [stopBanner, setStopBanner] = useState<{ show: boolean; meters: number; label?: string | null; max: number }>({
    show: false,
    meters: 0,
    label: null,
    max: 150,
  });
  const stopBannerLastMRef = useRef<number | null>(null);

  // bearing fallback (optionnel)
  const lastMeForBearingRef = useRef<{ lat: number; lng: number } | null>(null);
  const bearingRef = useRef<number | null>(null);

  // Cache route Mapbox
  const routeCacheRef = useRef(new Map<string, { line: [number, number][]; steps: Step[]; at: number }>());
  const routeInFlightRef = useRef<AbortController | null>(null);

  // ====== Tuning ======
  const ARRIVE_STOP_M = 45;

  // 150m si <80 km/h, 200m si >=80 km/h (figé dès entrée dans zone)
  function warnStopMeters() {
    const v = speedRef.current ?? null; // m/s
    const kmh = v != null ? v * 3.6 : 0;
    return kmh >= 80 ? 200 : 150;
  }

  // ✅ une seule annonce de virage : quand on est “près” du manoeuvre
  const TURN_SPEAK_AT_M = 55; // annonce unique ~55m
  const STEP_ADVANCE_M = 14; // passer au step suivant
  const OFF_ROUTE_M = 35;
  const ON_ROUTE_M = 18;

  const DING_AT_M = 10; // ✅ ding 10m avant arrêt

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
    spokenStepRef.current = null;

    setOffRouteM(null);
    offRouteStrikeRef.current = 0;
    lastRerouteAtRef.current = 0;

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
      spokenStepRef.current = null;
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
      spokenStepRef.current = null;

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

    const got = await new Promise<{ lat: number; lng: number; acc?: number | null; heading?: number | null }>((resolve, reject) => {
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
    });

    const initial = { lat: got.lat, lng: got.lng };
    meSmoothRef.current = initial;
    setMe(initial);

    setAcc(got.acc ?? null);
    accRef.current = got.acc ?? null;

    if (got.heading != null && Number.isFinite(got.heading)) bearingRef.current = normDeg(got.heading as number);

    const { pts } = await loadCircuit();

    const firstTarget = pts[0] ?? null;
    if (firstTarget) {
      try {
        await calcRoute(initial, firstTarget);

        // ✅ annonce départ: première instruction tout de suite si dispo (garage/parking)
        const first = (steps?.[0] ?? null) as any;
        // (steps est state, donc pas à jour immédiatement) -> on annonce après calcRoute via un micro-timeout
        setTimeout(() => {
          try {
            // on lit la dernière version de steps via state (sera rendu)
            // on force une annonce courte: "Pour débuter..."
            // (si ça n'existe pas encore, ça ne parlera pas)
          } catch {}
        }, 50);
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

  // ✅ annonce départ (premier step) quand steps arrive (parking/garage)
  const saidStartRef = useRef(false);
  useEffect(() => {
    if (!running) return;
    if (saidStartRef.current) return;
    if (!steps || steps.length === 0) return;

    const s0 = steps[0];
    const phrase = normalizeInstruction(s0);
    if (phrase) {
      saidStartRef.current = true;
      speak(`Pour débuter, ${phrase}.`, { cooldownMs: 800, interrupt: true });
    }
  }, [running, steps, speak]);

  // GPS tracking (avec lissage position)
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

        const hd = p.heading;
        if (hd != null && Number.isFinite(hd)) {
          bearingRef.current = normDeg(hd);
          lastMeForBearingRef.current = raw;
        } else {
          const last = lastMeForBearingRef.current;
          if (last) {
            const moved = haversineMeters(raw, last);
            if (moved >= 10) {
              bearingRef.current = bearingDeg(last, raw);
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

  // ✅ REROUTE ANTI-STRESS (silencieux)
  useEffect(() => {
    if (!running) return;
    if (!me || !target) return;
    if (finished) return;

    const lineForOffRoute = hasOfficial && officialLine.length >= 2 ? officialLine : routeLine.length >= 2 ? routeLine : null;
    if (!lineForOffRoute) return;

    const dLine = minDistanceToPolylineMeters(me, lineForOffRoute);
    setOffRouteM(dLine);

    const a = accRef.current ?? null;
    if (a != null && a > 35) return;

    const v = speedRef.current ?? null;
    if (v != null && v < 1.2) return;

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

    calcRoute(me, target).catch((e: any) => setErr(e?.message ?? "Erreur reroute"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, me, targetIdx, hasOfficial, officialLine, routeLine, finished]);

  // Arrêts + bandeau + annonces + steps
  useEffect(() => {
    if (!running) return;
    if (!me || !target) return;

    const dStop = haversineMeters(me, target);
    const rawMeters = Math.round(dStop);

    // ✅ Détermine 150/200 selon vitesse (FIGÉ dès qu'on entre dans la zone)
    const dynamicMax = warnStopMeters();
    if (stopWarnMaxRef.current == null) stopWarnMaxRef.current = dynamicMax;
    const WARN_STOP_M = stopWarnMaxRef.current ?? dynamicMax;

    // si hors zone : on cache + reset monotone
    if (rawMeters > WARN_STOP_M) {
      if (stopBanner.show) setStopBanner({ show: false, meters: 0, label: null, max: WARN_STOP_M });
      stopBannerLastMRef.current = null;
    }

    // ✅ dans zone : distance monotone (descend seulement) + arrondit 5m
    if (!finished && rawMeters <= WARN_STOP_M && rawMeters > ARRIVE_STOP_M) {
      const prevShown = stopBannerLastMRef.current;
      let shown = prevShown == null ? rawMeters : Math.min(prevShown, rawMeters);
      shown = Math.round(shown / 5) * 5;

      stopBannerLastMRef.current = shown;

      setStopBanner({
        show: true,
        meters: shown,
        label: target.label ?? null,
        max: WARN_STOP_M,
      });
    } else {
      if (stopBanner.show) setStopBanner({ show: false, meters: 0, label: null, max: WARN_STOP_M });
      stopBannerLastMRef.current = null;
    }

    // ✅ Une seule annonce arrêt à 150/200
    if (!finished && rawMeters <= WARN_STOP_M && rawMeters > ARRIVE_STOP_M) {
      if (stopWarnRef.current !== targetIdx) {
        stopWarnRef.current = targetIdx;
        speak(`Ralentissez. Arrêt scolaire dans ${WARN_STOP_M} mètres.`, { cooldownMs: 1500, interrupt: true });
      }
    }

    // ✅ Ding 10m avant l’arrêt (une seule fois)
    if (!finished && rawMeters <= DING_AT_M && rawMeters > 1) {
      if (stopDingRef.current !== targetIdx) {
        stopDingRef.current = targetIdx;
        playDing();
      }
    }

    // ✅ Arrivée arrêt (SANS règle d'arrêt complet)
    if (!finished && dStop <= ARRIVE_STOP_M) {
      setStopBanner({ show: false, meters: 0, label: null, max: WARN_STOP_M });

      const next = targetIdx + 1;
      if (next < points.length) {
        const nextTarget = points[next] ?? null;
        const distNext = nextTarget ? Math.round(haversineMeters(me, nextTarget)) : 0;

        speak(`Arrêt atteint. Prochain embarquement dans ${distNext} mètres.`, { cooldownMs: 1500, interrupt: true });
        setTargetIdx(next);

        // reset pour prochain arrêt
        stopWarnRef.current = null;
        stopWarnMaxRef.current = null;
        stopBannerLastMRef.current = null;
        stopDingRef.current = null;

        // reset step
        spokenStepRef.current = null;

        saidStartRef.current = false; // ✅ re-annonce départ du segment suivant
        if (nextTarget) {
          calcRoute(me, nextTarget).catch((e: any) => setErr(e?.message ?? "Erreur itinéraire"));
        }
      } else {
        speak("Circuit terminé.", { cooldownMs: 1500, interrupt: true });
        setFinished(true);

        stopWarnMaxRef.current = null;
        stopBannerLastMRef.current = null;
        stopDingRef.current = null;
      }
      return;
    }

    // ✅ Instructions Mapbox : UNE SEULE FOIS, au virage, avec filtre "slight"
    if (finished) return;

    const currStep = steps[stepIdx];
    if (!currStep?.location) return;

    const dManeuver = haversineMeters(me, currStep.location);

    // annonce unique à ~55m (pas 3 fois)
    if (dManeuver <= TURN_SPEAK_AT_M) {
      if (spokenStepRef.current !== stepIdx) {
        spokenStepRef.current = stepIdx;

        // ✅ phrase normalisée (pas "légèrement" inutile)
        const phrase = normalizeInstruction(currStep);
        if (phrase) {
          speak(`${phrase} dans ${Math.round(dManeuver)} mètres`, { cooldownMs: 1300, interrupt: true });
        }
      }
    }

    // avance le step
    if (dManeuver <= STEP_ADVANCE_M && stepIdx < steps.length - 1) {
      setStepIdx((i) => i + 1);
    }
  }, [running, me, target, points.length, targetIdx, steps, stepIdx, finished]); // eslint-disable-line

  const nextStep = steps[stepIdx];

  // ✅ NAVIGATION “PLUS GROSSE”
  const NAV = {
    title: 40,
    street: 26,
    dist: 44,
    arrow: 86,
    sub: 28,
    badge: 22,
    gap: 14,
  };

  return (
    <div style={page}>
      <div style={container}>
        <div style={card}>
          <div style={row}>
            <div style={{ flex: 1 }}>
              <h1 style={h1}>Navigation (texte)</h1>
              <div style={muted}>
                {hasOfficial ? <>Trace officielle détectée (hors-trace). Guidage texte Mapbox.</> : <>Guidage texte Mapbox.</>}{" "}
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
            {/* Bandeau Waze-like + barre progression (MAX figé 150/200) */}
            {stopBanner.show &&
              (() => {
                const MAX = Number.isFinite(stopBanner.max) ? stopBanner.max : 150;
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
                      boxShadow: pulse ? "0 0 0 4px rgba(239,68,68,.35), 0 8px 22px rgba(0,0,0,.18)" : "0 8px 22px rgba(0,0,0,.18)",
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
                        <div style={{ fontSize: 12, opacity: 0.85 }}>{stopBanner.label ?? "Zone d’embarquement / débarquement"}</div>
                      </div>
                    </div>

                    <div style={{ height: 10, borderRadius: 999, background: "rgba(0,0,0,.2)", overflow: "hidden" }}>
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
              })()}

            {/* ✅ Affichage “conduite” PLUS GROS */}
            <div style={{ display: "grid", gap: NAV.gap, paddingTop: 78 }}>
              <div style={{ fontWeight: 950, fontSize: NAV.badge }}>
                Prochain arrêt : {targetIdx + 1} / {points.length}
              </div>

              <div style={{ ...muted, fontSize: NAV.street }}>{target?.label ? target.label : "—"}</div>

              {me && target && (
                <div style={{ fontSize: NAV.dist, fontWeight: 950, letterSpacing: -0.5 }}>
                  {Math.round(haversineMeters(me, target))} m
                </div>
              )}

              <div style={{ height: 6 }} />

              <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
                <div style={{ fontSize: NAV.arrow, lineHeight: `${NAV.arrow}px` }}>{maneuverArrow(nextStep?.modifier)}</div>

                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 980, fontSize: NAV.title, lineHeight: "44px" }}>
                    {finished ? "✅ Circuit terminé" : nextStep ? normalizeInstruction(nextStep) : "…"}
                  </div>

                  {!finished && nextStep?.name && (
                    <div style={{ fontSize: NAV.street, opacity: 0.8, marginTop: 10 }}>
                      <b>{nextStep.name}</b>
                    </div>
                  )}

                  {!finished && me && nextStep?.location && (
                    <div style={{ fontSize: NAV.sub, opacity: 0.85, marginTop: 12 }}>
                      dans <b>{Math.round(haversineMeters(me, nextStep.location))} m</b>
                    </div>
                  )}
                </div>
              </div>

              {err && <div style={{ color: "#b91c1c", fontWeight: 950, fontSize: 18 }}>{err}</div>}

              {offRouteM != null && (
                <div style={{ ...muted, marginTop: 6, fontSize: 18 }}>
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
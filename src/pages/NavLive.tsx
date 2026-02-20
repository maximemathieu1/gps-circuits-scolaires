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
  name?: string;
  instruction: string;
  type?: string;
  modifier?: string;
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
   Audio / Speech
========================= */

const speechUnlockedRef = { current: false };
const speechCooldownRef = { current: 0 };
const lastSpokenTextRef = { current: "" };

async function unlockAudioAndSpeech() {
  try {
    const AC = (window.AudioContext || (window as any).webkitAudioContext) as any;
    if (AC) {
      const ctx = new AC();
      try {
        if (ctx.state === "suspended") await ctx.resume();
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        g.gain.value = 0.00001;
        o.connect(g);
        g.connect(ctx.destination);
        o.start();
        o.stop(ctx.currentTime + 0.02);
        o.onended = () => {
          try {
            ctx.close?.();
          } catch {}
        };
      } catch {
        try {
          ctx.close?.();
        } catch {}
      }
    }
  } catch {}

  try {
    window.speechSynthesis.getVoices();
  } catch {}

  speechUnlockedRef.current = true;
}

/** Voix robuste + anti-empilement */
function speak(text: string, opts?: { interrupt?: boolean; minGapMs?: number }) {
  try {
    const t = (text ?? "").trim();
    if (!t) return;
    if (!speechUnlockedRef.current) return;

    const now = Date.now();
    const minGap = opts?.minGapMs ?? 2500;

    if (t === lastSpokenTextRef.current && now - speechCooldownRef.current < minGap) return;
    if (now - speechCooldownRef.current < minGap) return;

    if (opts?.interrupt) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    } else {
      try {
        if (window.speechSynthesis.speaking) return;
      } catch {}
    }

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

    speechCooldownRef.current = now;
    lastSpokenTextRef.current = t;

    window.speechSynthesis.speak(u);
  } catch {}
}

/** Ding court (WebAudio) */
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

/* =========================
   Simple “direction générale”
========================= */

function headingToArrow(deltaDeg: number) {
  const d = deltaDeg;
  if (Math.abs(d) <= 18) return { arrow: "⬆️", text: "Continue tout droit" };
  if (d > 18 && d <= 55) return { arrow: "↗️", text: "Légèrement à droite" };
  if (d < -18 && d >= -55) return { arrow: "↖️", text: "Légèrement à gauche" };
  if (d > 55) return { arrow: "➡️", text: "Tourne à droite" };
  return { arrow: "⬅️", text: "Tourne à gauche" };
}

function deltaBearingDeg(fromDeg: number, toDeg: number) {
  let d = normDeg(toDeg) - normDeg(fromDeg);
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/* =========================
   Main
========================= */

export default function NavLive() {
  const q = useQuery();
  const nav = useNavigate();

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

  // Trace officielle (trajet habituel) — pour “hors trace”
  const [officialLine, setOfficialLine] = useState<[number, number][]>([]);
  const [hasOfficial, setHasOfficial] = useState(false);

  // Off-route
  const [offRouteM, setOffRouteM] = useState<number | null>(null);

  const { supported: wlSupported, active: wlActive } = useWakeLock(running);

  // Stop alerts (1 seule annonce + ding 10m)
  const stopWarnRef = useRef<number | null>(null);
  const stopWarnMaxRef = useRef<number | null>(null); // 150/200 figé
  const stopBannerLastMRef = useRef<number | null>(null); // distance monotone
  const stopDing10Ref = useRef<number | null>(null);

  // Direction (cap)
  const lastRawRef = useRef<{ lat: number; lng: number } | null>(null);
  const bearingMoveRef = useRef<number | null>(null);

  // ✅ Instruction de DÉPART (1ère manœuvre Mapbox seulement)
  const [departStep, setDepartStep] = useState<Step | null>(null);
  const departSpokenRef = useRef(false);
  const departDoneRef = useRef(false);

  // Bandeau arrêt scolaire (UI) — max figé + distance monotone
  const [stopBanner, setStopBanner] = useState<{ show: boolean; meters: number; label?: string | null; max: number }>({
    show: false,
    meters: 0,
    label: null,
    max: 150,
  });

  // ====== Tuning ======
  const ARRIVE_STOP_M = 45;

  function warnStopMeters() {
    const v = speedRef.current ?? null; // m/s
    const kmh = v != null ? v * 3.6 : 0;
    return kmh >= 80 ? 200 : 150;
  }

  const OFF_ROUTE_M = 35;
  const ON_ROUTE_M = 18;

  // quand on commence à rouler
  const START_SPEAK_KMH = 5;
  // si on s’approche de la manœuvre
  const DEPART_SAY_WITHIN_M = 220;
  // quand on a dépassé la manœuvre
  const DEPART_DONE_WITHIN_M = 18;

  // Warmup voix iOS
  useEffect(() => {
    try {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
    } catch {}
  }, []);

  async function loadCircuit(): Promise<{ initialTarget: { lat: number; lng: number } | null }> {
    if (!circuitId) throw new Error("Circuit manquant.");

    const r = await callFn<PointsResp>("circuits-api", { action: "get_active_points", circuit_id: circuitId });
    const pts = r.points.map((p) => ({ lat: p.lat, lng: p.lng, label: p.label ?? null }));
    if (pts.length === 0) throw new Error("Ce circuit n’a aucun arrêt enregistré.");

    setPoints(pts);
    setTargetIdx(0);

    setOffRouteM(null);

    stopWarnRef.current = null;
    stopWarnMaxRef.current = null;
    stopBannerLastMRef.current = null;
    stopDing10Ref.current = null;
    setStopBanner({ show: false, meters: 0, label: null, max: 150 });

    // reset départ
    setDepartStep(null);
    departSpokenRef.current = false;
    departDoneRef.current = false;

    setFinished(false);

    // trace officielle optionnelle
    try {
      const tr = await callFn<TraceResp>("circuits-api", { action: "get_latest_trace", circuit_id: circuitId });
      const line: [number, number][] = (tr.trail ?? []).map((p) => [p.lat, p.lng]);
      if (line.length >= 2) {
        setOfficialLine(line);
        setHasOfficial(true);
      } else {
        setOfficialLine([]);
        setHasOfficial(false);
      }
    } catch {
      setOfficialLine([]);
      setHasOfficial(false);
    }

    return { initialTarget: pts[0] ? { lat: pts[0].lat, lng: pts[0].lng } : null };
  }

  async function calcDepartureStep(from: { lat: number; lng: number }, to: { lat: number; lng: number }) {
    try {
      const r = await callFn<{ steps: Step[] }>("nav-api", { action: "route", from, to });
      const steps = r.steps ?? [];
      const first = steps.find((s) => s?.instruction && s?.location) ?? null;
      setDepartStep(first);
    } catch {
      setDepartStep(null);
    }
  }

  async function start() {
    setErr(null);

    if (!circuitId) {
      alert("Circuit manquant. Reviens au portail.");
      return;
    }

    await unlockAudioAndSpeech();

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

    lastRawRef.current = initial;
    bearingMoveRef.current = null;

    const { initialTarget } = await loadCircuit();

    // ✅ calc 1ère manœuvre (départ) seulement
    if (initialTarget) {
      await calcDepartureStep(initial, initialTarget);
    }

    setRunning(true);
    speak("Navigation démarrée.", { interrupt: true, minGapMs: 800 });
  }

  function stop() {
    setRunning(false);
    try {
      window.speechSynthesis.cancel();
    } catch {}
  }

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

        // bearing “mouvement” basé sur 2 positions
        const last = lastRawRef.current;
        if (last) {
          const moved = haversineMeters(last, raw);
          if (moved >= 6) {
            bearingMoveRef.current = bearingDeg(last, raw);
            lastRawRef.current = raw;
          }
        } else {
          lastRawRef.current = raw;
        }
      },
      (m) => setErr(m)
    );

    return () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    };
  }, [running]);

  // Off-route (sur trace officielle si dispo)
  useEffect(() => {
    if (!running) return;
    if (!me) return;

    if (hasOfficial && officialLine.length >= 2) {
      const d = minDistanceToPolylineMeters(me, officialLine);
      setOffRouteM(d);
    } else {
      setOffRouteM(null);
    }
  }, [running, me, hasOfficial, officialLine]);

  // ✅ Instruction de départ : annonce UNE fois quand on commence à rouler + proche de la manœuvre
  useEffect(() => {
    if (!running) return;
    if (finished) return;
    if (!me) return;
    if (!departStep) return;
    if (departDoneRef.current) return;

    const v = speedRef.current ?? null;
    const kmh = v != null ? v * 3.6 : 0;
    if (kmh < START_SPEAK_KMH) return;

    const d = haversineMeters(me, departStep.location);

    // parler une seule fois quand on est raisonnablement proche
    if (!departSpokenRef.current && d <= DEPART_SAY_WITHIN_M) {
      departSpokenRef.current = true;

      const street = (departStep.name ?? "").trim();
      const base = departStep.instruction.trim();
      const txt = street && !base.toLowerCase().includes(street.toLowerCase())
        ? `${base} sur ${street}.`
        : `${base}.`;

      speak(`Départ. ${txt}`, { interrupt: false, minGapMs: 2200 });
    }

    // considérer “fait” quand on arrive à la manœuvre
    if (d <= DEPART_DONE_WITHIN_M) {
      departDoneRef.current = true;
      setDepartStep(null);
    }
  }, [running, finished, me, departStep]);

  // Arrêts + bandeau + annonces (1 seule annonce + ding 10m)
  useEffect(() => {
    if (!running) return;
    if (!me || !target) return;

    const dStop = haversineMeters(me, target);
    const rawMeters = Math.round(dStop);

    // max 150/200 figé pour l’arrêt courant
    const dynamicMax = warnStopMeters();
    if (stopWarnMaxRef.current == null) stopWarnMaxRef.current = dynamicMax;
    const WARN_STOP_M = stopWarnMaxRef.current ?? dynamicMax;

    // hors zone => reset monotone
    if (rawMeters > WARN_STOP_M) {
      if (stopBanner.show) setStopBanner({ show: false, meters: 0, label: null, max: WARN_STOP_M });
      stopBannerLastMRef.current = null;
      stopDing10Ref.current = null;
    }

    // bandeau monotone + arrondi 5m
    if (!finished && rawMeters <= WARN_STOP_M && rawMeters > ARRIVE_STOP_M) {
      const prevShown = stopBannerLastMRef.current;
      let shown = prevShown == null ? rawMeters : Math.min(prevShown, rawMeters);
      shown = Math.round(shown / 5) * 5;

      stopBannerLastMRef.current = shown;
      setStopBanner({ show: true, meters: shown, label: target.label ?? null, max: WARN_STOP_M });
    } else {
      if (stopBanner.show) setStopBanner({ show: false, meters: 0, label: null, max: WARN_STOP_M });
      stopBannerLastMRef.current = null;
    }

    // ✅ une seule annonce d’approche (150/200)
    if (!finished && rawMeters <= WARN_STOP_M && rawMeters > ARRIVE_STOP_M) {
      if (stopWarnRef.current !== targetIdx) {
        stopWarnRef.current = targetIdx;
        speak(`Ralentissez. Arrêt scolaire dans ${WARN_STOP_M} mètres.`, { interrupt: true, minGapMs: 1800 });
      }
    }

    // ✅ ding 10m avant l’arrêt
    if (!finished && rawMeters <= 10 && rawMeters > 0) {
      if (stopDing10Ref.current !== targetIdx) {
        stopDing10Ref.current = targetIdx;
        playDing();
      }
    }

    // arrivée arrêt => enchaîne
    if (!finished && dStop <= ARRIVE_STOP_M) {
      const next = targetIdx + 1;

      if (next < points.length) {
        const nextTarget = points[next] ?? null;
        const distNext = nextTarget ? Math.round(haversineMeters(me, nextTarget)) : 0;

        speak(`Arrêt atteint. Prochain embarquement dans ${distNext} mètres.`, { interrupt: true, minGapMs: 1800 });

        setTargetIdx(next);

        stopWarnRef.current = null;
        stopWarnMaxRef.current = null;
        stopBannerLastMRef.current = null;
        stopDing10Ref.current = null;
        setStopBanner({ show: false, meters: 0, label: null, max: warnStopMeters() });

        // reset départ (si jamais on veut une instruction de départ pour le prochain segment -> NON)
        // on ne recalcule PAS de steps, on reste simple.
      } else {
        speak("Circuit terminé.", { interrupt: true, minGapMs: 1800 });
        setFinished(true);

        stopWarnMaxRef.current = null;
        stopBannerLastMRef.current = null;
        stopDing10Ref.current = null;
        setStopBanner({ show: false, meters: 0, label: null, max: warnStopMeters() });
      }
    }
  }, [running, me, target, targetIdx, points.length, finished, stopBanner.show]);

  // Direction générale vers le prochain arrêt (cap réel)
  const guidance = useMemo(() => {
    if (!me || !target) return { arrow: "⬆️", text: "…" };

    // si on a une instruction de départ active, on l’affiche en priorité
    if (departStep && !departDoneRef.current) {
      const base = (departStep.instruction ?? "").trim();
      const street = (departStep.name ?? "").trim();
      const txt = street && base && !base.toLowerCase().includes(street.toLowerCase())
        ? `${base} sur ${street}`
        : base || "Départ…";
      return { arrow: "🧭", text: `Départ: ${txt}` };
    }

    const move = bearingMoveRef.current;
    const to = bearingDeg(me, target);

    if (move == null) return { arrow: "⬆️", text: "Avance doucement vers le prochain arrêt" };

    const delta = deltaBearingDeg(move, to);
    return headingToArrow(delta);
  }, [me, target, targetIdx, departStep]);

  return (
    <div style={page}>
      <div style={container}>
        <div style={card}>
          <div style={row}>
            <div style={{ flex: 1 }}>
              <h1 style={h1}>Navigation (simple + départ)</h1>
              <div style={muted}>
                {hasOfficial ? <>Trace officielle détectée (hors-trace).</> : <>Mode simple (pas de route calculée).</>}{" "}
                {wlSupported ? `Écran allumé: ${wlActive ? "Oui" : "Non"}` : ""}
              </div>
              {acc != null && <div style={muted}>Précision GPS: ~{Math.round(acc)} m</div>}
              {speed != null && <div style={muted}>Vitesse: ~{Math.round(speed * 3.6)} km/h</div>}
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

            {/* Affichage conduite */}
            <div style={{ display: "grid", gap: 10, paddingTop: 70 }}>
              <div style={{ fontWeight: 900 }}>
                Prochain arrêt : {targetIdx + 1} / {points.length}
              </div>
              <div style={muted}>{target?.label ? target.label : "—"}</div>

              {me && target && (
                <div style={{ fontSize: 40, fontWeight: 950, letterSpacing: -0.5 }}>
                  {Math.round(haversineMeters(me, target))} m
                </div>
              )}

              <div style={{ height: 6 }} />

              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{ fontSize: 54, lineHeight: "54px" }}>{guidance.arrow}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 950, fontSize: 28, lineHeight: "32px" }}>
                    {finished ? "✅ Circuit terminé" : guidance.text}
                  </div>

                  {!finished && offRouteM != null && hasOfficial && (
                    <div style={{ fontSize: 18, opacity: 0.75, marginTop: 6 }}>
                      Hors-trace: <b>{Math.round(offRouteM)} m</b>
                      {offRouteM > OFF_ROUTE_M ? " (revenir vers la trace)" : ""}
                    </div>
                  )}
                </div>
              </div>

              {err && <div style={{ color: "#b91c1c", fontWeight: 900, fontSize: 16 }}>{err}</div>}

              {!hasOfficial && (
                <div style={{ ...muted, marginTop: 6 }}>
                  Astuce: enregistre une trace officielle pour une navigation “hors-trace” plus fiable.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
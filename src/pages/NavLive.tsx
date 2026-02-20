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
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
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

// Approx meters using equirectangular projection around current latitude
function projectMeters(originLat: number, p: { lat: number; lng: number }) {
  const R = 6371000; // meters
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
        transform: rotate(${d}deg);
        transform-origin: 50% 60%;
      "></div>
    `,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

/* =========================
   Map helpers components
========================= */

function FollowMe({ me, follow }: { me: { lat: number; lng: number } | null; follow: boolean }) {
  const map = useMap();
  const lastRef = useRef<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    if (!follow || !me) return;

    const last = lastRef.current;
    if (last) {
      const moved = haversineMeters(me, last);
      if (moved < 8) return; // anti-jitter
    }

    lastRef.current = me;
    map.setView([me.lat, me.lng], map.getZoom(), { animate: true });
  }, [me, follow, map]);

  return null;
}

function RotateMap({ enabled, bearingDeg }: { enabled: boolean; bearingDeg: number | null }) {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();
    const pane = container.querySelector(".leaflet-map-pane") as HTMLElement | null;
    if (!pane) return;

    if (!enabled || bearingDeg == null) {
      pane.style.transformOrigin = "";
      pane.style.transform = "";
      return;
    }

    const rot = -normDeg(bearingDeg);
    pane.style.transformOrigin = "50% 50%";
    pane.style.transform = `rotate(${rot}deg)`;
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
  const [acc, setAcc] = useState<number | null>(null);
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

  const lastSpokenRef = useRef<{ stepIdx: number; stage: "far" | "near" | "now" } | null>(null);

  // Pour bearing fallback
  const lastMeForBearingRef = useRef<{ lat: number; lng: number } | null>(null);

  const ARRIVE_STOP_M = 50;
  const SAY_FAR_M = 250;
  const SAY_NEAR_M = 60;
  const SAY_NOW_M = 20;

  // Warmup voix iOS
  useEffect(() => {
    try {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
    } catch {
      // ignore
    }
  }, []);

  async function loadCircuit() {
    if (!circuitId) throw new Error("Circuit manquant.");

    // 1) Arrêts (source pour annonces)
    const r = await callFn<PointsResp>("circuits-api", { action: "get_active_points", circuit_id: circuitId });
    const pts = r.points.map((p) => ({ lat: p.lat, lng: p.lng, label: p.label ?? null }));
    if (pts.length === 0) throw new Error("Ce circuit n’a aucun arrêt enregistré.");

    setPoints(pts);
    setTargetIdx(0);

    // reset nav hints
    setStepIdx(0);
    setSteps([]);
    setRouteLine([]);
    lastSpokenRef.current = null;

    // reset breadcrumb
    setTrail([]);

    // reset offroute
    setOffRouteM(null);
    offRouteStrikeRef.current = 0;
    lastRerouteAtRef.current = 0;

    // reset bearing
    bearingSmoothRef.current = null;
    setBearing(null);
    setBearingSmooth(null);
    lastMeForBearingRef.current = null;

    // 2) Trace officielle (trajet habituel) — optionnel
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
      // Pas de trace -> fallback sur Mapbox routeLine (ancien comportement)
      setOfficialLine([]);
      setHasOfficial(false);
    }
  }

  async function calcRoute(from: { lat: number; lng: number }, to: { lat: number; lng: number }) {
    const r = await callFn<{ geometry: any; steps: Step[] }>("nav-api", { action: "route", from, to });

    const coords: [number, number][] = (r.geometry?.coordinates ?? []).map((c: any) => [c[1], c[0]]);
    setRouteLine(coords);
    setSteps(r.steps ?? []);
    setStepIdx(0);
    lastSpokenRef.current = null;

    const first = (r.steps ?? [])[0];
    if (first?.instruction) speak(first.instruction);
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
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
      );
    });

    setMe({ lat: got.lat, lng: got.lng });
    setAcc(got.acc ?? null);

    if (got.heading != null && Number.isFinite(got.heading)) {
      setBearing(normDeg(got.heading as number));
    }

    await loadCircuit();

    // Si pas de trace officielle, on calcule une première route Mapbox vers le 1er arrêt (comme avant)
    // Si trace officielle, on évite de calculer tout de suite : on attend si hors-route.
    if (!hasOfficial) {
      const firstTarget = points[0] ?? null;
      if (firstTarget) {
        try {
          await calcRoute({ lat: got.lat, lng: got.lng }, firstTarget);
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
    window.speechSynthesis.cancel();
  }

  // GPS tracking
  useEffect(() => {
    if (!running) return;

    let watchId: number | null = null;

    watchId = watchPos(
      (p) => {
        const curr = { lat: p.lat, lng: p.lng };
        setMe(curr);
        setAcc(p.acc ?? null);

        // Breadcrumb (limite la taille)
        setTrail((prev) => {
          const next: [number, number][] = [...prev, [p.lat, p.lng]];
          if (next.length > 1500) next.splice(0, next.length - 1500);
          return next;
        });

        // Bearing
        const hd = p.heading;
        if (hd != null && Number.isFinite(hd)) {
          setBearing(normDeg(hd));
          lastMeForBearingRef.current = curr;
        } else {
          const last = lastMeForBearingRef.current;
          if (last) {
            const moved = haversineMeters(curr, last);
            if (moved >= 8) {
              setBearing(bearingDeg(last, curr));
              lastMeForBearingRef.current = curr;
            }
          } else {
            lastMeForBearingRef.current = curr;
          }
        }
      },
      (m) => setErr(m)
    );

    return () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    };
  }, [running]);

  // Bearing smoothing (low-pass)
  useEffect(() => {
    if (bearing == null) return;

    const prev = bearingSmoothRef.current;
    if (prev == null) {
      bearingSmoothRef.current = bearing;
      setBearingSmooth(bearing);
      return;
    }

    const a = normDeg(prev);
    const b = normDeg(bearing);

    let diff = b - a;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;

    const alpha = 0.18; // stabilité vs réactivité
    const next = normDeg(a + diff * alpha);

    bearingSmoothRef.current = next;
    setBearingSmooth(next);
  }, [bearing]);

  // ✅ REROUTE ANTI-STRESS (hors-route)
  // - Si trace officielle: off-route basé sur officialLine, et reroute Mapbox seulement si tu sors de la trace
  // - Sinon: fallback sur routeLine (ancien)
  useEffect(() => {
    if (!running) return;
    if (!me || !target) return;

    const lineForOffRoute =
      hasOfficial && officialLine.length >= 2 ? officialLine : routeLine.length >= 2 ? routeLine : null;

    if (!lineForOffRoute) return;

    const now = Date.now();

    // Distance à la ligne (OFFICIAL en priorité)
    const dLine = minDistanceToPolylineMeters(me, lineForOffRoute);
    setOffRouteM(dLine);

    // Seuils
    const OFF_ROUTE_M = 35;
    const ON_ROUTE_M = 18; // hystérésis (pour éviter oscillation)
    const isOff = dLine != null && dLine > OFF_ROUTE_M;

    if (isOff) offRouteStrikeRef.current += 1;
    else if (dLine != null && dLine < ON_ROUTE_M) offRouteStrikeRef.current = 0;

    // Cooldown anti-spam API
    const COOLDOWN_MS = 4500;
    if (now - lastRerouteAtRef.current < COOLDOWN_MS) return;

    // Si on a une trace officielle: on reroute seulement sur "hors-trace"
    // Si pas de trace: on reroute aussi si "off-route" (comme avant)
    const needHelp = offRouteStrikeRef.current >= 2;

    if (!needHelp) return;

    lastRerouteAtRef.current = now;
    offRouteStrikeRef.current = 0;

    speak("Recalcul de l’itinéraire.");
    calcRoute(me, target).catch((e) => setErr(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, me, targetIdx, hasOfficial, officialLine, routeLine]);

  // Arrêts + annonces (inchangé)
  useEffect(() => {
    if (!running) return;
    if (!me || !target) return;

    const dStop = haversineMeters(me, target);

    if (dStop <= ARRIVE_STOP_M) {
      const next = targetIdx + 1;
      if (next < points.length) {
        speak("Arrêt atteint. Prochain arrêt.");
        setTargetIdx(next);

        // si pas de trace officielle, recalcul normal vers prochain arrêt
        if (!hasOfficial) {
          const nextTarget = points[next] ?? null;
          if (nextTarget) calcRoute(me, nextTarget).catch((e) => setErr(e.message));
        }
      } else {
        speak("Circuit terminé.");
        stop();
      }
      return;
    }

    // Instructions Mapbox (si routeLine a été calculée, ex: hors-trace ou fallback)
    const currStep = steps[stepIdx];
    if (!currStep?.location) return;

    const dManeuver = haversineMeters(me, currStep.location);

    let stage: "far" | "near" | "now" | null = null;
    if (dManeuver <= SAY_NOW_M) stage = "now";
    else if (dManeuver <= SAY_NEAR_M) stage = "near";
    else if (dManeuver <= SAY_FAR_M) stage = "far";

    if (stage) {
      const last = lastSpokenRef.current;
      const already = last && last.stepIdx === stepIdx && last.stage === stage;
      if (!already) {
        lastSpokenRef.current = { stepIdx, stage };
        if (stage === "far") speak(`Dans ${Math.round(dManeuver)} mètres, ${currStep.instruction}`);
        else if (stage === "near") speak(`${currStep.instruction} dans ${Math.round(dManeuver)} mètres`);
        else speak(currStep.instruction);
      }
    }

    if (dManeuver <= 12 && stepIdx < steps.length - 1) {
      setStepIdx((i) => i + 1);
      lastSpokenRef.current = null;
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
                    Trajet officiel : <b>ligne bleue</b> (conducteur habituel). Mapbox sert juste si tu t’éloignes.
                  </>
                ) : (
                  <>
                    Mode fallback : itinéraire calculé par Mapbox (pas de trajet officiel enregistré).
                  </>
                )}{" "}
                {wlSupported ? `Écran allumé: ${wlActive ? "Oui" : "Non"}` : ""}
              </div>
              {acc != null && <div style={muted}>Précision GPS: ~{Math.round(acc)} m</div>}
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
              onClick={() => speak("Test de navigation. La voix fonctionne.")}
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
                    {offRouteM > 35 ? " (aide auto…)" : ""}
                  </div>
                )}

                <div style={{ height: 4 }} />

                {/* Instruction (s'affiche seulement quand routeLine/steps existent : hors-trace ou fallback) */}
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
                    onClick={() => speak("Test de navigation. La voix fonctionne.")}
                  >
                    Test voix
                  </button>
                </div>

                <button
                  style={{ ...bigBtn, background: "#fff", color: "#111827", border: "1px solid #e5e7eb" }}
                  onClick={stop}
                >
                  Arrêter
                </button>
              </div>
            </div>

            <div style={{ ...card, padding: 10 }}>
              <div style={{ height: 460, borderRadius: 14, overflow: "hidden" }}>
                <MapContainer center={center} zoom={16} style={{ height: "100%", width: "100%" }}>
                  <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

                  <FollowMe me={me} follow={follow} />
                  <RotateMap enabled={rotateMap} bearingDeg={bearingSmooth} />

                  {/* Breadcrumb (trajet réel) - discret */}
                  {trail.length >= 2 && (
                    <Polyline
                      positions={trail}
                      pathOptions={{
                        color: "#8ab4f8",
                        weight: 4,
                        opacity: 0.55,
                        lineCap: "round",
                        lineJoin: "round",
                      }}
                    />
                  )}

                  {/* ✅ Trace officielle (priorité visuelle) */}
                  {hasOfficial && officialLine.length > 0 && (
                    <>
                      <Polyline
                        positions={officialLine}
                        pathOptions={{
                          color: "#ffffff",
                          weight: 12,
                          opacity: 0.92,
                          lineCap: "round",
                          lineJoin: "round",
                        }}
                      />
                      <Polyline
                        positions={officialLine}
                        pathOptions={{
                          color: "#1A73E8",
                          weight: 7,
                          opacity: 0.95,
                          lineCap: "round",
                          lineJoin: "round",
                        }}
                      />
                    </>
                  )}

                  {/* Route Mapbox (aide / retour) — affichée seulement si calculée */}
                  {routeLine.length > 0 && (
                    <>
                      <Polyline
                        positions={routeLine}
                        pathOptions={{
                          color: "#ffffff",
                          weight: 10,
                          opacity: 0.75,
                          lineCap: "round",
                          lineJoin: "round",
                        }}
                      />
                      <Polyline
                        positions={routeLine}
                        pathOptions={{
                          color: "#1A73E8",
                          weight: 6,
                          opacity: 0.75,
                          lineCap: "round",
                          lineJoin: "round",
                        }}
                      />
                    </>
                  )}

                  {/* Moi (point) + flèche direction */}
                  {me && <Marker position={[me.lat, me.lng]} icon={meIcon} />}
                  {me && bearingSmooth != null && <Marker position={[me.lat, me.lng]} icon={headingIcon(bearingSmooth)} />}

                  {/* Target (prochain arrêt) */}
                  {target && <Marker position={[target.lat, target.lng]} />}
                </MapContainer>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
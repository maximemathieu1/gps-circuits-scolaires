import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { MapContainer, Polyline, TileLayer, Marker } from "react-leaflet";
import L from "leaflet";

import { callFn } from "@/lib/api";
import { haversineMeters } from "@/lib/geo";
import { useWakeLock } from "@/lib/useWakeLock";
import { page, container, card, h1, muted, row, btn, bigBtn } from "@/ui";

type Step = {
  distance: number;
  duration: number;
  name: string;
  instruction: string;
  type: string;
  modifier: string;
  location: { lat: number; lng: number };
};

type PointsResp = { version_id: string; points: { idx: number; lat: number; lng: number; label?: string | null }[] };

function useQuery() {
  const { search } = useLocation();
  return useMemo(() => new URLSearchParams(search), [search]);
}

function watchPos(onPos: (p: { lat: number; lng: number }) => void, onErr: (m: string) => void) {
  return navigator.geolocation.watchPosition(
    (pos) => onPos({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
    (err) => onErr(err.message),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
  );
}

function speak(text: string) {
  try {
    if (!text?.trim()) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "fr-CA";
    u.rate = 1.0;
    window.speechSynthesis.speak(u);
  } catch {
    // ignore
  }
}

const meIcon = new L.DivIcon({
  className: "",
  html: `<div style="width:14px;height:14px;border-radius:999px;background:#2F6FDB;border:3px solid #fff;box-shadow:0 2px 10px rgba(0,0,0,.25)"></div>`,
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

export default function NavLive() {
  const q = useQuery();
  const nav = useNavigate();

  const circuitId = q.get("circuit") || "";

  const [running, setRunning] = useState(false);

  const [points, setPoints] = useState<{ lat: number; lng: number; label?: string | null }[]>([]);
  const [targetIdx, setTargetIdx] = useState(0);
  const target = points[targetIdx] ?? null;

  const [me, setMe] = useState<{ lat: number; lng: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [routeLine, setRouteLine] = useState<[number, number][]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [stepIdx, setStepIdx] = useState(0);

  const { supported: wlSupported, active: wlActive } = useWakeLock(running);

  const lastSpokenRef = useRef<{ stepIdx: number; stage: "far" | "near" | "now" } | null>(null);

  const ARRIVE_STOP_M = 50;
  const SAY_FAR_M = 250;
  const SAY_NEAR_M = 60;
  const SAY_NOW_M = 20;

  async function loadCircuit() {
    if (!circuitId) throw new Error("Circuit manquant.");
    const r = await callFn<PointsResp>("circuits-api", { action: "get_active_points", circuit_id: circuitId });
    const pts = r.points.map((p) => ({ lat: p.lat, lng: p.lng, label: p.label ?? null }));
    if (pts.length === 0) throw new Error("Ce circuit n’a aucun arrêt enregistré.");
    setPoints(pts);
    setTargetIdx(0);
    setStepIdx(0);
    setSteps([]);
    setRouteLine([]);
  }

  async function calcRoute(from: { lat: number; lng: number }, to: { lat: number; lng: number }) {
    const r = await callFn<{ geometry: any; steps: Step[] }>("nav-api", {
      action: "route",
      from,
      to,
    });

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

    // Une position initiale aide beaucoup
    const got = await new Promise<{ lat: number; lng: number }>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        (e) => reject(new Error(e.message)),
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
      );
    });

    setMe(got);
    await loadCircuit();
    setRunning(true);
  }

  function stop() {
    setRunning(false);
    window.speechSynthesis.cancel();
  }

  useEffect(() => {
    if (!running) return;

    let watchId: number | null = null;

    watchId = watchPos(
      (p) => setMe(p),
      (m) => setErr(m)
    );

    return () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    };
  }, [running]);

  useEffect(() => {
    if (!running) return;
    if (!me || !target) return;

    calcRoute(me, target).catch((e) => setErr(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, targetIdx]);

  useEffect(() => {
    if (!running) return;
    if (!me || !target) return;

    const dStop = haversineMeters(me, target);
    if (dStop <= ARRIVE_STOP_M) {
      const next = targetIdx + 1;
      if (next < points.length) {
        speak("Arrêt atteint. Prochain arrêt.");
        setTargetIdx(next);
      } else {
        speak("Circuit terminé.");
        stop();
      }
      return;
    }

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
  }, [running, me, target, points.length, targetIdx, steps, stepIdx]);

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
                Virages annoncés + auto-progression.{" "}
                {wlSupported ? `Écran allumé: ${wlActive ? "Oui" : "Non"}` : ""}
              </div>
            </div>
            <button style={btn("ghost")} onClick={() => nav("/")}>Retour</button>
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
          <>
            <div style={card}>
              <div style={{ display: "grid", gap: 6 }}>
                <div style={{ fontWeight: 900 }}>
                  Prochain arrêt : {targetIdx + 1} / {points.length}
                </div>
                <div style={muted}>{target?.label ? target.label : "—"}</div>

                {me && target && (
                  <div style={muted}>
                    Distance arrêt : <b>{Math.round(haversineMeters(me, target))} m</b>
                  </div>
                )}

                <div style={{ height: 6 }} />

                <div style={{ fontWeight: 900 }}>Instruction</div>
                <div style={muted}>{nextStep?.instruction ? nextStep.instruction : "Calcul en cours…"}</div>

                {me && nextStep?.location && (
                  <div style={muted}>
                    Distance virage : <b>{Math.round(haversineMeters(me, nextStep.location))} m</b>
                  </div>
                )}

                {err && <div style={{ color: "#b91c1c", fontWeight: 800 }}>{err}</div>}

                <div style={{ height: 6 }} />
                <button
                  style={{ ...bigBtn, background: "#fff", color: "#111827", border: "1px solid #e5e7eb" }}
                  onClick={stop}
                >
                  Arrêter
                </button>
              </div>
            </div>

            <div style={{ ...card, padding: 10 }}>
              <div style={{ height: 420, borderRadius: 14, overflow: "hidden" }}>
                <MapContainer center={center} zoom={14} style={{ height: "100%", width: "100%" }}>
                  <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                  {routeLine.length > 0 && <Polyline positions={routeLine} />}
                  {me && <Marker position={[me.lat, me.lng]} icon={meIcon} />}
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

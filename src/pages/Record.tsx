// src/pages/Record.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { callFn } from "@/lib/api";
import { supabase } from "@/lib/supabaseClient";
import { page, container, card, h1, muted, row, btn, select, input } from "@/ui";

type TCode = "B" | "C" | "S";
type Circuit = { id: string; nom: string };
type Point = { idx: number; lat: number; lng: number; label: string | null; created_at?: string };
type SaveTraceResp = { ok: true; version_id: string; points_saved: number };

function useQuery() {
  const { search } = useLocation();
  return useMemo(() => new URLSearchParams(search), [search]);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getPos(): Promise<{ lat: number; lng: number; accuracy?: number }> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(new Error(e.message)),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    );
  });
}

function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);

  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos(la1) * Math.cos(la2) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const LS_T = "gps_record_transporteur";
const LS_C = "gps_record_circuit";

export default function Record() {
  const q = useQuery();
  const nav = useNavigate();

  const canGeo = typeof navigator !== "undefined" && "geolocation" in navigator;

  const [transporteur, setTransporteur] = useState<TCode>(
    (q.get("t") as TCode) || (localStorage.getItem(LS_T) as TCode) || "B"
  );

  const [circuits, setCircuits] = useState<Circuit[]>([]);
  const [selectedCircuit, setSelectedCircuit] = useState<string>(q.get("circuit") || localStorage.getItem(LS_C) || "");

  // Écran départ : 2 choix
  const [step, setStep] = useState<"pick" | "new" | "update">("pick");

  // Nouveau
  const [newNom, setNewNom] = useState("");

  // session
  const [recording, setRecording] = useState(false);
  const [versionId, setVersionId] = useState<string | null>(null);

  // ARRÊTS
  const [points, setPoints] = useState<Point[]>([]);

  // TRACE (moteur conservé)
  const [trace, setTrace] = useState<[number, number][]>([]);
  const [tracePaused, setTracePaused] = useState(false);
  const [savingTrace, setSavingTrace] = useState(false);

  // GPS
  const [gpsOk, setGpsOk] = useState<boolean | null>(null);
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  // auth
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  // Throttle trace
  const lastTracePointRef = useRef<{ lat: number; lng: number } | null>(null);
  const lastTraceAtRef = useRef<number>(0);

  const TRACE_MIN_METERS = 8;
  const TRACE_MIN_MS = 1200;
  const TRACE_MAX_POINTS = 12000;

  async function refreshAuth() {
    try {
      const { data, error } = await supabase.auth.getUser();
      if (error) {
        setAuthed(false);
        setUserId(null);
        return;
      }
      const u = data?.user ?? null;
      setAuthed(Boolean(u));
      setUserId(u?.id ?? null);
    } catch {
      setAuthed(false);
      setUserId(null);
    }
  }

  async function requireAuth(): Promise<string> {
    const { data, error } = await supabase.auth.getUser();
    const u = data?.user ?? null;

    if (error || !u?.id) {
      setAuthed(false);
      setUserId(null);
      alert("Tu dois être connecté pour créer / modifier un circuit.");
      throw new Error("NOT_AUTHENTICATED");
    }

    setAuthed(true);
    setUserId(u.id);
    return u.id;
  }

  async function loadCircuits() {
    const r = await callFn<{ circuits: Circuit[] }>("circuits-api", {
      action: "list_circuits",
      transporteur_code: transporteur,
    });
    setCircuits(r.circuits ?? []);
    setSelectedCircuit((prev) => {
      const keep = prev && r.circuits?.some((x) => x.id === prev);
      return keep ? prev : r.circuits?.[0]?.id ?? "";
    });
  }

  async function loadPointsByVersion(vId: string) {
    const r = await callFn<{ points: Point[] }>("circuits-api", { action: "get_points_by_version", version_id: vId });
    setPoints(r.points ?? []);
  }

  useEffect(() => {
    localStorage.setItem(LS_T, transporteur);
    loadCircuits().catch((e) => alert(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transporteur]);

  useEffect(() => {
    if (selectedCircuit) localStorage.setItem(LS_C, selectedCircuit);
  }, [selectedCircuit]);

  useEffect(() => {
    refreshAuth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function checkGps() {
      if (!canGeo) {
        setGpsOk(false);
        return;
      }
      try {
        const p = await getPos();
        if (cancelled) return;
        setGpsOk(true);
        setGpsAccuracy(typeof p.accuracy === "number" ? Math.round(p.accuracy) : null);
      } catch {
        if (cancelled) return;
        setGpsOk(false);
      }
    }

    checkGps();
    return () => {
      cancelled = true;
    };
  }, [canGeo]);

  // WATCH GPS pendant enregistrement : construit TRACE
  useEffect(() => {
    if (!recording) return;
    if (!canGeo) return;

    let cancelled = false;
    let watchId: number | null = null;

    try {
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          if (cancelled) return;

          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;
          const acc = pos.coords.accuracy;

          if (typeof acc === "number") setGpsAccuracy(Math.round(acc));
          setGpsOk(true);

          if (tracePaused) return;

          const now = Date.now();
          if (now - lastTraceAtRef.current < TRACE_MIN_MS) return;

          const curr = { lat, lng };
          const last = lastTracePointRef.current;

          if (last) {
            const moved = haversineMeters(curr, last);
            if (moved < TRACE_MIN_METERS) return;
          }

          lastTraceAtRef.current = now;
          lastTracePointRef.current = curr;

          setTrace((prev) => {
            const next: [number, number][] = [...prev, [lat, lng]];
            if (next.length > TRACE_MAX_POINTS) next.splice(0, next.length - TRACE_MAX_POINTS);
            return next;
          });
        },
        (err) => {
          if (cancelled) return;
          setGpsOk(false);
          console.warn("GPS watch error:", err?.message);
        },
        { enableHighAccuracy: true, maximumAge: 500, timeout: 15000 }
      );
    } catch (e) {
      console.warn("watchPosition failed:", e);
    }

    return () => {
      cancelled = true;
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    };
  }, [recording, tracePaused, canGeo]);

  function resetSessionForStart() {
    setRecording(true);
    setPoints([]);
    setTrace([]);
    setTracePaused(false);
    lastTracePointRef.current = null;
    lastTraceAtRef.current = 0;
  }

  async function startNew() {
    const nom = newNom.trim();
    if (!nom) return;

    setBusy(true);
    try {
      const uid = await requireAuth();

      if (canGeo) {
        const p = await getPos();
        setGpsOk(true);
        setGpsAccuracy(typeof p.accuracy === "number" ? Math.round(p.accuracy) : null);
      }

      const r = await callFn<{ circuit_id: string; version_id: string }>("circuits-api", {
        action: "create_circuit",
        transporteur_code: transporteur,
        nom,
        created_by: uid,
        user_id: uid,
      });

      setSelectedCircuit(r.circuit_id);
      setVersionId(r.version_id);
      resetSessionForStart();

      setNewNom("");
      await loadCircuits();
    } catch (e: any) {
      if (e?.message !== "NOT_AUTHENTICATED") alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function startUpdate() {
    if (!selectedCircuit) return;

    setBusy(true);
    try {
      await requireAuth();

      if (canGeo) {
        const p = await getPos();
        setGpsOk(true);
        setGpsAccuracy(typeof p.accuracy === "number" ? Math.round(p.accuracy) : null);
      }

      const r = await callFn<{ version_id: string; version_no: number }>("circuits-api", {
        action: "start_update",
        circuit_id: selectedCircuit,
        note: "Mise à jour",
      });

      setVersionId(r.version_id);
      resetSessionForStart();
    } catch (e: any) {
      if (e?.message !== "NOT_AUTHENTICATED") alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  // ✅ Ajout arrêt: plus de prompt de commentaire (label = null)
  async function addStop() {
    if (!versionId) return;

    setBusy(true);
    try {
      await requireAuth();

      const pos = await getPos();
      setGpsOk(true);
      setGpsAccuracy(typeof pos.accuracy === "number" ? Math.round(pos.accuracy) : null);

      if (typeof pos.accuracy === "number" && pos.accuracy > 45) {
        const ok = confirm(`GPS imprécis (± ${Math.round(pos.accuracy)} m). Ajouter l’arrêt quand même ?`);
        if (!ok) return;
      }

      await callFn("circuits-api", {
        action: "add_point",
        version_id: versionId,
        lat: pos.lat,
        lng: pos.lng,
        label: null,
      });

      await sleep(80);
      await loadPointsByVersion(versionId);

      const curr = { lat: pos.lat, lng: pos.lng };
      lastTracePointRef.current = curr;
      lastTraceAtRef.current = Date.now();
      setTrace((prev) => {
        const next: [number, number][] = [...prev, [pos.lat, pos.lng]];
        if (next.length > TRACE_MAX_POINTS) next.splice(0, next.length - TRACE_MAX_POINTS);
        return next;
      });
    } catch (e: any) {
      if (e?.message !== "NOT_AUTHENTICATED") alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setRecording(false);
    setVersionId(null);
    setPoints([]);
    setTrace([]);
    setTracePaused(false);
    lastTracePointRef.current = null;
    lastTraceAtRef.current = 0;

    nav("/");
  }

  // --- Styles (même vibe que remplacant)
  const softShadow = "0 10px 30px rgba(17,24,39,.08)";
  const ring = "0 0 0 6px rgba(59,130,246,.10)";

  const circleBase: React.CSSProperties = {
    borderRadius: 999,
    display: "grid",
    placeItems: "center",
    border: "1px solid #e5e7eb",
    background: "#fff",
    cursor: "pointer",
    boxShadow: softShadow,
    userSelect: "none",
  };

  const circlePrimary: React.CSSProperties = {
    ...circleBase,
    width: 136,
    height: 136,
    border: "1px solid rgba(37,99,235,.25)",
    background: "linear-gradient(180deg, #2563eb 0%, #1d4ed8 100%)",
    color: "#fff",
    boxShadow: `${softShadow}, ${ring}`,
  };

  const circleWarn: React.CSSProperties = {
    ...circleBase,
    width: 136,
    height: 136,
    border: "1px solid rgba(245,158,11,.25)",
    background: "linear-gradient(180deg, #fff7ed 0%, #ffedd5 100%)",
    color: "#7c2d12",
  };

  const circleGood: React.CSSProperties = {
    ...circleBase,
    width: 136,
    height: 136,
    border: "1px solid rgba(16,185,129,.25)",
    background: "linear-gradient(180deg, #10b981 0%, #059669 100%)",
    color: "#fff",
    boxShadow: softShadow,
  };

  const disabledStyle: React.CSSProperties = {
    opacity: 0.45,
    cursor: "not-allowed",
    boxShadow: "none",
  };

  const canStartNew = !busy && Boolean(newNom.trim());
  const canStartUpdate = !busy && Boolean(selectedCircuit);

  const headerCardStyle: React.CSSProperties = { ...card, padding: "12px 14px" };

  return (
    <div style={page}>
      <div style={container}>
        {/* Header minimal: Retour à gauche seulement */}
        {!recording && step === "pick" && (
  <div style={headerCardStyle}>
    <div style={{ display: "flex", justifyContent: "flex-start" }}>
      <button style={btn("ghost")} onClick={() => nav("/")}>
        Retour
      </button>
    </div>
  </div>
)}

        {/* ENREGISTREMENT */}
        {recording ? (
          <>
            <div style={card}>
              <div style={{ display: "grid", gap: 10, justifyItems: "center" }}>
                <div style={{ ...muted, textAlign: "center" }}>
                  Arrêts : <b>{points.length}</b> · GPS :{" "}
                  <b>{gpsOk === null ? "…" : gpsOk ? `OK (± ${gpsAccuracy ?? "?"} m)` : "bloqué"}</b>
                </div>

                <div style={{ display: "flex", gap: 18, flexWrap: "wrap", justifyContent: "center" }}>
                  <button style={{ ...circleGood, ...(busy ? disabledStyle : {}) }} onClick={addStop} disabled={busy}>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontWeight: 1000, fontSize: 18, lineHeight: 1 }}>ARRÊT</div>
                      <div style={{ fontWeight: 950, fontSize: 13, marginTop: 6 }}>ENREGISTRER</div>
                    </div>
                  </button>

                  <button style={{ ...circleWarn, ...(busy ? disabledStyle : {}) }} onClick={stop} disabled={busy}>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontWeight: 1000, fontSize: 18, lineHeight: 1 }}>STOP</div>
                      <div style={{ fontWeight: 950, fontSize: 13, marginTop: 6 }}>TERMINER</div>
                    </div>
                  </button>
                </div>
              </div>
            </div>

            {/* Liste des arrêts (discrète) */}
            <div style={card}>
              <div style={{ fontWeight: 900, marginBottom: 8 }}>Arrêts</div>
              {points.length === 0 ? (
                <div style={muted}>—</div>
              ) : (
                <div style={{ display: "grid", gap: 8 }}>
                  {points.map((p) => (
                    <div
                      key={p.idx}
                      style={{
                        display: "flex",
                        gap: 10,
                        alignItems: "baseline",
                        padding: "10px 12px",
                        border: "1px solid #e5e7eb",
                        borderRadius: 12,
                      }}
                    >
                      <div style={{ width: 42, fontWeight: 900 }}>{p.idx}</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 800 }}>Arrêt</div>
                        <div style={muted}>
                          {p.lat.toFixed(6)}, {p.lng.toFixed(6)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            {/* DÉPART */}
            {step === "pick" ? (
              <div style={card}>
                <div style={{ display: "grid", gap: 12, justifyItems: "center" }}>
                  <div style={{ display: "flex", gap: 18, flexWrap: "wrap", justifyContent: "center" }}>
                    <button style={circlePrimary} onClick={() => setStep("new")} title="Nouveau circuit">
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontWeight: 1000, fontSize: 18, lineHeight: 1 }}>NOUVEAU</div>
                        <div style={{ fontWeight: 950, fontSize: 13, opacity: 0.92, marginTop: 6 }}>CIRCUIT</div>
                      </div>
                    </button>

                    <button style={circleWarn} onClick={() => setStep("update")} title="Mettre à jour">
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontWeight: 1000, fontSize: 18, lineHeight: 1 }}>METTRE</div>
                        <div style={{ fontWeight: 950, fontSize: 13, marginTop: 6 }}>À JOUR</div>
                      </div>
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div style={card}>
                <div style={{ display: "grid", gap: 12 }}>
                  <div>
                    <div style={{ ...muted, marginBottom: 6 }}>Transporteur</div>
                    <select
                      style={select}
                      value={transporteur}
                      onChange={(e) => setTransporteur(e.target.value as TCode)}
                      disabled={busy}
                    >
                      <option value="B">Breton</option>
                      <option value="C">Champagne</option>
                      <option value="S">Sécuritaire</option>
                    </select>
                  </div>

                  {step === "new" ? (
                    <>
                      <div>
                        <div style={{ ...muted, marginBottom: 6 }}>Nom du circuit</div>
                        <input
                          style={input}
                          value={newNom}
                          onChange={(e) => setNewNom(e.target.value)}
                          placeholder="Ex: Circuit matin – St-Joseph"
                          disabled={busy}
                        />
                      </div>

                      <div style={{ display: "flex", justifyContent: "center", paddingTop: 6 }}>
                        <button
                          style={{ ...circlePrimary, ...(canStartNew ? {} : disabledStyle) }}
                          onClick={startNew}
                          disabled={!canStartNew}
                          title="Démarrer"
                        >
                          <div style={{ textAlign: "center" }}>
                            <div style={{ fontWeight: 1000, fontSize: 20, lineHeight: 1 }}>DÉMARRER</div>
                            <div style={{ fontWeight: 950, fontSize: 13, opacity: 0.92, marginTop: 6 }}>NOUVEAU</div>
                          </div>
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <div style={{ ...muted, marginBottom: 6 }}>Circuit</div>
                        <select
                          style={select}
                          value={selectedCircuit}
                          onChange={(e) => setSelectedCircuit(e.target.value)}
                          disabled={busy}
                        >
                          <option value="">— Choisir —</option>
                          {circuits.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.nom}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div style={{ display: "flex", justifyContent: "center", paddingTop: 6 }}>
                        <button
                          style={{ ...circlePrimary, ...(canStartUpdate ? {} : disabledStyle) }}
                          onClick={startUpdate}
                          disabled={!canStartUpdate}
                          title="Démarrer"
                        >
                          <div style={{ textAlign: "center" }}>
                            <div style={{ fontWeight: 1000, fontSize: 20, lineHeight: 1 }}>DÉMARRER</div>
                            <div style={{ fontWeight: 950, fontSize: 13, opacity: 0.92, marginTop: 6 }}>
                              MISE À JOUR
                            </div>
                          </div>
                        </button>
                      </div>
                    </>
                  )}

                  <div style={{ ...muted, textAlign: "center" }}>
                    GPS : {gpsOk === null ? "…" : gpsOk ? `OK (± ${gpsAccuracy ?? "?"} m)` : "bloqué"}
                  </div>

                  {/* Retour à gauche seulement (pas de rafraîchir) */}
                  <div style={{ marginTop: 10 }}>
                    <button
                      style={btn("ghost")}
                      onClick={() => {
                        setStep("pick");
                        setNewNom("");
                      }}
                      disabled={busy}
                    >
                      Retour
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
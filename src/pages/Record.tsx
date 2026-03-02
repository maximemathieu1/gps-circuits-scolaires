// src/pages/Record.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { callFn } from "@/lib/api";
import { supabase } from "@/lib/supabaseClient";
import { page, container, card, muted, btn, select, input } from "@/ui";

type TCode = "B" | "C" | "S";
type Circuit = { id: string; nom: string };
type Point = { idx: number; lat: number; lng: number; label: string | null; created_at?: string };

// ✅ réponse souple (ça évite de “casser” si ton API retourne un shape légèrement différent)
type SaveTraceResp = { ok?: boolean; version_id?: string; points_saved?: number };

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

  // ✅ NEW: état sauvegarde trace
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

  // ✅ KEEP SCREEN AWAKE (Wake Lock)
  const wakeLockRef = useRef<any>(null);

  async function requestWakeLock() {
    try {
      const navAny = navigator as any;
      if (!navAny?.wakeLock?.request) return; // pas supporté (souvent iOS Safari)
      wakeLockRef.current = await navAny.wakeLock.request("screen");
    } catch {
      // silence
    }
  }

  async function releaseWakeLock() {
    try {
      await wakeLockRef.current?.release?.();
    } catch {
      // silence
    }
    wakeLockRef.current = null;
  }

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

  // ✅ Empêche l'écran de se mettre en veille pendant l'enregistrement
  useEffect(() => {
    if (!recording) {
      releaseWakeLock();
      return;
    }

    let cancelled = false;

    const onVis = async () => {
      if (cancelled) return;
      if (document.visibilityState === "visible" && recording) {
        await requestWakeLock();
      }
    };

    (async () => {
      await requestWakeLock();
    })();

    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
      releaseWakeLock();
    };
  }, [recording]);

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

  // ✅ NEW: Sauvegarder la trace (circuit_traces) avant de quitter
  async function saveTraceIfAny(vId: string) {
    if (!vId) return;
    if (!trace || trace.length < 2) return; // évite trail inutile

    // format attendu: [{idx,lat,lng}, ...]
    const trail = trace.map(([lat, lng], i) => ({ idx: i + 1, lat, lng }));

    // retry léger (mobile / réseau)
    let lastErr: any = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await callFn<SaveTraceResp>("circuits-api", {
          action: "save_trace",
          version_id: vId,
          trail,
          points_count: trail.length,
        });

        if (r?.ok) return;
        if ((r as any)?.ok === true) return;

        throw new Error("save_trace: réponse invalide");
      } catch (e: any) {
        lastErr = e;
        await sleep(300 * attempt);
      }
    }

    throw lastErr ?? new Error("save_trace failed");
  }

  async function stop() {
    await releaseWakeLock(); // ✅ coupe le wake lock tout de suite

    const vId = versionId; // ✅ capture avant reset

    // ✅ on tente de sauvegarder la trace AVANT de quitter
    if (vId && !savingTrace) {
      setSavingTrace(true);
      try {
        await requireAuth();
        await saveTraceIfAny(vId);
      } catch (e: any) {
        const ok = confirm(
          `Impossible de sauvegarder la trace (réseau / permissions).\n\n` +
            `Voulez-vous quitter quand même ?\n\n` +
            `Détail: ${e?.message ?? e}`
        );
        if (!ok) {
          setSavingTrace(false);
          // ✅ redemande wake lock si on reste dans l'écran
          await requestWakeLock();
          return;
        }
      } finally {
        setSavingTrace(false);
      }
    }

    setRecording(false);
    setVersionId(null);
    setPoints([]);
    setTrace([]);
    setTracePaused(false);
    lastTracePointRef.current = null;
    lastTraceAtRef.current = 0;

    nav("/");
  }

  // =========================
  // LOOK (aligné Portal)
  // =========================
  const pageLook: React.CSSProperties = {
    minHeight: "100vh",
    width: "100%",
    padding: "clamp(14px, 3.5vw, 28px)",
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
    background:
      "radial-gradient(circle at 1px 1px, rgba(59,130,246,.10) 1px, rgba(0,0,0,0) 1px) 0 0 / 14px 14px," +
      "radial-gradient(130% 70% at 50% 35%, rgba(59,130,246,.18) 0%, rgba(59,130,246,0) 60%)," +
      "linear-gradient(180deg, #f7fafc 0%, #eef2f7 62%, #f7fafc 100%)",
    display: "grid",
    placeItems: "center",
    boxSizing: "border-box",
  };

  const wrap: React.CSSProperties = { width: "min(620px, 100%)" };

  const mainCard: React.CSSProperties = {
    boxSizing: "border-box",
    borderRadius: 34,
    background: "rgba(255,255,255,.90)",
    border: "1px solid rgba(2,6,23,.06)",
    boxShadow: "0 26px 80px rgba(2,6,23,.16)",
    backdropFilter: "blur(10px)",
    padding: "clamp(16px, 2.8vw, 22px)",
    overflow: "hidden",
    position: "relative",
  };

  const topRow: React.CSSProperties = {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 14,
  };

  const brand: React.CSSProperties = { minWidth: 0 };
  const brandName: React.CSSProperties = {
    margin: 0,
    fontWeight: 950,
    fontSize: 18,
    letterSpacing: -0.3,
    color: "#0f172a",
    lineHeight: 1.1,
  };
  const brandSub: React.CSSProperties = {
    marginTop: 4,
    fontSize: 12.5,
    fontWeight: 800,
    color: "rgba(15,23,42,.62)",
  };

  const sectionCard: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    borderRadius: 28,
    padding: "clamp(16px, 2.6vw, 20px)",
    background: "linear-gradient(180deg, rgba(255,255,255,.94) 0%, rgba(255,255,255,.78) 100%)",
    border: "1px solid rgba(2,6,23,.06)",
    boxShadow: "0 14px 40px rgba(2,6,23,.10)",
    marginTop: 14,
  };

  const actionBase: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    borderRadius: 28,
    padding: "clamp(16px, 2.6vw, 20px)",
    border: "1px solid rgba(255,255,255,.18)",
    boxShadow: "0 20px 60px rgba(2,6,23,.18)",
    color: "#fff",
    cursor: "pointer",
    position: "relative",
    overflow: "hidden",
    minHeight: 98,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 14,
  };

  const overlay: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    background:
      "radial-gradient(140% 140% at 88% 20%, rgba(255,255,255,.20) 0%, rgba(255,255,255,0) 55%)," +
      "radial-gradient(140% 140% at 25% 95%, rgba(255,255,255,.14) 0%, rgba(255,255,255,0) 62%)," +
      "radial-gradient(130% 150% at 92% 92%, rgba(255,255,255,.18) 0%, rgba(255,255,255,0) 62%)",
    pointerEvents: "none",
  };

  const leftText: React.CSSProperties = { minWidth: 0, flex: "1 1 auto", position: "relative", zIndex: 1 };
  const rightPill: React.CSSProperties = {
    flex: "0 0 auto",
    position: "relative",
    zIndex: 1,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "10px 14px",
    borderRadius: 999,
    background: "rgba(255,255,255,.14)",
    border: "1px solid rgba(255,255,255,.18)",
    fontWeight: 950,
    whiteSpace: "nowrap",
  };

  const rightPillLight: React.CSSProperties = {
    flex: "0 0 auto",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "10px 14px",
    borderRadius: 999,
    background: "rgba(124,45,18,.10)",
    border: "1px solid rgba(124,45,18,.18)",
    fontWeight: 950,
    whiteSpace: "nowrap",
    color: "rgba(124,45,18,.85)",
  };

  const disabledAction: React.CSSProperties = { opacity: 0.55, cursor: "not-allowed", boxShadow: "none" };

  const actionBlue: React.CSSProperties = {
    ...actionBase,
    background: "linear-gradient(135deg, #1e40af 0%, #2f6fdb 50%, #1d4ed8 100%)",
  };

  const actionGreen: React.CSSProperties = {
    ...actionBase,
    background: "linear-gradient(135deg, #047857 0%, #10b981 55%, #059669 100%)",
  };

  const actionRed: React.CSSProperties = {
    ...actionBase,
    background: "linear-gradient(135deg, #7f1d1d 0%, #ef4444 55%, #dc2626 100%)",
  };

  const actionLightRow: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    borderRadius: 28,
    padding: "clamp(16px, 2.6vw, 20px)",
    background: "linear-gradient(135deg, #fde68a 0%, #ffedd5 45%, #ffffff 100%)",
    border: "1px solid rgba(2,6,23,.06)",
    boxShadow: "0 14px 40px rgba(2,6,23,.10)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 14,
    cursor: "pointer",
    minHeight: 86,
  };

  const warnTitle: React.CSSProperties = { fontWeight: 950, fontSize: 18, color: "#7c2d12", letterSpacing: -0.2 };
  const warnSub: React.CSSProperties = { marginTop: 6, fontWeight: 750, color: "rgba(124,45,18,.70)" };

  const statusLine: React.CSSProperties = {
    textAlign: "center",
    fontWeight: 900,
    fontSize: 13,
    color: "rgba(15,23,42,.68)",
  };

  const canStartNew = !busy && Boolean(newNom.trim());
  const canStartUpdate = !busy && Boolean(selectedCircuit);

  return (
    <div style={pageLook}>
      <div style={wrap}>
        <div style={mainCard}>
          {/* Entête (même vibe Portal) */}
          <div style={topRow}>
            <div style={brand}>
              <p style={brandName}>Groupe Breton</p>
              <div style={brandSub}>Espace conducteur</div>
            </div>

            {/* Retour en haut à droite (comme tu montrais) */}
            {!recording ? (
              <button
                type="button"
                style={{ ...btn("ghost"), paddingInline: 16, borderRadius: 14 }}
                onClick={() => {
                  if (step === "pick") nav("/");
                  else {
                    setStep("pick");
                    setNewNom("");
                  }
                }}
                disabled={busy}
              >
                Retour
              </button>
            ) : null}
          </div>

          {/* ENREGISTREMENT */}
          {recording ? (
            <>
              <div style={{ ...sectionCard, marginTop: 0 }}>
                <div style={{ display: "grid", gap: 14 }}>
                  <div style={statusLine}>
                    Arrêts : <b>{points.length}</b> · Trace : <b>{trace.length}</b> points · GPS :{" "}
                    <b>{gpsOk === null ? "…" : gpsOk ? `OK (± ${gpsAccuracy ?? "?"} m)` : "bloqué"}</b>
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gap: 14,
                    }}
                  >
                    {/* ARRÊT */}
                    <div
                      style={{ ...actionGreen, ...(busy || savingTrace ? disabledAction : {}) }}
                      onClick={busy || savingTrace ? undefined : addStop}
                      role="button"
                      aria-disabled={busy || savingTrace}
                      title="Enregistrer un arrêt"
                    >
                      <div style={overlay} />
                      <div style={leftText}>
                        <div style={{ fontWeight: 950, fontSize: 22, letterSpacing: -0.2 }}>ARRÊT</div>
                        <div style={{ marginTop: 6, fontWeight: 750, opacity: 0.9 }}>Enregistrer la position</div>
                      </div>
                      <div style={rightPill}>Ouvrir ›</div>
                    </div>

                    {/* STOP */}
                    <div
                      style={{ ...actionRed, ...(busy || savingTrace ? disabledAction : {}) }}
                      onClick={busy || savingTrace ? undefined : stop}
                      role="button"
                      aria-disabled={busy || savingTrace}
                      title="Terminer"
                    >
                      <div style={overlay} />
                      <div style={leftText}>
                        <div style={{ fontWeight: 950, fontSize: 22, letterSpacing: -0.2 }}>
                          {savingTrace ? "STOP…" : "STOP"}
                        </div>
                        <div style={{ marginTop: 6, fontWeight: 750, opacity: 0.9 }}>
                          {savingTrace ? "Sauvegarde en cours" : "Terminer la session"}
                        </div>
                      </div>
                      <div style={rightPill}>{savingTrace ? "…" : "Ouvrir ›"}</div>
                    </div>

                    {savingTrace ? <div style={{ ...muted, textAlign: "center" }}>Sauvegarde de la trace…</div> : null}
                  </div>
                </div>
              </div>

              {/* Liste des arrêts (discrète) */}
              <div style={sectionCard}>
                <div style={{ fontWeight: 950, marginBottom: 10, color: "#0f172a" }}>Arrêts</div>
                {points.length === 0 ? (
                  <div style={muted}>—</div>
                ) : (
                  <div style={{ display: "grid", gap: 10 }}>
                    {points.map((p) => (
                      <div
                        key={p.idx}
                        style={{
                          display: "flex",
                          gap: 10,
                          alignItems: "baseline",
                          padding: "12px 14px",
                          border: "1px solid rgba(2,6,23,.08)",
                          borderRadius: 16,
                          background: "rgba(255,255,255,.75)",
                        }}
                      >
                        <div style={{ width: 42, fontWeight: 950, color: "rgba(15,23,42,.85)" }}>{p.idx}</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 900, color: "#0f172a" }}>Arrêt</div>
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
                <div style={{ display: "grid", gap: 14 }}>
                  {/* Nouveau */}
                  <div
                    style={actionBlue}
                    onClick={() => setStep("new")}
                    role="button"
                    title="Nouveau circuit"
                    aria-label="Nouveau circuit"
                  >
                    <div style={overlay} />
                    <div style={leftText}>
                      <div style={{ fontWeight: 950, fontSize: 22, letterSpacing: -0.2 }}>NOUVEAU CIRCUIT</div>
                      <div style={{ marginTop: 6, fontWeight: 750, opacity: 0.88 }}>Créer un circuit</div>
                    </div>
                    <div style={rightPill}>Ouvrir ›</div>
                  </div>

                  {/* Mettre à jour */}
                  <div
                    style={actionLightRow}
                    onClick={() => setStep("update")}
                    role="button"
                    title="Mettre à jour"
                    aria-label="Mettre à jour"
                  >
                    <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                      <div style={warnTitle}>METTRE À JOUR</div>
                      <div style={warnSub}>Modifier un circuit existant</div>
                    </div>
                    <div style={rightPillLight}>Ouvrir ›</div>
                  </div>

                  <div style={{ ...muted, textAlign: "center", marginTop: 6 }}>
                    GPS : {gpsOk === null ? "…" : gpsOk ? `OK (± ${gpsAccuracy ?? "?"} m)` : "bloqué"}
                  </div>
                </div>
              ) : (
                <div style={sectionCard}>
                  <div style={{ display: "grid", gap: 12 }}>
                    <div>
                      <div style={{ ...muted, marginBottom: 6, fontWeight: 900 }}>Transporteur</div>
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
                          <div style={{ ...muted, marginBottom: 6, fontWeight: 900 }}>Nom du circuit</div>
                          <input
                            style={input}
                            value={newNom}
                            onChange={(e) => setNewNom(e.target.value)}
                            placeholder="Ex: Circuit matin – St-Joseph"
                            disabled={busy}
                          />
                        </div>

                        <div style={{ display: "grid", gap: 12, marginTop: 6 }}>
                          <button
                            type="button"
                            style={{
                              ...btn("primary"),
                              width: "100%",
                              opacity: canStartNew ? 1 : 0.55,
                              boxSizing: "border-box",
                              borderRadius: 18,
                              padding: "14px 16px",
                              fontWeight: 950,
                            }}
                            onClick={startNew}
                            disabled={!canStartNew}
                          >
                            Démarrer (nouveau)
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div>
                          <div style={{ ...muted, marginBottom: 6, fontWeight: 900 }}>Circuit</div>
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

                        <div style={{ display: "grid", gap: 12, marginTop: 6 }}>
                          <button
                            type="button"
                            style={{
                              ...btn("primary"),
                              width: "100%",
                              opacity: canStartUpdate ? 1 : 0.55,
                              boxSizing: "border-box",
                              borderRadius: 18,
                              padding: "14px 16px",
                              fontWeight: 950,
                            }}
                            onClick={startUpdate}
                            disabled={!canStartUpdate}
                          >
                            Démarrer (mise à jour)
                          </button>
                        </div>
                      </>
                    )}

                    <div style={{ ...muted, textAlign: "center", marginTop: 4 }}>
                      GPS : {gpsOk === null ? "…" : gpsOk ? `OK (± ${gpsAccuracy ?? "?"} m)` : "bloqué"}
                    </div>

                    {/* NOTE: le "Retour" est en haut à droite; on garde quand même un fallback bas */}
                    <div style={{ marginTop: 6 }}>
                      <button
                        type="button"
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
    </div>
  );
}
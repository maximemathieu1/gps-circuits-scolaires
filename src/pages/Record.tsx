// src/pages/Record.tsx
import React, { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { callFn, supabase } from "@/lib/api";
import { page, container, card, h1, muted, row, btn, bigBtn, select, input } from "@/ui";

type TCode = "B" | "C" | "S";
type Circuit = { id: string; nom: string };
type Point = { idx: number; lat: number; lng: number; label: string | null; created_at?: string };

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

const LS_T = "gps_record_transporteur";
const LS_C = "gps_record_circuit";

export default function Record() {
  const q = useQuery();
  const nav = useNavigate();

  const [transporteur, setTransporteur] = useState<TCode>(
    (q.get("t") as TCode) || (localStorage.getItem(LS_T) as TCode) || "B"
  );

  const [circuits, setCircuits] = useState<Circuit[]>([]);
  const [selectedCircuit, setSelectedCircuit] = useState<string>(q.get("circuit") || localStorage.getItem(LS_C) || "");

  const [mode, setMode] = useState<"new" | "update">("new");
  const [newNom, setNewNom] = useState("");

  // session
  const [recording, setRecording] = useState(false);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [gpsOk, setGpsOk] = useState<boolean | null>(null);
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  // auth (pour éviter created_by = null)
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  const canGeo = typeof navigator !== "undefined" && "geolocation" in navigator;

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
      // si tu as une page login, décommente :
      // nav("/login");
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
      return keep ? prev : (r.circuits?.[0]?.id ?? "");
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

  // auth au chargement
  useEffect(() => {
    refreshAuth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // petit “check GPS” au chargement (ça évite une surprise au moment de démarrer)
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

  async function startNew() {
    const nom = newNom.trim();
    if (!nom) return alert("Nom du circuit requis.");

    setBusy(true);
    try {
      const uid = await requireAuth();

      // test GPS (force permission)
      if (canGeo) {
        const p = await getPos();
        setGpsOk(true);
        setGpsAccuracy(typeof p.accuracy === "number" ? Math.round(p.accuracy) : null);
      }

      const r = await callFn<{ circuit_id: string; version_id: string }>("circuits-api", {
        action: "create_circuit",
        transporteur_code: transporteur,
        nom,
        // ✅ IMPORTANT: éviter created_by = null côté DB
        created_by: uid,
        user_id: uid, // (au cas où ta function attend user_id)
      });

      setSelectedCircuit(r.circuit_id);
      setVersionId(r.version_id);
      setRecording(true);
      setPoints([]);
      setNewNom("");

      // refresh liste (optionnel mais pratique)
      await loadCircuits();
    } catch (e: any) {
      if (e?.message !== "NOT_AUTHENTICATED") alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function startUpdate() {
    if (!selectedCircuit) return alert("Choisis un circuit.");

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
      setRecording(true);
      setPoints([]);
    } catch (e: any) {
      if (e?.message !== "NOT_AUTHENTICATED") alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function renameSelected() {
    if (!selectedCircuit) return;

    setBusy(true);
    try {
      await requireAuth();

      const current = circuits.find((c) => c.id === selectedCircuit)?.nom ?? "";
      const nom = (window.prompt("Nouveau nom du circuit :", current) ?? "").trim();
      if (!nom) return;

      await callFn("circuits-api", { action: "rename_circuit", circuit_id: selectedCircuit, nom });
      await loadCircuits();
      alert("Nom mis à jour ✅");
    } catch (e: any) {
      if (e?.message !== "NOT_AUTHENTICATED") alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function addStop() {
    if (!versionId) return;

    setBusy(true);
    try {
      await requireAuth();

      const pos = await getPos();
      setGpsOk(true);
      setGpsAccuracy(typeof pos.accuracy === "number" ? Math.round(pos.accuracy) : null);

      const labelRaw = window.prompt("Nom / note de l’arrêt (optionnel)", "") ?? "";
      const label = labelRaw.trim() ? labelRaw.trim() : null;

      await callFn("circuits-api", {
        action: "add_point",
        version_id: versionId,
        lat: pos.lat,
        lng: pos.lng,
        label,
      });

      await sleep(80);
      await loadPointsByVersion(versionId);
    } catch (e: any) {
      if (e?.message !== "NOT_AUTHENTICATED") alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function undoLast() {
    if (!versionId) return;
    if (!confirm("Annuler le dernier arrêt ?")) return;

    setBusy(true);
    try {
      await requireAuth();

      const r = await callFn<{ ok: boolean; deleted: boolean; idx?: number }>("circuits-api", {
        action: "delete_last_point",
        version_id: versionId,
      });

      if (!r.deleted) alert("Aucun arrêt à annuler.");
      await loadPointsByVersion(versionId);
    } catch (e: any) {
      if (e?.message !== "NOT_AUTHENTICATED") alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  function stop() {
    setRecording(false);
    setVersionId(null);
    setPoints([]);
    alert("Enregistrement terminé ✅");
    nav("/");
  }

  return (
    <div style={page}>
      <div style={container}>
        <div style={card}>
          <div style={row}>
            <div style={{ flex: 1 }}>
              <h1 style={h1}>Mode Enregistrement</h1>
              <div style={muted}>
                À chaque arrêt : clique <b>Ajouter arrêt</b>. GPS requis.
              </div>
              <div style={{ ...muted, marginTop: 6 }}>
                Connexion :{" "}
                {authed === null ? "vérification…" : authed ? `OK (${userId?.slice(0, 8)}…)` : "non connecté"}
              </div>
            </div>
            <button style={btn("ghost")} onClick={() => nav("/")}>
              Retour
            </button>
          </div>
        </div>

        {!recording ? (
          <>
            <div style={card}>
              <div style={{ display: "grid", gap: 10 }}>
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

                <div style={row}>
                  <button
                    style={{ ...btn(mode === "new" ? "primary" : "ghost"), flex: 1 }}
                    onClick={() => setMode("new")}
                    disabled={busy}
                  >
                    Nouveau circuit
                  </button>
                  <button
                    style={{ ...btn(mode === "update" ? "primary" : "ghost"), flex: 1 }}
                    onClick={() => setMode("update")}
                    disabled={busy}
                  >
                    Mettre à jour
                  </button>
                </div>

                {mode === "new" ? (
                  <>
                    <div>
                      <div style={{ ...muted, marginBottom: 6 }}>Nom du nouveau circuit</div>
                      <input
                        style={input}
                        value={newNom}
                        onChange={(e) => setNewNom(e.target.value)}
                        placeholder="Ex: Circuit matin – St-Joseph"
                        disabled={busy}
                      />
                    </div>
                    <button style={bigBtn} onClick={startNew} disabled={busy || !newNom.trim()}>
                      Démarrer
                    </button>
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
                      <div style={{ height: 8 }} />
                      <div style={row}>
                        <button style={btn("ghost")} onClick={renameSelected} disabled={busy || !selectedCircuit}>
                          Renommer
                        </button>
                        <button
                          style={{ ...btn("primary"), flex: 1 }}
                          onClick={startUpdate}
                          disabled={busy || !selectedCircuit}
                        >
                          Démarrer mise à jour
                        </button>
                      </div>
                    </div>
                  </>
                )}

                <div style={{ ...muted, marginTop: 6 }}>
                  GPS : {gpsOk === null ? "vérification…" : gpsOk ? `OK (± ${gpsAccuracy ?? "?"} m)` : "bloqué / refusé"}
                </div>

                {authed === false && (
                  <div style={{ ...muted, border: "1px solid #fee2e2", background: "#fff1f2", padding: 10, borderRadius: 12 }}>
                    ⚠️ Tu n’es pas connecté. La création du circuit échouera (created_by requis).
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <>
            <div style={card}>
              <div style={{ display: "grid", gap: 8 }}>
                <div style={{ fontWeight: 900 }}>Enregistrement en cours</div>
                <div style={muted}>
                  Arrêts enregistrés : <b>{points.length}</b>
                </div>
                <div style={muted}>
                  Précision GPS : <b>{gpsAccuracy !== null ? `± ${gpsAccuracy} m` : "—"}</b>
                </div>

                <div style={{ height: 6 }} />

                <button style={bigBtn} onClick={addStop} disabled={busy}>
                  Ajouter arrêt
                </button>

                <div style={row}>
                  <button style={btn("ghost")} onClick={undoLast} disabled={busy || points.length === 0}>
                    Annuler dernier arrêt
                  </button>
                  <button
                    style={{ ...btn("ghost"), borderColor: "#ef4444", color: "#b91c1c" }}
                    onClick={stop}
                    disabled={busy}
                  >
                    Terminer
                  </button>
                </div>
              </div>
            </div>

            <div style={card}>
              <div style={{ fontWeight: 900, marginBottom: 8 }}>Liste des arrêts</div>

              {points.length === 0 ? (
                <div style={muted}>Aucun arrêt encore. Clique “Ajouter arrêt”.</div>
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
                        <div style={{ fontWeight: 800 }}>{p.label ? p.label : "Arrêt"}</div>
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
        )}
      </div>
    </div>
  );
}

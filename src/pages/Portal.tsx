// src/pages/Portal.tsx
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { callFn } from "@/lib/api";
import { useAuth } from "@/lib/useAuth";

import { page, container, card, h1, muted, row, bigBtn, btn, select, input } from "@/ui";

type TCode = "B" | "C" | "S";
const LABEL: Record<TCode, string> = { B: "Breton", C: "Champagne", S: "Sécuritaire" };

type Circuit = { id: string; nom: string };

export default function Portal() {
  const nav = useNavigate();
  const { ready, isAuthed, user } = useAuth();

  const [transporteur, setTransporteur] = useState<TCode>("B");
  const [circuits, setCircuits] = useState<Circuit[]>([]);
  const [circuitId, setCircuitId] = useState<string>("");

  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState("");

  const selected = useMemo(() => circuits.find((c) => c.id === circuitId) ?? null, [circuits, circuitId]);

  async function load() {
    // portail public: on n'appelle pas l'API si non connecté
    if (!isAuthed) {
      setCircuits([]);
      setCircuitId("");
      return;
    }

    const r = await callFn<{ circuits: Circuit[] }>("circuits-api", {
      action: "list_circuits",
      transporteur_code: transporteur,
    });

    setCircuits(r.circuits || []);
    setCircuitId((prev) => (prev && r.circuits.some((x) => x.id === prev) ? prev : r.circuits?.[0]?.id ?? ""));
  }

  useEffect(() => {
    if (!ready) return;
    load().catch((e) => alert(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transporteur, isAuthed, ready]);

  function goNav() {
    if (!isAuthed) return nav("/login", { state: { redirectTo: "/" } });
    if (!circuitId) return alert("Choisis un circuit.");
    nav(`/nav?circuit=${encodeURIComponent(circuitId)}&t=${transporteur}`);
  }

  function goRecord() {
    if (!isAuthed)
      return nav("/login", {
        state: { redirectTo: "/record?t=" + transporteur + "&circuit=" + encodeURIComponent(circuitId || "") },
      });
    nav(`/record?t=${transporteur}&circuit=${encodeURIComponent(circuitId || "")}`);
  }

  async function doRename() {
    if (!isAuthed) return nav("/login", { state: { redirectTo: "/" } });

    const name = newName.trim();
    if (!selected) return;
    if (!name) return alert("Nom requis.");

    await callFn("circuits-api", { action: "rename_circuit", circuit_id: selected.id, nom: name });
    setRenaming(false);
    setNewName("");
    await load();
  }

  return (
    <div style={page}>
      <div style={container}>
        <div style={card}>
          <h1 style={h1}>GPS – Circuits scolaires</h1>
          <div style={muted}>Choisis le transporteur et le circuit, puis démarre.</div>

          <div style={{ marginTop: 10, ...muted }}>
            Connexion :{" "}
            <b>
              {!ready ? "chargement…" : isAuthed ? `connecté (${user?.email ?? "ok"})` : "non connecté"}
            </b>
          </div>

          {!ready ? null : !isAuthed ? (
            <div style={{ marginTop: 10 }}>
              <button style={btn("primary")} onClick={() => nav("/login", { state: { redirectTo: "/" } })}>
                Se connecter
              </button>
            </div>
          ) : null}
        </div>

        <div style={card}>
          <div style={{ display: "grid", gap: 10 }}>
            <div>
              <div style={{ ...muted, marginBottom: 6 }}>Transporteur</div>
              <select style={select} value={transporteur} onChange={(e) => setTransporteur(e.target.value as TCode)}>
                <option value="B">{LABEL.B}</option>
                <option value="C">{LABEL.C}</option>
                <option value="S">{LABEL.S}</option>
              </select>
            </div>

            <div>
              <div style={{ ...muted, marginBottom: 6 }}>Circuit</div>
              <select style={select} value={circuitId} onChange={(e) => setCircuitId(e.target.value)} disabled={!isAuthed}>
                {!isAuthed ? (
                  <option value="">(connecte-toi pour charger les circuits)</option>
                ) : (
                  circuits.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nom}
                    </option>
                  ))
                )}
              </select>
            </div>

            <div style={row}>
              <button style={{ ...btn("ghost"), flex: 1 }} onClick={() => setRenaming(true)} disabled={!isAuthed || !circuitId}>
                Renommer
              </button>
              <button style={{ ...btn("ghost"), flex: 1 }} onClick={() => load().catch((e) => alert(e.message))} disabled={!isAuthed}>
                Rafraîchir
              </button>
            </div>

            <button style={bigBtn} onClick={goNav} disabled={!isAuthed || !circuitId}>
              Navigation continue (virages + voix)
            </button>

            <button style={{ ...bigBtn, background: "#fff", color: "#111827", border: "1px solid #e5e7eb" }} onClick={goRecord}>
              Enregistrer / Mettre à jour un trajet
            </button>
          </div>
        </div>

        {renaming && (
          <div style={card}>
            <div style={{ fontWeight: 900, marginBottom: 8 }}>Renommer le circuit</div>
            <input
              style={input}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={selected?.nom ?? "Nom"}
              disabled={!isAuthed}
            />
            <div style={{ ...row, marginTop: 10 }}>
              <button style={{ ...btn("primary"), flex: 1 }} onClick={() => doRename().catch((e) => alert(e.message))} disabled={!isAuthed}>
                Enregistrer
              </button>
              <button
                style={{ ...btn("ghost"), flex: 1 }}
                onClick={() => {
                  setRenaming(false);
                  setNewName("");
                }}
              >
                Annuler
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
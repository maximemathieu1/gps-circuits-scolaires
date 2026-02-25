// src/pages/Portal.tsx
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { callFn } from "@/lib/api";
import { useAuth } from "@/lib/useAuth";

import { page, container, card, h1, muted, btn, select } from "@/ui";

type TCode = "B" | "C" | "S";
const LABEL: Record<TCode, string> = { B: "Breton", C: "Champagne", S: "Sécuritaire" };

type Circuit = { id: string; nom: string };

export default function Portal() {
  const nav = useNavigate();
  const { ready, isAuthed, user } = useAuth();

  const [transporteur, setTransporteur] = useState<TCode>("B");
  const [circuits, setCircuits] = useState<Circuit[]>([]);
  const [circuitId, setCircuitId] = useState<string>("");

  // Toggle conducteur (OFF par défaut => mode remplaçant)
  const [showConducteur, setShowConducteur] = useState(false);

  const selected = useMemo(() => circuits.find((c) => c.id === circuitId) ?? null, [circuits, circuitId]);

  async function load() {
    if (!isAuthed) {
      setCircuits([]);
      setCircuitId("");
      return;
    }

    const r = await callFn<{ circuits: Circuit[] }>("circuits-api", {
      action: "list_circuits",
      transporteur_code: transporteur,
    });

    const list = r.circuits || [];
    setCircuits(list);
    setCircuitId((prev) => (prev && list.some((x) => x.id === prev) ? prev : list?.[0]?.id ?? ""));
  }

  useEffect(() => {
    if (!ready) return;
    load().catch((e) => alert(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transporteur, isAuthed, ready]);

  function goLogin(redirectTo: string = "/") {
    nav("/login", { state: { redirectTo } });
  }

  function goNav() {
    if (!isAuthed) return goLogin("/");
    if (!circuitId) return;
    nav(`/nav?circuit=${encodeURIComponent(circuitId)}&t=${transporteur}`);
  }

  function goRecordAuto() {
    const url = `/record?t=${transporteur}&circuit=${encodeURIComponent(circuitId || "")}&auto=1`;
    if (!isAuthed) return goLogin(url);
    nav(url);
  }

  // --- UI styles
  const softShadow = "0 10px 30px rgba(17,24,39,.08)";
  const ring = "0 0 0 6px rgba(59,130,246,.10)";

  const toggleWrap: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "10px 12px",
    border: "1px solid #e5e7eb",
    borderRadius: 14,
    background: "#fff",
  };

  const switchOuter: React.CSSProperties = {
    width: 54,
    height: 32,
    borderRadius: 999,
    border: "1px solid #e5e7eb",
    background: showConducteur ? "#2563eb" : "#cbd5e1",
    position: "relative",
    cursor: "pointer",
    transition: "all .15s ease",
    flex: "0 0 auto",
  };

  const switchKnob: React.CSSProperties = {
    width: 26,
    height: 26,
    borderRadius: 999,
    background: "#fff",
    position: "absolute",
    top: 2,
    left: showConducteur ? 26 : 2,
    transition: "all .15s ease",
    boxShadow: "0 8px 22px rgba(17,24,39,.18)",
  };

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

  const disabledStyle: React.CSSProperties = {
    opacity: 0.45,
    cursor: "not-allowed",
    boxShadow: "none",
  };

  const canUse = ready && isAuthed;
  const hasCircuit = Boolean(circuitId);

  return (
    <div style={page}>
      <div style={container}>
        <div style={card}>
          <h1 style={h1}>GPS – Circuits scolaires</h1>

          <div style={{ marginTop: 10, ...muted }}>
            Connexion :{" "}
            <b>{!ready ? "chargement…" : isAuthed ? `connecté (${user?.email ?? "ok"})` : "non connecté"}</b>
          </div>

          {!ready ? null : !isAuthed ? (
            <div style={{ marginTop: 10 }}>
              <button style={btn("primary")} onClick={() => goLogin("/")}>
                Se connecter
              </button>
            </div>
          ) : null}

          {/* Toggle conducteur => ouvre automatiquement Record */}
          <div style={{ marginTop: 12, ...toggleWrap }}>
            <div style={{ fontWeight: 950 }}>Mode conducteur régulier</div>
            <div
              role="switch"
              aria-checked={showConducteur}
              tabIndex={0}
              style={switchOuter}
              onClick={() => {
                const next = !showConducteur;
                setShowConducteur(next);
                if (next) {
                  // on ouvre record et on laisse le Portal revenir en mode remplaçant au retour
                  goRecordAuto();
                  setTimeout(() => setShowConducteur(false), 0);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  const next = !showConducteur;
                  setShowConducteur(next);
                  if (next) {
                    goRecordAuto();
                    setTimeout(() => setShowConducteur(false), 0);
                  }
                }
              }}
              title="Ouvrir Record"
            >
              <div style={switchKnob} />
            </div>
          </div>
        </div>

        {/* Remplaçant (par défaut) */}
        <div style={card}>
          <div style={{ display: "grid", gap: 12 }}>
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
              <select
                style={select}
                value={circuitId}
                onChange={(e) => setCircuitId(e.target.value)}
                disabled={!canUse}
              >
                {!canUse ? (
                  <option value="">(connexion requise)</option>
                ) : circuits.length ? (
                  circuits.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nom}
                    </option>
                  ))
                ) : (
                  <option value="">(aucun circuit)</option>
                )}
              </select>
            </div>

            <div style={{ display: "flex", justifyContent: "center", paddingTop: 6 }}>
              <button
                style={{ ...circlePrimary, ...(canUse && hasCircuit ? {} : disabledStyle) }}
                onClick={goNav}
                disabled={!canUse || !hasCircuit}
                title="Naviguer"
              >
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontWeight: 1000, fontSize: 22, lineHeight: 1 }}>GPS</div>
                  <div style={{ fontWeight: 950, fontSize: 13, opacity: 0.92, marginTop: 6 }}>NAVIGUER</div>
                </div>
              </button>
            </div>           
          </div>
        </div>
      </div>
    </div>
  );
}
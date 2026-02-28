// src/pages/Portal.tsx
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { callFn } from "@/lib/api";
import { useAuth } from "@/lib/useAuth";

import { page, container, card, h1, muted, btn, select } from "@/ui";

type TCode = "B" | "C" | "S";
const LABEL: Record<TCode, string> = { B: "Breton", C: "Champagne", S: "Sécuritaire" };
type Circuit = { id: string; nom: string };

// ✅ iPhone/iOS audio unlock helper (inline, simple)
async function unlockIOSAudioOnce() {
  // 1) Unlock AudioContext (ding)
  try {
    const AC: any = window.AudioContext || (window as any).webkitAudioContext;
    if (AC) {
      const ctx = new AC();
      if (ctx.state === "suspended") await ctx.resume();

      // tiny beep (very low volume) to "prime" iOS audio
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      g.gain.value = 0.001;
      o.frequency.value = 880;
      o.connect(g);
      g.connect(ctx.destination);
      o.start();

      setTimeout(() => {
        try {
          o.stop();
          ctx.close?.();
        } catch {}
      }, 40);
    }
  } catch {}

  // 2) Prime speechSynthesis (voice)
  try {
    const synth = window.speechSynthesis;
    synth?.getVoices?.();

    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 1.0;
    u.rate = 1.0;
    u.pitch = 1.0;
    window.speechSynthesis.speak(u);

    setTimeout(() => {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }, 80);
  } catch {}
}

export default function Portal() {
  const nav = useNavigate();
  const { ready, isAuthed } = useAuth();

  const [view, setView] = useState<"home" | "gps">("home");

  const [transporteur, setTransporteur] = useState<TCode>("B");
  const [circuits, setCircuits] = useState<Circuit[]>([]);
  const [circuitId, setCircuitId] = useState<string>("");

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
    if (view !== "gps") return;
    load().catch((e: any) => alert(e?.message || "Erreur chargement."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transporteur, isAuthed, ready, view]);

  function goLogin(redirectTo: string = "/") {
    nav("/login", { state: { redirectTo } });
  }

  // ✅ GPS Naviguer = unlock iPhone audio + go nav
  async function goNav() {
    if (!isAuthed) return goLogin("/");
    if (!circuitId) return;

    // iOS: must happen on user tap
    await unlockIOSAudioOnce();

    nav(`/nav?circuit=${encodeURIComponent(circuitId)}&t=${transporteur}`);
  }

  function goRecord() {
    if (!isAuthed) return goLogin("/record");
    nav("/record");
  }

  // --- UI styles (identiques vibe)
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
    width: 150,
    height: 150,
    border: "1px solid rgba(37,99,235,.25)",
    background: "linear-gradient(180deg, #2563eb 0%, #1d4ed8 100%)",
    color: "#fff",
    boxShadow: `${softShadow}, ${ring}`,
  };

  const circleWarn: React.CSSProperties = {
    ...circleBase,
    width: 150,
    height: 150,
    border: "1px solid rgba(245,158,11,.25)",
    background: "linear-gradient(180deg, #fff7ed 0%, #ffedd5 100%)",
    color: "#7c2d12",
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
        {/* HOME: 2 gros boutons */}
        {view === "home" ? (
          <>
            <div style={card}>
              <h1 style={h1}>Espace Conducteur</h1>
              <div style={{ ...muted, marginTop: 4 }}>Navigation & gestion des circuits scolaires</div>
            </div>

            {!ready ? null : !isAuthed ? (
              <div style={card}>
                <button style={btn("primary")} onClick={() => goLogin("/")}>
                  Se connecter
                </button>
              </div>
            ) : null}

            <div style={card}>
              <div style={{ display: "flex", gap: 18, flexWrap: "wrap", justifyContent: "center" }}>
                <button style={circlePrimary} onClick={() => setView("gps")} title="Navigation guidée">
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontWeight: 1000, fontSize: 18, lineHeight: 1 }}>NAVIGATION</div>
                    <div style={{ fontWeight: 950, fontSize: 13, marginTop: 8, opacity: 0.95 }}>GUIDÉE · GPS</div>
                  </div>
                </button>

                <button style={circleWarn} onClick={goRecord} title="Nouveau / Mettre à jour">
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontWeight: 1000, fontSize: 18, lineHeight: 1 }}>NOUVEAU</div>
                    <div style={{ fontWeight: 950, fontSize: 13, marginTop: 8 }}>MISE À JOUR</div>
                  </div>
                </button>
              </div>

              {/* Ligne valorisante */}
              <div
                style={{
                  textAlign: "center",
                  marginTop: 24,
                  fontWeight: 600,
                  fontSize: 15,
                  color: "#374151",
                }}
              >
                Vous transportez plus que des élèves. Vous transportez l’avenir.
              </div>
            </div>
          </>
        ) : (
          /* GPS: écran remplaçant (transporteur + circuit + bouton rond) */
          <>
            <div style={card}>
              <div style={{ display: "flex", justifyContent: "flex-start" }}>
                <button style={btn("ghost")} onClick={() => setView("home")}>
                  Retour
                </button>
              </div>
            </div>

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
                  <select style={select} value={circuitId} onChange={(e) => setCircuitId(e.target.value)} disabled={!canUse}>
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

                <div style={{ ...muted, textAlign: "center" }}>{selected ? selected.nom : ""}</div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
// src/pages/Portal.tsx
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { callFn } from "@/lib/api";
import { useAuth } from "@/lib/useAuth";
import { btn, select } from "@/ui";
import { RefreshCw } from "lucide-react";

type TCode = "B" | "C" | "S";
const LABEL: Record<TCode, string> = { B: "Breton", C: "Champagne", S: "Sécuritaire" };
type Circuit = { id: string; nom: string };

// iOS audio unlock
async function unlockIOSAudioOnce() {
  try {
    const AC: any = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (AC) {
      const ctx = new AC();
      if (ctx.state === "suspended") await ctx.resume();
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

  try {
    const u = new SpeechSynthesisUtterance(" ");
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
  const [circuitId, setCircuitId] = useState("");

  const selected = useMemo(() => circuits.find((c) => c.id === circuitId) ?? null, [circuits, circuitId]);

  const canUse = ready && isAuthed;
  const hasCircuit = Boolean(circuitId);

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
  }, [transporteur, isAuthed, ready, view]);

  function goLogin(redirectTo: string = "/") {
    nav("/login", { state: { redirectTo } });
  }

  async function goNav() {
    if (!isAuthed) return goLogin("/");
    if (!circuitId) return;
    await unlockIOSAudioOnce();
    nav(`/nav?circuit=${encodeURIComponent(circuitId)}&t=${transporteur}`);
  }

  function goRecord() {
    if (!isAuthed) return goLogin("/record");
    nav("/record");
  }

  // ===== Layout FULL APP =====
  const page: React.CSSProperties = {
    minHeight: "100dvh",
    background: "#f3f4f6",
    padding: "20px",
    boxSizing: "border-box",
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
  };

  const section: React.CSSProperties = {
    background: "#ffffff",
    borderRadius: 18,
    padding: "18px",
    marginBottom: 16,
    boxShadow: "0 2px 10px rgba(0,0,0,.04)",
  };

  const primaryCard: React.CSSProperties = {
    ...section,
    background: "linear-gradient(135deg, #1e40af, #2563eb)",
    color: "#fff",
    cursor: "pointer",
  };

  const rowBetween: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  };

  return (
    <div style={page}>
      {/* HEADER */}
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ margin: 0, fontWeight: 900 }}>Groupe Breton</h2>
        <div style={{ opacity: 0.6, fontWeight: 600 }}>Espace conducteur</div>
      </div>

      {view === "home" ? (
        <>
          {!ready ? null : !isAuthed ? (
            <button
              type="button"
              style={{ ...btn("primary"), width: "100%", marginBottom: 16 }}
              onClick={() => goLogin("/")}
            >
              Se connecter
            </button>
          ) : null}

          {/* NAVIGATION */}
          <div style={primaryCard} onClick={() => setView("gps")}>
            <div style={rowBetween}>
              <div>
                <div style={{ fontSize: 20, fontWeight: 900 }}>NAVIGATION GPS</div>
                <div style={{ opacity: 0.9, marginTop: 4 }}>
                  Navigation guidée en temps réel
                </div>
              </div>
              <div style={{ fontWeight: 800 }}>Ouvrir ›</div>
            </div>
          </div>

          {/* NOUVEAU */}
          <div style={{ ...section, cursor: "pointer" }} onClick={goRecord}>
            <div style={rowBetween}>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <RefreshCw size={22} />
                <div>
                  <div style={{ fontWeight: 800 }}>NOUVEAU CIRCUIT</div>
                  <div style={{ opacity: 0.6 }}>Mettre à jour circuit existant</div>
                </div>
              </div>
              <div style={{ fontWeight: 700 }}>Ouvrir ›</div>
            </div>
          </div>

          {/* MESSAGE */}
          <div style={{ textAlign: "center", marginTop: 30, opacity: 0.7 }}>
            <strong>
              Vous transportez plus que des élèves.
              <br />
              Vous transportez l’avenir.
            </strong>
          </div>
        </>
      ) : (
        <>
          <button style={{ ...btn("ghost"), marginBottom: 16 }} onClick={() => setView("home")}>
            Retour
          </button>

          <div style={section}>
            <div style={{ marginBottom: 8, fontWeight: 700 }}>Transporteur</div>
            <select
              style={select}
              value={transporteur}
              onChange={(e) => setTransporteur(e.target.value as TCode)}
            >
              <option value="B">{LABEL.B}</option>
              <option value="C">{LABEL.C}</option>
              <option value="S">{LABEL.S}</option>
            </select>
          </div>

          <div style={section}>
            <div style={{ marginBottom: 8, fontWeight: 700 }}>Circuit</div>
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

          <button
            type="button"
            style={{
              ...btn("primary"),
              width: "100%",
              opacity: canUse && hasCircuit ? 1 : 0.55,
            }}
            onClick={goNav}
            disabled={!canUse || !hasCircuit}
          >
            Ouvrir la navigation
          </button>

          {selected && (
            <div style={{ textAlign: "center", marginTop: 14, opacity: 0.6 }}>
              {selected.nom}
            </div>
          )}
        </>
      )}
    </div>
  );
}
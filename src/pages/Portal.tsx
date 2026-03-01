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
    u.volume = 1.0;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // =========================
  // Responsive layout (iOS + Android + tablette) — FIX “flottant”
  // =========================
  const page: React.CSSProperties = {
    minHeight: "100vh",
    minHeight: "100dvh",
    width: "100%",
    boxSizing: "border-box",

    // ✅ TOP-ALIGNED (pas de centrage vertical)
    display: "flex",
    justifyContent: "flex-start",
    alignItems: "stretch",

    // ✅ Safe areas iOS + padding constant
    paddingTop: "calc(env(safe-area-inset-top) + 14px)",
    paddingRight: "calc(env(safe-area-inset-right) + 14px)",
    paddingBottom: "calc(env(safe-area-inset-bottom) + 24px)",
    paddingLeft: "calc(env(safe-area-inset-left) + 14px)",

    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
    background:
      "radial-gradient(circle at 1px 1px, rgba(59,130,246,.10) 1px, rgba(0,0,0,0) 1px) 0 0 / 14px 14px," +
      "radial-gradient(130% 70% at 50% 35%, rgba(59,130,246,.18) 0%, rgba(59,130,246,0) 60%)," +
      "linear-gradient(180deg, #f7fafc 0%, #eef2f7 62%, #f7fafc 100%)",

    overflowX: "hidden",
  };

  const wrap: React.CSSProperties = {
    width: "100%",
    maxWidth: 620,
    margin: "0 auto",
    boxSizing: "border-box",
  };

  // ✅ mini reset box-sizing (évite le débordement même si ton CSS global ne le fait pas)
  const rootReset: React.CSSProperties = {
    boxSizing: "border-box",
  };

  const card: React.CSSProperties = {
    width: "100%",
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

  // --- Navigation card (fix overflow + align CTA) ---
  const actionBlue: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    borderRadius: 28,
    padding: "clamp(16px, 2.6vw, 20px)",
    background: "linear-gradient(135deg, #1e40af 0%, #2f6fdb 50%, #1d4ed8 100%)",
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

    // ✅ iOS: évite certains comportements de double-tap/zoom
    touchAction: "manipulation",
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

  const navLeft: React.CSSProperties = {
    minWidth: 0,
    flex: "1 1 auto",
    position: "relative",
    zIndex: 1,
  };

  const navRight: React.CSSProperties = {
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

  // --- Secondary card ---
  const actionLight: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    borderRadius: 28,
    padding: "clamp(16px, 2.6vw, 20px)",
    marginTop: 14,
    background: "linear-gradient(180deg, rgba(255,255,255,.94) 0%, rgba(255,255,255,.78) 100%)",
    border: "1px solid rgba(2,6,23,.06)",
    boxShadow: "0 14px 40px rgba(2,6,23,.10)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 14,
    cursor: "pointer",
    minHeight: 86,

    // ✅ iOS
    touchAction: "manipulation",
  };

  const newLeft: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 12,
    minWidth: 0,
    flex: "1 1 auto",
  };

  // ✅ pill "Ouvrir" comme Navigation (mais teinte brun)
  const newRightPill: React.CSSProperties = {
    flex: "0 0 auto",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "10px 14px",
    borderRadius: 999,
    background: "rgba(124,45,18,.12)",
    border: "1px solid rgba(124,45,18,.18)",
    fontWeight: 950,
    color: "rgba(124,45,18,.88)",
    whiteSpace: "nowrap",
  };

  const quote: React.CSSProperties = {
    textAlign: "center",
    marginTop: 18,
    fontWeight: 900,
    fontSize: "clamp(18px, 2.2vw, 22px)",
    color: "rgba(15,23,42,.68)",
    letterSpacing: -0.35,
    lineHeight: 1.25,
  };

  const busImg: React.CSSProperties = {
    width: "min(360px, 78%)",
    margin: "12px auto 0",
    display: "block",
    opacity: 0.32,
    filter: "blur(.2px)",
    transform: "translateY(6px)",
    pointerEvents: "none",
    userSelect: "none",
  };

  return (
    <div style={page}>
      <div style={wrap}>
        <div style={{ ...rootReset }}>
          <div style={card}>
            {/* Header text only */}
            <div style={topRow}>
              <div style={brand}>
                <p style={brandName}>Groupe Breton</p>
                <div style={brandSub}>Espace conducteur</div>
              </div>
            </div>

            {view === "home" ? (
              <>
                {!ready ? null : !isAuthed ? (
                  <button
                    type="button"
                    style={{ ...btn("primary"), width: "100%", boxSizing: "border-box" }}
                    onClick={() => goLogin("/")}
                  >
                    Se connecter
                  </button>
                ) : null}

                {/* Navigation */}
                <div style={actionBlue} onClick={() => setView("gps")} title="Navigation guidée">
                  <div style={overlay} />

                  <div style={navLeft}>
                    <div
                      style={{
                        fontWeight: 950,
                        fontSize: 22,
                        letterSpacing: -0.2,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      NAVIGATION GPS
                    </div>

                    <div
                      style={{
                        marginTop: 6,
                        fontWeight: 750,
                        opacity: 0.88,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      Navigation guidée en temps réel
                    </div>
                  </div>

                  <div style={navRight}>Ouvrir ›</div>
                </div>

                {/* Nouveau */}
                <div style={actionLight} onClick={goRecord} title="Nouveau / Mettre à jour">
                  <div style={newLeft}>
                    <RefreshCw size={26} color="rgba(124,45,18,.85)" />
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 950,
                          fontSize: 18,
                          color: "#7c2d12",
                          letterSpacing: -0.2,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        NOUVEAU CIRCUIT
                      </div>
                      <div
                        style={{
                          marginTop: 6,
                          fontWeight: 750,
                          color: "rgba(124,45,18,.70)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        Mettre à jour circuit existant
                      </div>
                    </div>
                  </div>

                  <div style={newRightPill}>Ouvrir ›</div>
                </div>

                <div style={quote}>
                  Vous transportez plus que des élèves. <br />
                  Vous transportez l’avenir.
                </div>

                <img src="/bus.png" alt="" aria-hidden="true" style={busImg} />
              </>
            ) : (
              <>
                {/* GPS selection */}
                <div style={{ display: "grid", gap: 12 }}>
                  <button type="button" style={btn("ghost")} onClick={() => setView("home")}>
                    Retour
                  </button>

                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: 900, color: "rgba(15,23,42,.70)", marginBottom: 6 }}>
                      Transporteur
                    </div>
                    <select style={select} value={transporteur} onChange={(e) => setTransporteur(e.target.value as TCode)}>
                      <option value="B">{LABEL.B}</option>
                      <option value="C">{LABEL.C}</option>
                      <option value="S">{LABEL.S}</option>
                    </select>
                  </div>

                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: 900, color: "rgba(15,23,42,.70)", marginBottom: 6 }}>
                      Circuit
                    </div>
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
                      boxSizing: "border-box",
                    }}
                    onClick={goNav}
                    disabled={!canUse || !hasCircuit}
                  >
                    Ouvrir la navigation
                  </button>

                  <div style={{ textAlign: "center", color: "rgba(15,23,42,.70)", fontWeight: 900, fontSize: 13.5 }}>
                    {selected ? selected.nom : ""}
                  </div>

                  <div style={{ textAlign: "center", color: "rgba(15,23,42,.55)", fontWeight: 800, fontSize: 12.5 }}>
                    Transporteur: {LABEL[transporteur]}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
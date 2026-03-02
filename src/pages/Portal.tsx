// src/pages/Portal.tsx
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { callFn } from "@/lib/api";
import { useAuth } from "@/lib/useAuth";
import { btn, select } from "@/ui";

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

  // =========================
  // Geolocation gate (premier check-up)
  // =========================
  const [geoReady, setGeoReady] = useState(false);
  const [needGeoPerm, setNeedGeoPerm] = useState(false);
  const [geoHint, setGeoHint] = useState<string>("");
  const [geoBusy, setGeoBusy] = useState(false);

  function requestGeoNow(onOk?: () => void) {
    try {
      // ✅ affiche tout de suite
      setNeedGeoPerm(true);
      setGeoBusy(true);
      setGeoHint("Vérification de la localisation…");

      navigator.geolocation.getCurrentPosition(
        () => {
          setGeoBusy(false);
          setGeoReady(true);
          setNeedGeoPerm(false);
          setGeoHint("");
          onOk?.();
        },
        (e) => {
          setGeoBusy(false);
          setGeoReady(false);
          setNeedGeoPerm(true);
          setGeoHint(e?.message || "Localisation refusée ou bloquée.");
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 12000 }
      );
    } catch {
      setGeoBusy(false);
      setGeoReady(false);
      setNeedGeoPerm(true);
      setGeoHint("Localisation indisponible.");
    }
  }

  // Premier check-up au chargement (si Permissions API dispo)
  useEffect(() => {
    let cancelled = false;

    async function checkPerm() {
      try {
        const perms: any = (navigator as any).permissions;
        if (!perms?.query) {
          // iOS Safari souvent: pas de permissions API -> on exige le bouton
          if (!cancelled) {
            setGeoReady(false);
            setNeedGeoPerm(true);
            setGeoHint("Active la localisation pour utiliser la navigation.");
          }
          return;
        }

        const st = await perms.query({ name: "geolocation" as any });
        if (cancelled) return;

        if (st.state === "granted") {
          setGeoReady(true);
          setNeedGeoPerm(false);
          setGeoHint("");
        } else {
          setGeoReady(false);
          setNeedGeoPerm(true);
          setGeoHint("Active la localisation pour utiliser la navigation.");
        }

        // si ça change pendant que l'app est ouverte
        try {
          st.onchange = () => {
            try {
              const s = (st as any).state;
              if (s === "granted") {
                setGeoReady(true);
                setNeedGeoPerm(false);
                setGeoHint("");
              } else {
                setGeoReady(false);
                setNeedGeoPerm(true);
                setGeoHint("Active la localisation pour utiliser la navigation.");
              }
            } catch {}
          };
        } catch {}
      } catch {
        if (!cancelled) {
          setGeoReady(false);
          setNeedGeoPerm(true);
          setGeoHint("Active la localisation pour utiliser la navigation.");
        }
      }
    }

    checkPerm();
    return () => {
      cancelled = true;
    };
  }, []);

  // =========================
  // Data load
  // =========================
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

    // ✅ si pas de geo => on force l'autorisation AVANT navigation
    if (!geoReady) {
      requestGeoNow(async () => {
        await unlockIOSAudioOnce();
        nav(`/nav?circuit=${encodeURIComponent(circuitId)}&t=${transporteur}`);
      });
      return;
    }

    await unlockIOSAudioOnce();
    nav(`/nav?circuit=${encodeURIComponent(circuitId)}&t=${transporteur}`);
  }

  function goRecord() {
    // Record aussi a besoin GPS → si pas prêt, on force l'autorisation
    if (!isAuthed) return goLogin("/record");
    if (!geoReady) {
      requestGeoNow(() => nav("/record"));
      return;
    }
    nav("/record");
  }

  /* =========================
     Styles (visuel + responsive)
  ========================= */

  const page: React.CSSProperties = {
    minHeight: "100dvh",
    width: "100%",
    boxSizing: "border-box",

    display: "flex",
    justifyContent: "flex-start",
    alignItems: "stretch",

    paddingTop: "calc(env(safe-area-inset-top) + 14px)",
    paddingRight: "calc(env(safe-area-inset-right) + 14px)",
    paddingBottom: "calc(env(safe-area-inset-bottom) + 24px)",
    paddingLeft: "calc(env(safe-area-inset-left) + 14px)",

    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
    background:
      "radial-gradient(circle at 1px 1px, rgba(59,130,246,.10) 1px, rgba(0,0,0,0) 1px) 0 0 / 14px 14px," +
      "radial-gradient(120% 70% at 50% 30%, rgba(59,130,246,.18) 0%, rgba(59,130,246,0) 60%)," +
      "linear-gradient(180deg, #f8fbff 0%, #eef3fb 55%, #f7fafc 100%)",
    overflowX: "hidden",
  };

  const wrap: React.CSSProperties = {
    width: "100%",
    maxWidth: 620,
    margin: "0 auto",
    boxSizing: "border-box",
  };

  const rootReset: React.CSSProperties = { boxSizing: "border-box" };

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

  const cardGlow: React.CSSProperties = {
    position: "absolute",
    inset: -1,
    pointerEvents: "none",
    background:
      "radial-gradient(120% 120% at 15% 10%, rgba(59,130,246,.14) 0%, rgba(59,130,246,0) 55%)," +
      "radial-gradient(120% 120% at 95% 30%, rgba(255,179,0,.10) 0%, rgba(255,179,0,0) 50%)",
    filter: "blur(10px)",
    opacity: 0.9,
  };

  const topRow: React.CSSProperties = {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 32,
  };

  const brand: React.CSSProperties = { minWidth: 0 };

  const brandName: React.CSSProperties = {
    margin: 0,
    fontWeight: 980,
    fontSize: 18,
    letterSpacing: -0.35,
    color: "#0f172a",
    lineHeight: 1.1,
  };

  const brandSub: React.CSSProperties = {
    marginTop: 5,
    fontSize: 12.5,
    fontWeight: 900,
    color: "rgba(15,23,42,.62)",
    letterSpacing: -0.15,
  };

  const tinyBadge: React.CSSProperties = {
    flex: "0 0 auto",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    borderRadius: 999,
    background: "rgba(15,23,42,.04)",
    border: "1px solid rgba(2,6,23,.06)",
    color: "rgba(15,23,42,.68)",
    fontWeight: 900,
    fontSize: 12.5,
    whiteSpace: "nowrap",
    userSelect: "none",
  };

  const dot: React.CSSProperties = {
    width: 8,
    height: 8,
    borderRadius: 999,
    background: ready ? (isAuthed ? "#22c55e" : "#f59e0b") : "rgba(15,23,42,.25)",
    boxShadow: ready ? (isAuthed ? "0 0 0 4px rgba(34,197,94,.12)" : "0 0 0 4px rgba(245,158,11,.12)") : "none",
  };

  // --- Primary Action (GPS) ---
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
    minHeight: 104,

    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 14,
    touchAction: "manipulation",
  };

  const overlayBlue: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    background:
      "radial-gradient(130% 140% at 88% 20%, rgba(255,255,255,.22) 0%, rgba(255,255,255,0) 55%)," +
      "radial-gradient(140% 140% at 25% 95%, rgba(255,255,255,.14) 0%, rgba(255,255,255,0) 62%)," +
      "linear-gradient(180deg, rgba(255,255,255,.06) 0%, rgba(255,255,255,0) 50%)",
    pointerEvents: "none",
  };

  const navLeft: React.CSSProperties = {
    minWidth: 0,
    flex: "1 1 auto",
    position: "relative",
    zIndex: 1,
  };

  const navTitle: React.CSSProperties = {
    fontWeight: 1000,
    fontSize: 22,
    letterSpacing: -0.25,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };

  const navSub: React.CSSProperties = {
    marginTop: 7,
    fontWeight: 850,
    opacity: 0.88,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };

  const pill: React.CSSProperties = {
    flex: "0 0 auto",
    position: "relative",
    zIndex: 1,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "10px 14px",
    borderRadius: 999,
    fontWeight: 1000,
    whiteSpace: "nowrap",
    userSelect: "none",
  };

  const pillBlue: React.CSSProperties = {
    ...pill,
    background: "rgba(255,255,255,.14)",
    border: "1px solid rgba(255,255,255,.18)",
    boxShadow: "0 10px 28px rgba(2,6,23,.14)",
  };

  // --- Secondary Action (Nouveau Circuit) -> ORANGE/JAUNE demandé ---
  const actionOrange: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    borderRadius: 28,
    padding: "clamp(16px, 2.6vw, 20px)",
    marginTop: 14,
    background: "linear-gradient(135deg, #fde68a 0%, #ffedd5 45%, #ffffff 100%)",
    border: "1px solid rgba(234,88,12,.16)",
    boxShadow: "0 14px 40px rgba(2,6,23,.10)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 14,
    cursor: "pointer",
    minHeight: 98,
    position: "relative",
    overflow: "hidden",
    touchAction: "manipulation",
  };

  const overlayOrange: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    background:
      "radial-gradient(120% 140% at 92% 30%, rgba(251,191,36,.30) 0%, rgba(251,191,36,0) 58%)," +
      "radial-gradient(140% 140% at 20% 100%, rgba(234,88,12,.14) 0%, rgba(234,88,12,0) 60%)," +
      "linear-gradient(180deg, rgba(255,255,255,.70) 0%, rgba(255,255,255,0) 60%)",
  };

  const newTitle: React.CSSProperties = {
    fontWeight: 1000,
    fontSize: 18,
    color: "#b45309",
    letterSpacing: -0.25,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };

  const newSub: React.CSSProperties = {
    marginTop: 7,
    fontWeight: 850,
    color: "rgba(180,83,9,.72)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };

  const busImg: React.CSSProperties = {
    width: "min(380px, 82%)",
    margin: "14px auto 0",
    display: "block",
    opacity: 0.36,
    filter: "blur(.18px)",
    transform: "translateY(8px)",
    pointerEvents: "none",
    userSelect: "none",
  };

  // Overlay geolocation (gros bouton au centre)
  const geoOverlay: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    zIndex: 5000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 18,
    background: "rgba(2,6,23,.55)",
    backdropFilter: "blur(8px)",
  };

  const geoCard: React.CSSProperties = {
    width: "min(520px, 100%)",
    borderRadius: 26,
    background: "rgba(255,255,255,.94)",
    border: "1px solid rgba(2,6,23,.10)",
    boxShadow: "0 30px 90px rgba(2,6,23,.28)",
    padding: 18,
    textAlign: "center",
  };

  const geoBtn: React.CSSProperties = {
    width: "100%",
    borderRadius: 18,
    padding: "16px 14px",
    fontWeight: 1000,
    fontSize: 18,
    border: "1px solid rgba(0,0,0,.10)",
    background: "linear-gradient(135deg, #16a34a 0%, #22c55e 55%, #16a34a 100%)",
    color: "#fff",
    cursor: "pointer",
    boxShadow: "0 18px 44px rgba(2,6,23,.18)",
    userSelect: "none",
    touchAction: "manipulation",
    opacity: geoBusy ? 0.75 : 1,
  };

  const canEnterNav = geoReady; // ✅ ton requirement: sans geo => pas de navigation

  return (
    <div style={page}>
      <div style={wrap}>
        <div style={{ ...rootReset }}>
          <div style={card}>
            <div style={cardGlow} />

            {/* Header */}
            <div style={topRow}>
              <div style={brand}>
                <p style={brandName}>Groupe Breton</p>
                <div style={brandSub}>Espace Conducteur</div>
              </div>

              <div style={tinyBadge} title={ready ? (isAuthed ? "Connecté" : "Déconnecté") : "Chargement..."}>
                <span style={dot} />
                {ready ? (isAuthed ? "Connecté" : "Déconnecté") : "…"}
              </div>
            </div>

            {/* ✅ Overlay obligatoire tant que la geo n'est pas OK */}
            {needGeoPerm && !geoReady ? (
              <div style={geoOverlay}>
                <div style={geoCard}>
                  <div style={{ fontWeight: 1100, fontSize: 20, color: "#0f172a", letterSpacing: -0.2 }}>
                    Activer la localisation
                  </div>
                  <div style={{ marginTop: 10, fontWeight: 850, color: "rgba(15,23,42,.72)", lineHeight: 1.5 }}>
                    La navigation GPS et l’enregistrement de circuit ont besoin de la localisation.
                  </div>

                  {geoHint ? (
                    <div style={{ marginTop: 10, fontSize: 13, fontWeight: 900, color: "rgba(15,23,42,.60)" }}>
                      {geoHint} {geoBusy ? <span style={{ marginLeft: 8 }}>⏳</span> : null}
                    </div>
                  ) : null}

                  <div style={{ marginTop: 14 }}>
                    <button type="button" style={geoBtn} disabled={geoBusy} onClick={() => requestGeoNow()}>
                      ACTIVER LA LOCALISATION
                    </button>
                  </div>

                  <div style={{ marginTop: 12, fontSize: 12.5, fontWeight: 850, color: "rgba(15,23,42,.55)" }}>
               
                  </div>
                </div>
              </div>
            ) : null}

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

                {/* NAVIGATION (bloquée si geo pas permise) */}
                <div
                  style={{
                    ...actionBlue,
                    opacity: canEnterNav ? 1 : 0.55,
                    cursor: canEnterNav ? "pointer" : "not-allowed",
                  }}
                  onClick={() => {
                    if (!canEnterNav) return; // ✅ interdit sans geo
                    setView("gps");
                  }}
                  title={canEnterNav ? "Navigation guidée" : "Localisation requise"}
                >
                  <div style={overlayBlue} />
                  <div style={navLeft}>
                    <div style={navTitle}>NAVIGATION GPS</div>
                    <div style={navSub}>
                      {canEnterNav ? "Navigation guidée en temps réel" : "Localisation requise (active-la pour continuer)"}
                    </div>
                  </div>
                  <div style={pillBlue}>{canEnterNav ? "OK" : "GPS"}</div>
                </div>

                {/* NOUVEAU CIRCUIT (record) */}
                <div
                  style={{
                    ...actionOrange,
                    opacity: geoReady ? 1 : 0.55,
                    cursor: geoReady ? "pointer" : "not-allowed",
                  }}
                  onClick={() => {
                    if (!geoReady) return; // ✅ interdit sans geo (record en a besoin)
                    goRecord();
                  }}
                  title={geoReady ? "Nouveau / Mettre à jour" : "Localisation requise"}
                >
                  <div style={overlayOrange} />
                  <div style={{ minWidth: 0, position: "relative", zIndex: 1 }}>
                    <div style={newTitle}>NOUVEAU CIRCUIT</div>
                    <div style={newSub}>{geoReady ? "Mettre à jour circuit existant" : "Localisation requise (active-la)"}</div>
                  </div>
                  <div
                    style={{
                      ...pill,
                      background: "linear-gradient(135deg, rgba(251,191,36,.20) 0%, rgba(234,88,12,.16) 100%)",
                      border: "1px solid rgba(180,83,9,.22)",
                      color: "rgba(146,64,14,.95)",
                      boxShadow: "0 10px 26px rgba(2,6,23,.10)",
                    }}
                  >
                    {geoReady ? "OK" : "GPS"}
                  </div>
                </div>

                <div style={{ height: 36 }} />

                <div
                  style={{
                    marginTop: 40,
                    textAlign: "center",
                    fontSize: 15,
                    fontWeight: 600,
                    color: "rgba(15,23,42,.75)",
                    letterSpacing: 0.2,
                    lineHeight: 1.6,
                  }}
                >
                  Votre calme, votre attention et votre dévouement font notre fierté.
                </div>

                <img src="/bus.png" alt="" aria-hidden="true" style={busImg} />
              </>
            ) : (
              <>
                {/* GPS selection */}
                <div style={{ display: "grid", gap: 12, position: "relative", zIndex: 1 }}>
                  <button type="button" style={btn("ghost")} onClick={() => setView("home")}>
                    Retour
                  </button>

                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: 950, color: "rgba(15,23,42,.70)", marginBottom: 6 }}>
                      Transporteur
                    </div>
                    <select style={select} value={transporteur} onChange={(e) => setTransporteur(e.target.value as TCode)}>
                      <option value="B">{LABEL.B}</option>
                      <option value="C">{LABEL.C}</option>
                      <option value="S">{LABEL.S}</option>
                    </select>
                  </div>

                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: 950, color: "rgba(15,23,42,.70)", marginBottom: 6 }}>
                      Circuit
                    </div>
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

                  <button
                    type="button"
                    style={{
                      ...btn("primary"),
                      width: "100%",
                      opacity: canUse && hasCircuit && geoReady ? 1 : 0.55,
                      boxSizing: "border-box",
                    }}
                    onClick={goNav}
                    disabled={!canUse || !hasCircuit || !geoReady}
                    title={!geoReady ? "Localisation requise" : "Ouvrir la navigation"}
                  >
                    Ouvrir la navigation
                  </button>

                  {!geoReady ? (
                    <div style={{ textAlign: "center", color: "rgba(185,28,28,.75)", fontWeight: 950, fontSize: 13.5 }}>
                      Localisation requise. Retourne et active-la.
                    </div>
                  ) : null}

                  <div style={{ textAlign: "center", color: "rgba(15,23,42,.70)", fontWeight: 950, fontSize: 13.5 }}>
                    {selected ? selected.nom : ""}
                  </div>

                  <div style={{ textAlign: "center", color: "rgba(15,23,42,.55)", fontWeight: 850, fontSize: 12.5 }}>
                    Transporteur: {LABEL[transporteur]}
                  </div>

                  <img src="/bus.png" alt="" aria-hidden="true" style={{ ...busImg, opacity: 0.2, marginTop: 8 }} />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
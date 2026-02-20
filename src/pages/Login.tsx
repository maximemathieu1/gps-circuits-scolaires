// src/pages/Login.tsx
import React, { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";

export default function Login() {
  const nav = useNavigate();
  const loc = useLocation();
  const { ready, isAuthed } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const redirectTo = (loc.state as any)?.redirectTo || "/";

  useEffect(() => {
    if (ready && isAuthed) nav(redirectTo, { replace: true });
  }, [ready, isAuthed, nav, redirectTo]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setErr(error.message);
      // pas besoin de nav ici: le hook useAuth va capter la session et rediriger
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 520, margin: "40px auto", padding: 16 }}>
      <h1 style={{ margin: "0 0 10px", fontSize: 28 }}>Connexion</h1>
      <p style={{ margin: "0 0 18px", color: "#6b7280" }}>Connecte-toi pour accéder.</p>

      <form onSubmit={onSubmit} style={{ display: "grid", gap: 12 }}>
        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontWeight: 700 }}>Email</span>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            autoComplete="email"
            required
            style={{ padding: 12, borderRadius: 12, border: "1px solid #e5e7eb" }}
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontWeight: 700 }}>Mot de passe</span>
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            autoComplete="current-password"
            required
            style={{ padding: 12, borderRadius: 12, border: "1px solid #e5e7eb" }}
          />
        </label>

        {err && <div style={{ padding: 12, borderRadius: 12, background: "#fee2e2", color: "#991b1b" }}>{err}</div>}

        <button type="submit" disabled={loading} style={{ padding: "12px 14px", borderRadius: 12, border: "none", fontWeight: 800 }}>
          {loading ? "Connexion..." : "Se connecter"}
        </button>
      </form>
    </div>
  );
}
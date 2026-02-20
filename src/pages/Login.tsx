// src/pages/Login.tsx
import React, { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabaseClient"; // ✅ IMPORTANT: même client partout

export default function Login() {
  const nav = useNavigate();
  const loc = useLocation();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // ✅ Compatible avec RequireAuth que je t’ai donné: state.from
  const redirectTo = useMemo(() => {
    const st = loc.state as any;
    return st?.from || "/";
  }, [loc.state]);

  // ✅ Si déjà connecté -> redirige
  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (!mounted) return;
        if (error) console.warn("getSession(Login):", error.message);
        if (data.session) nav(redirectTo, { replace: true });
      } catch (e: any) {
        console.warn("getSession(Login) crash:", e?.message ?? e);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [nav, redirectTo]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error) {
        setErr(error.message);
        return;
      }

      // ✅ Laisse RequireAuth faire sa job, mais on peut rediriger ici aussi
      nav(redirectTo, { replace: true });
    } catch (e: any) {
      setErr(e?.message ?? "Erreur de connexion.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 520, margin: "40px auto", padding: 16 }}>
      <h1 style={{ margin: "0 0 10px", fontSize: 28 }}>Connexion</h1>
      <p style={{ margin: "0 0 18px", color: "#6b7280" }}>
        Connecte-toi pour créer ou modifier des circuits.
      </p>

      <form onSubmit={onSubmit} style={{ display: "grid", gap: 12 }}>
        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontWeight: 700 }}>Email</span>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            autoComplete="email"
            placeholder="ex: dispatch@groupebreton.com"
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

        {err && (
          <div style={{ padding: 12, borderRadius: 12, background: "#fee2e2", color: "#991b1b", fontWeight: 800 }}>
            {err}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          style={{
            padding: "12px 14px",
            borderRadius: 12,
            border: "none",
            fontWeight: 900,
            cursor: loading ? "default" : "pointer",
          }}
        >
          {loading ? "Connexion..." : "Se connecter"}
        </button>
      </form>
    </div>
  );
}
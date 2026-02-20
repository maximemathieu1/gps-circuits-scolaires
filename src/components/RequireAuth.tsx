// src/components/RequireAuth.tsx
import React, { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { supabase } from "@/lib/supabaseClient";

export default function RequireAuth({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  const [loading, setLoading] = useState(true);
  const [hasSession, setHasSession] = useState(false);

  useEffect(() => {
    let mounted = true;

    // 1) Vérifie la session existante
    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (!mounted) return;
        if (error) console.warn("getSession:", error.message);
        setHasSession(Boolean(data.session));
        setLoading(false);
      })
      .catch((e) => {
        if (!mounted) return;
        console.warn("getSession crash:", e?.message ?? e);
        setHasSession(false);
        setLoading(false);
      });

    // 2) Écoute les changements (login/logout/refresh)
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      setHasSession(Boolean(session));
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  if (loading) {
    return (
      <div style={{ padding: 18, fontWeight: 900 }}>
        Vérification connexion…
      </div>
    );
  }

  if (!hasSession) {
    return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  }

  return <>{children}</>;
}
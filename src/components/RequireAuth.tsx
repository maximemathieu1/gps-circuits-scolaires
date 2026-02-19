import React, { useEffect, useState } from "react";
import { useLocation, Navigate } from "react-router-dom";
import { supabase } from "@/lib/api"; // ajuste si besoin

export default function RequireAuth({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  const [loading, setLoading] = useState(true);
  const [ok, setOk] = useState(false);

  useEffect(() => {
    let alive = true;

    async function check() {
      setLoading(true);
      const { data } = await supabase.auth.getSession();
      if (!alive) return;
      setOk(Boolean(data.session));
      setLoading(false);
    }

    check();

    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      check();
    });

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  if (loading) return <div style={{ padding: 16 }}>Chargement…</div>;

  if (!ok) {
    return <Navigate to="/login" replace state={{ redirectTo: loc.pathname + loc.search }} />;
  }

  return <>{children}</>;
}

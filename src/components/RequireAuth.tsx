// src/components/RequireAuth.tsx
import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/useAuth";

export default function RequireAuth({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  const { ready, isAuthed } = useAuth();

  if (!ready) {
    return <div style={{ padding: 16 }}>Chargement…</div>;
  }

  if (!isAuthed) {
    return <Navigate to="/login" replace state={{ redirectTo: loc.pathname + loc.search }} />;
  }

  return <>{children}</>;
}
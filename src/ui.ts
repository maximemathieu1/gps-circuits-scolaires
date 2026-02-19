import type { CSSProperties } from "react";

export const PRIMARY = "#243F6F";
export const ACCENT = "#2F6FDB";

export const page: CSSProperties = {
  minHeight: "100vh",
  background: "#f7f7f8",
  color: "#111827",
  fontFamily:
    'system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,"Helvetica Neue",Arial',
};

export const container: CSSProperties = {
  maxWidth: 920,
  margin: "0 auto",
  padding: 16,
};

export const card: CSSProperties = {
  background: "#fff",
  borderRadius: 16,
  boxShadow: "0 4px 16px rgba(0,0,0,.06)",
  padding: 16,
  marginBottom: 12,
};

export const h1: CSSProperties = { fontSize: 20, fontWeight: 900, margin: 0 };
export const muted: CSSProperties = { color: "#6b7280", fontSize: 13 };

export const row: CSSProperties = {
  display: "flex",
  gap: 10,
  flexWrap: "wrap",
  alignItems: "center",
};

export const btn = (variant: "primary" | "ghost" = "primary"): CSSProperties => ({
  appearance: "none",
  border: variant === "primary" ? `1px solid ${ACCENT}` : "1px solid #e5e7eb",
  background: variant === "primary" ? ACCENT : "#fff",
  color: variant === "primary" ? "#fff" : "#111827",
  borderRadius: 14,
  padding: "12px 14px",
  fontWeight: 800,
  cursor: "pointer",
});

export const bigBtn: CSSProperties = {
  ...btn("primary"),
  width: "100%",
  padding: "14px 14px",
  fontSize: 16,
};

export const select: CSSProperties = {
  width: "100%",
  padding: 12,
  borderRadius: 14,
  border: "1px solid #e5e7eb",
  background: "#fff",
  fontWeight: 700,
};

export const input: CSSProperties = {
  width: "100%",
  padding: 12,
  borderRadius: 14,
  border: "1px solid #e5e7eb",
  background: "#fff",
  fontWeight: 700,
};

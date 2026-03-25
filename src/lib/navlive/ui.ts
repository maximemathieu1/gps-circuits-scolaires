import type { StopType } from "./types";

export function stopTypeOrDefault(t?: StopType | null): StopType {
  return (t ?? "school") as StopType;
}

export function isBlockingType(t: StopType) {
  return t === "transfer" || t === "ecole";
}

export function haloColorForType(t: StopType) {
  switch (t) {
    case "school":
      return "#FBBF24";
    case "school_uturn":
      return "#f97316";
    case "uturn":
      return "#a855f7";
    case "transfer":
      return "#06b6d4";
    case "ecole":
      return "#22c55e";
    default:
      return "#93c5fd";
  }
}

export function activeLineColorForType(t: StopType) {
  switch (t) {
    case "school":
      return "#1d4ed8";
    case "school_uturn":
      return "#ea580c";
    case "uturn":
      return "#7c3aed";
    case "transfer":
      return "#0891b2";
    case "ecole":
      return "#16a34a";
    default:
      return "#1d4ed8";
  }
}

export function bannerTitleForType(t: StopType) {
  switch (t) {
    case "transfer":
      return "Transfert dans";
    case "ecole":
      return "École dans";
    case "uturn":
      return "Demi-tour dans";
    case "school_uturn":
      return "Arrêt + demi-tour dans";
    default:
      return "Arrêt scolaire dans";
  }
}

export function bannerIconForType(t: StopType) {
  switch (t) {
    case "transfer":
      return "🔁";
    case "ecole":
      return "🏫";
    case "uturn":
      return "↩️";
    case "school_uturn":
      return "🚌";
    default:
      return "🧒";
  }
}

export function tapHandler(fn: () => void) {
  return (e: any) => {
    try {
      e.preventDefault?.();
      e.stopPropagation?.();
    } catch {}
    fn();
  };
}
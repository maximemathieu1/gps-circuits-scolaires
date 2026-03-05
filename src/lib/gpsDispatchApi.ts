// src/lib/gpsDispatchApi.ts
import { supabase } from "@/lib/supabaseClient";
import { callFn } from "@/lib/api";

/**
 * Paramètres globaux NavLive (table: public.dispatch_nav_settings, singleton id=1)
 */

export type StopTypeCore = "school" | "school_uturn" | "uturn" | "transfer";
export type StopDisplayMode = "manual" | "auto";

export type DispatchNavSettings = {
  banner_speed_split_kmh: number;
  banner_m_low: number;
  banner_m_high: number;

  tts_speed_split_kmh: number;
  tts_offset_low: Record<StopTypeCore, number>;
  tts_offset_high: Record<StopTypeCore, number>;

  // ✅ NEW
  stop_display_mode: Record<StopTypeCore, StopDisplayMode>; // manual=Continuer, auto=timer
  stop_display_duration: Record<StopTypeCore, number>; // secondes (1..60)

  updated_at?: string;
};

const DEFAULTS: DispatchNavSettings = {
  banner_speed_split_kmh: 80,
  banner_m_low: 150,
  banner_m_high: 200,

  tts_speed_split_kmh: 80,
  tts_offset_low: { uturn: 5, school: 5, transfer: 5, school_uturn: 5 },
  tts_offset_high: { uturn: 5, school: 5, transfer: 5, school_uturn: 5 },

  // ✅ NEW defaults (comme tes edges)
  stop_display_mode: { school: "manual", school_uturn: "manual", uturn: "auto", transfer: "auto" },
  stop_display_duration: { school: 6, school_uturn: 6, uturn: 6, transfer: 6 },
};

function clampNum(v: any, min: number, max: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function toNum(v: any, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toObj<T extends Record<string, any>>(v: any, fallback: T): T {
  try {
    if (!v) return { ...fallback };
    if (typeof v === "string") return { ...fallback, ...(JSON.parse(v) as any) };
    if (typeof v === "object") return { ...fallback, ...(v as any) }; // jsonb arrive souvent déjà en object
    return { ...fallback };
  } catch {
    return { ...fallback };
  }
}

function normalizeOffsets(v: any): Record<StopTypeCore, number> {
  const src = toObj(v, DEFAULTS.tts_offset_low as any);
  return {
    school: clampNum(src.school, 0, 30, 5),
    school_uturn: clampNum(src.school_uturn, 0, 30, 5),
    uturn: clampNum(src.uturn, 0, 30, 5),
    transfer: clampNum(src.transfer, 0, 30, 5),
  };
}

function normalizeModes(v: any): Record<StopTypeCore, StopDisplayMode> {
  const src = toObj(v, DEFAULTS.stop_display_mode as any);
  const pick = (x: any, fb: StopDisplayMode) => {
    const s = String(x ?? "").toLowerCase().trim();
    return s === "manual" || s === "auto" ? (s as StopDisplayMode) : fb;
  };
  return {
    school: pick(src.school, DEFAULTS.stop_display_mode.school),
    school_uturn: pick(src.school_uturn, DEFAULTS.stop_display_mode.school_uturn),
    uturn: pick(src.uturn, DEFAULTS.stop_display_mode.uturn),
    transfer: pick(src.transfer, DEFAULTS.stop_display_mode.transfer),
  };
}

function normalizeDurations(v: any): Record<StopTypeCore, number> {
  const src = toObj(v, DEFAULTS.stop_display_duration as any);
  return {
    school: clampNum(src.school, 1, 60, DEFAULTS.stop_display_duration.school),
    school_uturn: clampNum(src.school_uturn, 1, 60, DEFAULTS.stop_display_duration.school_uturn),
    uturn: clampNum(src.uturn, 1, 60, DEFAULTS.stop_display_duration.uturn),
    transfer: clampNum(src.transfer, 1, 60, DEFAULTS.stop_display_duration.transfer),
  };
}

function normalizeSettings(s: any): DispatchNavSettings {
  return {
    banner_speed_split_kmh: toNum(s?.banner_speed_split_kmh, DEFAULTS.banner_speed_split_kmh),
    banner_m_low: toNum(s?.banner_m_low, DEFAULTS.banner_m_low),
    banner_m_high: toNum(s?.banner_m_high, DEFAULTS.banner_m_high),

    tts_speed_split_kmh: toNum(s?.tts_speed_split_kmh, DEFAULTS.tts_speed_split_kmh),
    tts_offset_low: normalizeOffsets(s?.tts_offset_low),
    tts_offset_high: normalizeOffsets(s?.tts_offset_high),

    // ✅ NEW
    stop_display_mode: normalizeModes(s?.stop_display_mode),
    stop_display_duration: normalizeDurations(s?.stop_display_duration),

    updated_at: s?.updated_at ?? undefined,
  };
}

/**
 * ✅ GET settings (DB DIRECT)
 */
export async function getDispatchNavSettings(): Promise<DispatchNavSettings> {
  const { data, error } = await supabase
    .from("dispatch_nav_settings")
    .select(
      [
        "banner_speed_split_kmh",
        "banner_m_low",
        "banner_m_high",
        "tts_speed_split_kmh",
        "tts_offset_low",
        "tts_offset_high",
        "stop_display_mode",
        "stop_display_duration",
        "updated_at",
      ].join(",")
    )
    .eq("id", 1)
    .single();

  if (error || !data) return { ...DEFAULTS };
  return normalizeSettings(data);
}

/**
 * UPDATE settings (Edge Function: dispatch-update-settings)
 */
export async function updateDispatchNavSettings(payload: Partial<DispatchNavSettings>) {
  return await callFn<any>("dispatch-update-settings", payload);
}
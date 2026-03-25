import { useRef } from "react";
import { clamp } from "./geo";
import type { StopType } from "./types";

export const SOUND_URLS = {
  audioOn: "/audio/audio_on.mp3",
  stopWarning: "/audio/stop_warning.mp3",
  stopReached: "/audio/stop_reached.mp3",
  stopMissed: "/audio/stop_missed.mp3",
  circuitDone: "/audio/circuit_done.mp3",
  ding: "/audio/ding.mp3",

  demiTour: "/audio/demi_tour.mp3",
  arretScolaireDemiTour: "/audio/arret_scolaire_demi_tour.mp3",
  transfert: "/audio/transfert.mp3",
  ecole: "/audio/ecole.mp3",
} as const;

export type SoundKey = keyof typeof SOUND_URLS;

export function useSfx() {
  const unlockedRef = useRef(false);

  const poolRef = useRef<Record<string, HTMLAudioElement[]>>({});
  const poolPtrRef = useRef<Record<string, number>>({});
  const lastPlayAtRef = useRef<Record<string, number>>({});

  function getFromPool(key: SoundKey) {
    const k = String(key);
    if (!poolRef.current[k]) {
      const url = SOUND_URLS[key] || "";
      const poolSize = key === "ding" ? 3 : 2;

      poolRef.current[k] = Array.from({ length: poolSize }).map(() => {
        const a = new Audio(url);
        a.preload = "auto";
        a.crossOrigin = "anonymous";
        (a as any).playsInline = true;
        return a;
      });
      poolPtrRef.current[k] = 0;
    }

    const arr = poolRef.current[k];
    const ptr = poolPtrRef.current[k] ?? 0;
    const a = arr[ptr % arr.length];
    poolPtrRef.current[k] = (ptr + 1) % arr.length;
    return a;
  }

  function preloadAll() {
    (Object.keys(SOUND_URLS) as SoundKey[]).forEach((k) => {
      try {
        const a = getFromPool(k);
        a.load?.();
      } catch {}
    });
  }

  function unlock() {
    if (unlockedRef.current) return;
    try {
      const a = getFromPool("audioOn");
      a.volume = 0.001;
      a.currentTime = 0;

      const p = a.play();
      Promise.resolve(p)
        .then(() => {
          try {
            a.pause();
            a.currentTime = 0;
          } catch {}
          unlockedRef.current = true;
          try {
            a.volume = 1.0;
          } catch {}
        })
        .catch(() => {});
    } catch {}
  }

  function play(key: SoundKey, opts?: { volume?: number; cooldownMs?: number }) {
    try {
      const k = String(key);
      const now = Date.now();
      const cd = opts?.cooldownMs ?? 700;
      const last = lastPlayAtRef.current[k] ?? 0;
      if (now - last < cd) return;
      lastPlayAtRef.current[k] = now;

      const a = getFromPool(key);
      try {
        a.pause();
      } catch {}
      try {
        a.currentTime = 0;
      } catch {}
      try {
        a.volume = clamp(opts?.volume ?? 1.0, 0, 1);
      } catch {}

      a.play().catch(() => {});
    } catch {}
  }

  return { unlock, play, preloadAll };
}

export function audioKeyForStopType(t: StopType): SoundKey {
  switch (t) {
    case "school_uturn":
      return "arretScolaireDemiTour";
    case "uturn":
      return "demiTour";
    case "transfer":
      return "transfert";
    case "ecole":
      return "ecole";
    default:
      return "stopWarning";
  }
}

export function speakNoteTTS(text: string) {
  try {
    if (!(window as any).speechSynthesis) return;
    const s = (window as any).speechSynthesis as SpeechSynthesis;
    try {
      s.cancel();
    } catch {}
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "fr-CA";
    u.rate = 1;
    u.pitch = 1;
    s.speak(u);
  } catch {}
}
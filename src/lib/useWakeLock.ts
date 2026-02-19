import { useEffect, useRef, useState } from "react";

type WakeLockSentinelLike = { released: boolean; release: () => Promise<void> };

export function useWakeLock(enabled: boolean) {
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null);
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    // @ts-ignore
    setSupported(typeof navigator !== "undefined" && !!navigator.wakeLock);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function requestLock() {
      if (!enabled) return;
      // @ts-ignore
      if (!navigator.wakeLock) return;

      try {
        // @ts-ignore
        const s = await navigator.wakeLock.request("screen");
        if (cancelled) {
          await s.release();
          return;
        }
        sentinelRef.current = s;
        setActive(true);
        // @ts-ignore
        s.addEventListener?.("release", () => setActive(false));
      } catch {
        setActive(false);
      }
    }

    async function releaseLock() {
      try {
        if (sentinelRef.current && !sentinelRef.current.released) {
          await sentinelRef.current.release();
        }
      } catch {
        // ignore
      } finally {
        sentinelRef.current = null;
        setActive(false);
      }
    }

    if (enabled) requestLock();
    else releaseLock();

    const onVis = () => {
      if (document.visibilityState === "visible" && enabled) requestLock();
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
      releaseLock();
    };
  }, [enabled]);

  return { supported, active };
}

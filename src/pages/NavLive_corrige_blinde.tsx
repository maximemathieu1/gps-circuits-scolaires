// src/pages/NavLive.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import mapboxgl from "mapbox-gl";

import { callFn } from "@/lib/api";
import { haversineMeters } from "@/lib/geo";
import { useWakeLock } from "@/lib/useWakeLock";
import { getNavLiveSession, saveNavLiveSession, clearNavLiveSession } from "@/lib/navLiveSession";

import type { StopType, StopPoint, PointsResp, TraceResp, LatLng } from "@/lib/navlive/types";
import {
  NOTE_REPEAT_COOLDOWN_MS,
  NOTE_AUTO_HIDE_MS,
  NOTE_SUPPRESS_HYSTERESIS_M,
  ACTIVE_MIN_POINTS,
  JOIN_DIST_M,
  SNAP_MAX_DIST_M,
  SNAP_VISUAL_MAX_DIST_M,
  SNAP_AHEAD_PTS,
  SNAP_BACK_PTS,
  PREDICT_AHEAD_MAX_MS,
  SNAP_DISPLAY_AHEAD_SEC,
  MIN_TRAVEL_AFTER_TARGET_SET_M,
  ARRIVE_EPS_M,
  ARRIVE_STOP_M_DEFAULT,
  ARRIVE_STOP_M_BLOCKING,
  DING_AT_M,
  APPROACH_MAX_ZOOM,
  PRECISE_STOP_ZONE_M,
  VERY_PRECISE_STOP_ZONE_M,
  LOW_SPEED_PRECISE_KMH,
  VERY_LOW_SPEED_PRECISE_KMH,
  STOP_LOCK_ZONE_M,
  STOP_LOCK_VERY_NEAR_M,
  STOP_LOCK_SPEED_KMH,
  STOP_LOCK_STOPPED_KMH,
  STOP_APPROACH_HOLD_MS,
  STOP_HOLD_RELEASE_OVER_KMH,
  STOP_HOLD_STOPPED_KMH,
  STOP_HOLD_AFTER_STOP_MS,
  STOP_RELEASE_PAST_STOP_M,
} from "@/lib/navlive/constants";
import {
  clamp,
  minDistanceToPolylineMeters,
  nearestLineIndex,
  nearestLineIndexWindow,
  snapPointToPolyline,
  movePointMeters,
  advanceAlongPolyline,
  wrap360,
  bearingDeg,
  smoothAngle,
} from "@/lib/navlive/geo";
import {
  stopTypeOrDefault,
  isBlockingType,
  haloColorForType,
  activeLineColorForType,
  bannerTitleForType,
  bannerIconForType,
  tapHandler,
} from "@/lib/navlive/ui";
import { useSfx, audioKeyForStopType, speakNoteTTS } from "@/lib/navlive/audio";

/* =========================
   Helpers
========================= */

function useQuery() {
  const { search } = useLocation();
  return useMemo(() => new URLSearchParams(search), [search]);
}

function watchPos(
  onPos: (p: { lat: number; lng: number; acc?: number | null; heading?: number | null; speed?: number | null }) => void,
  onErr: (m: string) => void
) {
  return navigator.geolocation.watchPosition(
    (pos) =>
      onPos({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        acc: pos.coords.accuracy ?? null,
        heading: (pos.coords as any).heading ?? null,
        speed: (pos.coords as any).speed ?? null,
      }),
    (err) => onErr(err.message),
    {
      enableHighAccuracy: true,
      maximumAge: 200,
      timeout: 10000,
    }
  );
}

/* =========================
   Fullscreen helpers
========================= */

async function tryEnterFullscreen() {
  try {
    const el = document.documentElement as any;
    if ((document as any).fullscreenElement) return;
    if (el.requestFullscreen) await el.requestFullscreen();
    else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
  } catch {}
}

function installAutoFullscreenOnce() {
  let done = false;

  const handler = async () => {
    if (done) return;
    done = true;
    try {
      await tryEnterFullscreen();
    } catch {}
    try {
      window.removeEventListener("pointerdown", handler, { capture: true } as any);
      window.removeEventListener("touchstart", handler, { capture: true } as any);
    } catch {}
  };

  window.addEventListener("pointerdown", handler, { capture: true });
  window.addEventListener("touchstart", handler, { capture: true });
}

/* =========================
   Main
========================= */

export default function NavLive() {
  const q = useQuery();
  const nav = useNavigate();
  const sfx = useSfx();

  const circuitId = q.get("circuit") || "";

  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);

  const [audioOn, setAudioOn] = useState(false);

  const [me, setMe] = useState<LatLng | null>(null);
  const [acc, setAcc] = useState<number | null>(null);
  const [speed, setSpeed] = useState<number | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [fullscreenImage, setFullscreenImage] = useState<string | null>(null);

  const rawGpsRef = useRef<LatLng | null>(null);
  const rawGpsAtRef = useRef<number>(0);
  const targetPosRef = useRef<LatLng | null>(null);
  const animPosRef = useRef<LatLng | null>(null);
  const logicPosRef = useRef<LatLng | null>(null);

  const accRef = useRef<number | null>(null);
  const speedRef = useRef<number | null>(null);
  const headingRef = useRef<number | null>(null);
  const lastBearingRef = useRef<number>(0);
  const lastStopFilterAtRef = useRef<number>(0);

  const snappedApproxIdxRef = useRef<number>(0);
  const snappedPointRef = useRef<LatLng | null>(null);
  const prevTraceApproxRef = useRef<number>(0);
  const lastAcceptedTraceApproxRef = useRef<number>(0);

  const [points, setPoints] = useState<StopPoint[]>([]);
  const [targetIdx, setTargetIdx] = useState(0);
  const target = points[targetIdx] ?? null;

  const [generalStartNote, setGeneralStartNote] = useState<string | null>(null);
  const [showGeneralStartNote, setShowGeneralStartNote] = useState(false);

  const [activeNote, setActiveNote] = useState<string | null>(null);
  const noteShownForIdxRef = useRef<Set<number>>(new Set());
  const noteLastShowAtRef = useRef<Record<number, number>>({});

  const noteSuppressForIdxRef = useRef<Set<number>>(new Set());

  const noteTimerRef = useRef<number | null>(null);

  const noteHoldUntilRef = useRef<number>(0);
  const noteHoldIdxRef = useRef<number>(-1);

  const [showAllNotes, setShowAllNotes] = useState(false);
  const allNotes = useMemo(() => {
    return points
      .map((p, i) => {
        const txt = String(p.note ?? "").trim();
        if (!txt) return null;

        const images = Array.isArray(p.note_images) ? p.note_images.filter(Boolean).slice(0, 3) : [];

        return {
          idx: i,
          type: stopTypeOrDefault(p.stop_type),
          label: p.label ?? null,
          triggerM: p.note_trigger_m ?? null,
          text: txt,
          images,
        };
      })
      .filter(Boolean) as {
      idx: number;
      type: StopType;
      label: string | null;
      triggerM: number | null;
      text: string;
      images: string[];
    }[];
  }, [points]);
  const hasAnyNotes = allNotes.length > 0 || !!String(generalStartNote ?? "").trim();

  const activeNoteImages = useMemo(() => {
    if (!activeNote) return [];
    if (showGeneralStartNote) return [];
    const imgs = Array.isArray(target?.note_images) ? target?.note_images.filter(Boolean) : [];
    return imgs.slice(0, 3);
  }, [activeNote, showGeneralStartNote, target]);

  function clearNoteTimer() {
    if (noteTimerRef.current != null) {
      window.clearTimeout(noteTimerRef.current);
      noteTimerRef.current = null;
    }
  }

  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const [startPrompt, setStartPrompt] = useState(false);

  const [officialLine, setOfficialLine] = useState<[number, number][]>([]);
  const [hasOfficial, setHasOfficial] = useState(false);

  const [offRouteM, setOffRouteM] = useState<number | null>(null);

  const restoreDoneRef = useRef(false);
  const persistBusyRef = useRef(false);
  const [syncBadge, setSyncBadge] = useState<"normal" | "offline">("normal");

  useWakeLock(running);

  const stopWarnRef = useRef<number | null>(null);
  const stopWarnMaxRef = useRef<number | null>(null);
  const stopDingRef = useRef<number | null>(null);

  const currentTargetDistRef = useRef<number | null>(null);
  const stopStillSinceRef = useRef<number | null>(null);
  const stopCompletedForIdxRef = useRef<number>(-1);
  const stopApproachHoldUntilRef = useRef<number>(0);
  const stopApproachHoldActiveRef = useRef<boolean>(false);
  const stopApproachStoppedAtRef = useRef<number | null>(null);
  const stopApproachHasStoppedRef = useRef<boolean>(false);
  const peakKmhSinceTargetRef = useRef<number>(0);

  const closestDistToTargetRef = useRef<number | null>(null);
  const skipArmedRef = useRef<boolean>(false);
  const lastAdvanceAtRef = useRef<number>(0);

  const SKIP_ARM_DIST_M = 90;
  const SKIP_AWAY_DIST_M = 55;
  const SKIP_GROWTH_FROM_MIN_M = 18;
  const SKIP_TRACE_MARGIN_PTS = 10;
  const SKIP_MIN_SPEED_KMH = 8;
  const ADVANCE_COOLDOWN_MS = 2200;

  const AUTO_RESUME_TRACE_MARGIN_PTS = 18;
  const AUTO_RESUME_CONFIRM_MS = 1800;
  const AUTO_RESUME_MIN_SPEED_KMH = 8;
  const AUTO_RESUME_COOLDOWN_MS = 5000;

  const autoResumeCandidateRef = useRef<number | null>(null);
  const autoResumeSinceRef = useRef<number | null>(null);
  const lastAutoResumeAtRef = useRef<number>(0);

  const [stopBanner, setStopBanner] = useState<{ show: boolean; meters: number; label?: string | null; max: number }>(
    null as any
  );
  useEffect(() => {
    setStopBanner({ show: false, meters: 0, label: null, max: 50 });
  }, []);
  const stopBannerLastMRef = useRef<number | null>(null);

  const traceIdxRef = useRef<number>(0);
  const joinedTraceRef = useRef<boolean>(false);

  const lastMeRef = useRef<LatLng | null>(null);
  const travelSinceTargetSetRef = useRef(0);
  const initialDistToTargetRef = useRef<number | null>(null);

  const followRef = useRef(true);

  function warnStopMetersFromKmh(kmh: number) {
    if (kmh >= 85) return 300;
    if (kmh >= 70) return 200;
    if (kmh >= 50) return 125;
    if (kmh >= 30) return 75;
    return 50;
  }

  function warnStopMeters() {
    const liveKmh = Math.max(0, (speedRef.current ?? 0) * 3.6);
    const peakKmh = Math.max(liveKmh, peakKmhSinceTargetRef.current || 0);
    return warnStopMetersFromKmh(peakKmh);
  }

  function computeBaseFollowZoom() {
    const liveKmh = Math.max(0, (speedRef.current ?? 0) * 3.6);

    if (liveKmh >= 90) return 16.05;
    if (liveKmh >= 75) return 16.35;
    return 16.6;
  }

  function computeAutoFollowZoom() {
    const baseZoom = computeBaseFollowZoom();

    const dStop = currentTargetDistRef.current;
    const tgt = target;
    if (!tgt || dStop == null) return baseZoom;

    const liveKmh = Math.max(0, (speedRef.current ?? 0) * 3.6);
    const now = Date.now();

    const passedRightThrough = dStop > STOP_RELEASE_PAST_STOP_M;

    if (passedRightThrough && !stopApproachHasStoppedRef.current) {
      stopApproachHoldActiveRef.current = false;
      stopApproachHoldUntilRef.current = 0;
      stopApproachStoppedAtRef.current = null;
      stopApproachHasStoppedRef.current = false;
    } else {
      if (liveKmh <= STOP_HOLD_STOPPED_KMH) {
        if (stopApproachStoppedAtRef.current == null) {
          stopApproachStoppedAtRef.current = now;
        }
        stopApproachHasStoppedRef.current = true;
      }

      const hasStopped2s =
        stopApproachStoppedAtRef.current != null &&
        now - stopApproachStoppedAtRef.current >= STOP_HOLD_AFTER_STOP_MS;

      if (stopApproachHasStoppedRef.current) {
        if (hasStopped2s) {
          if (liveKmh > STOP_HOLD_RELEASE_OVER_KMH) {
            stopApproachHoldActiveRef.current = false;
            stopApproachHoldUntilRef.current = 0;
            stopApproachStoppedAtRef.current = null;
            stopApproachHasStoppedRef.current = false;
          } else {
            let holdZoom = Math.max(baseZoom, 18.35);
            if (liveKmh <= VERY_LOW_SPEED_PRECISE_KMH) {
              holdZoom = Math.max(holdZoom, 18.5);
            }
            return holdZoom;
          }
        } else {
          let holdZoom = Math.max(baseZoom, 18.35);
          if (liveKmh <= VERY_LOW_SPEED_PRECISE_KMH) {
            holdZoom = Math.max(holdZoom, 18.5);
          }
          return holdZoom;
        }
      } else {
        const minHoldPassed = now >= (stopApproachHoldUntilRef.current || 0);

        if (!minHoldPassed) {
          let holdZoom = Math.max(baseZoom, 18.35);
          if (liveKmh <= VERY_LOW_SPEED_PRECISE_KMH) {
            holdZoom = Math.max(holdZoom, 18.5);
          }
          return holdZoom;
        }

        stopApproachHoldActiveRef.current = false;
        stopApproachHoldUntilRef.current = 0;
        stopApproachStoppedAtRef.current = null;
        stopApproachHasStoppedRef.current = false;
      }
    }

    if (stopCompletedForIdxRef.current === targetIdx) {
      return baseZoom;
    }

    const t = stopTypeOrDefault(tgt.stop_type);
    const arriveM = isBlockingType(t) ? ARRIVE_STOP_M_BLOCKING : ARRIVE_STOP_M_DEFAULT;

    const peakKmh = Math.max(liveKmh, peakKmhSinceTargetRef.current || 0);

    const warnM = Math.max(
      stopWarnMaxRef.current ?? 0,
      warnStopMetersFromKmh(peakKmh),
      warnStopMetersFromKmh(liveKmh)
    );

    if (dStop > warnM) return baseZoom;

    const denom = Math.max(1, warnM - arriveM);
    const progress = clamp((warnM - dStop) / denom, 0, 1);

    let targetZoom = baseZoom + (APPROACH_MAX_ZOOM - baseZoom) * progress;

    if (dStop <= PRECISE_STOP_ZONE_M || liveKmh <= LOW_SPEED_PRECISE_KMH) {
      targetZoom = Math.max(targetZoom, 17.8);
    }

    if (dStop <= VERY_PRECISE_STOP_ZONE_M || liveKmh <= VERY_LOW_SPEED_PRECISE_KMH) {
      targetZoom = Math.max(targetZoom, 18.35);
    }

    if (dStop <= arriveM + 6) {
      targetZoom = Math.max(targetZoom, 18.55);
    }

    return targetZoom;
  }

  function canAdvanceStopNow() {
    return Date.now() - lastAdvanceAtRef.current >= ADVANCE_COOLDOWN_MS;
  }

  function markStopAdvanced() {
    lastAdvanceAtRef.current = Date.now();
    closestDistToTargetRef.current = null;
    skipArmedRef.current = false;
  }

  function canAutoResumeNow() {
    return Date.now() - lastAutoResumeAtRef.current >= AUTO_RESUME_COOLDOWN_MS;
  }

  function markAutoResumed() {
    lastAutoResumeAtRef.current = Date.now();
    autoResumeCandidateRef.current = null;
    autoResumeSinceRef.current = null;
  }

  async function persistNavSession(
    partial?: Partial<{
      running: boolean;
      finished: boolean;
      paused: boolean;
      targetIdx: number;
      me: LatLng | null;
      acc: number | null;
      speed: number | null;
      heading: number | null;
      showGeneralStartNote: boolean;
      startPrompt: boolean;
      activeNote: string | null;
    }>
  ) {
    if (!circuitId) return;
    if (persistBusyRef.current) return;

    persistBusyRef.current = true;
    try {
      await saveNavLiveSession({
        circuitId,
        running: partial?.running ?? running,
        finished: partial?.finished ?? finished,
        paused: partial?.paused ?? paused,
        targetIdx: partial?.targetIdx ?? targetIdx,
        me: partial?.me ?? (logicPosRef.current ?? animPosRef.current ?? me ?? null),
        acc: partial?.acc ?? acc,
        speed: partial?.speed ?? speed,
        heading: partial?.heading ?? heading,
        showGeneralStartNote: partial?.showGeneralStartNote ?? showGeneralStartNote,
        startPrompt: partial?.startPrompt ?? startPrompt,
        activeNote: partial?.activeNote ?? activeNote,
        noteShownIdxs: [...noteShownForIdxRef.current],
        noteSuppressIdxs: [...noteSuppressForIdxRef.current],
        joinedTrace: joinedTraceRef.current,
        traceIdx: traceIdxRef.current ?? 0,
        snappedApproxIdx: snappedApproxIdxRef.current ?? 0,
        snappedPoint: snappedPointRef.current ?? null,
        logicPos: logicPosRef.current ?? null,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // silence
    } finally {
      persistBusyRef.current = false;
    }
  }

  function advanceToNextTarget(reason: "arrival" | "skip_trace" | "skip_away", warnMax: number) {
    if (!canAdvanceStopNow()) return;

    markStopAdvanced();

    stopApproachHoldUntilRef.current = Date.now() + STOP_APPROACH_HOLD_MS;
    stopApproachHoldActiveRef.current = true;
    stopApproachStoppedAtRef.current = null;
    stopApproachHasStoppedRef.current = false;

    setStopBanner({ show: false, meters: 0, label: null, max: warnMax });

    stopWarnRef.current = null;
    stopWarnMaxRef.current = null;
    stopDingRef.current = null;
    stopBannerLastMRef.current = null;

    const nextIdx = targetIdx + 1;

    if (nextIdx < points.length) {
      setTargetIdx(nextIdx);
      clearNoteNow();
      setPaused(false);
      resetStopGatesFor(nextIdx);

      void persistNavSession({
        targetIdx: nextIdx,
        paused: false,
        activeNote: null,
      });
    } else {
      setFinished(true);
      clearNoteNow();
      setPaused(false);

      void persistNavSession({
        finished: true,
        running: true,
        paused: false,
        activeNote: null,
      });
    }

    try {
      console.log("[NavLive] advance", reason, { from: targetIdx, to: nextIdx });
    } catch {}
  }

  function maybeAutoResumeOnTrace() {
    if (!running) return;
    if (finished) return;
    if (pausedRef.current) return;
    if (startPrompt) return;
    if (showGeneralStartNote) return;

    if (!hasOfficial) return;
    if (!joinedTraceRef.current) return;
    if (!stopIdxOnTrace.length) return;
    if (!canAutoResumeNow()) return;

    const liveKmh = Math.max(0, (speedRef.current ?? 0) * 3.6);
    if (liveKmh < AUTO_RESUME_MIN_SPEED_KMH) {
      autoResumeCandidateRef.current = null;
      autoResumeSinceRef.current = null;
      return;
    }

    const traceApprox = snappedApproxIdxRef.current ?? traceIdxRef.current ?? 0;
    const currentStopTraceIdx = Number(stopIdxOnTrace[targetIdx] ?? -1);

    if (!Number.isFinite(currentStopTraceIdx) || currentStopTraceIdx < 0) return;

    if (traceApprox <= currentStopTraceIdx + AUTO_RESUME_TRACE_MARGIN_PTS) {
      autoResumeCandidateRef.current = null;
      autoResumeSinceRef.current = null;
      return;
    }

    const candidateIdx = pickTargetIdxAheadFromTrace(Math.floor(traceApprox));

    if (!Number.isFinite(candidateIdx) || candidateIdx <= targetIdx) {
      autoResumeCandidateRef.current = null;
      autoResumeSinceRef.current = null;
      return;
    }

    const now = Date.now();

    if (autoResumeCandidateRef.current !== candidateIdx) {
      autoResumeCandidateRef.current = candidateIdx;
      autoResumeSinceRef.current = now;
      return;
    }

    const since = autoResumeSinceRef.current ?? now;
    if (now - since < AUTO_RESUME_CONFIRM_MS) return;

    setTargetIdx(candidateIdx);
    resetStopGatesFor(candidateIdx);
    clearNoteNow();
    setPaused(false);

    markAutoResumed();

    void persistNavSession({
      running: true,
      paused: false,
      targetIdx: candidateIdx,
      activeNote: null,
    });

    try {
      console.log("[NavLive] auto-resume", {
        from: targetIdx,
        to: candidateIdx,
        traceApprox,
        currentStopTraceIdx,
      });
    } catch {}
  }

  /* =========================
     Mapbox
  ========================= */

  const mapElRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const meMarkerRef = useRef<mapboxgl.Marker | null>(null);

  const lineRef = useRef<[number, number][]>([]);
  const stopsRef = useRef<StopPoint[]>([]);

  const MAP_LINE_SRC = "line-src";
  const MAP_LINE_LAYER = "line-layer";
  const MAP_LINE_HALO = "line-halo";

  const MAP_ACTIVE_SRC = "active-src";
  const MAP_ACTIVE_LAYER = "active-layer";
  const MAP_ACTIVE_HALO = "active-halo";

  const MAP_STOPS_SRC = "stops-src";
  const MAP_STOPS_LAYER = "stops-layer";
  const MAP_STOPS_NUM_LAYER = "stops-num-layer";

  const MAP_ACTIVE_STOP_SRC = "active-stop-src";
  const MAP_ACTIVE_STOP_HALO = "active-stop-halo";
  const MAP_ACTIVE_STOP_FILL = "active-stop-fill";
  const MAP_ACTIVE_STOP_NUM = "active-stop-num";

  const manualZoomRef = useRef<number | null>(null);
  const manualZoomUntilRef = useRef<number>(0);

  function lockManualZoom(z: number, ms = 2500) {
    manualZoomRef.current = z;
    manualZoomUntilRef.current = Date.now() + ms;
  }

  function ensureMapToken() {
    const token = (import.meta as any).env?.VITE_MAPBOX_TOKEN || "";
    mapboxgl.accessToken = token;
    return token;
  }

  function ensureMeMarker() {
    const m = mapRef.current;
    if (!m) return null;
    if (meMarkerRef.current) return meMarkerRef.current;

    const wrap = document.createElement("div");
    wrap.style.width = "22px";
    wrap.style.height = "22px";
    wrap.style.borderRadius = "999px";
    wrap.style.background = "#2563eb";
    wrap.style.border = "3px solid #ffffff";
    wrap.style.boxShadow = "0 10px 18px rgba(0,0,0,.25)";
    wrap.style.pointerEvents = "none";
    wrap.style.position = "relative";

    const core = document.createElement("div");
    core.style.position = "absolute";
    core.style.left = "50%";
    core.style.top = "50%";
    core.style.transform = "translate(-50%, -50%)";
    core.style.width = "7px";
    core.style.height = "7px";
    core.style.borderRadius = "999px";
    core.style.background = "#ffffff";
    core.style.opacity = "0.95";

    wrap.appendChild(core);

    const mk = new mapboxgl.Marker({ element: wrap, anchor: "center" }).setLngLat([-73.0, 46.8]).addTo(m);
    meMarkerRef.current = mk;
    return mk;
  }

  function safeRemoveLayer(m: mapboxgl.Map, id: string) {
    try {
      if (m.getLayer(id)) m.removeLayer(id);
    } catch {}
  }

  function safeRemoveSource(m: mapboxgl.Map, id: string) {
    try {
      if (m.getSource(id)) m.removeSource(id);
    } catch {}
  }

  function buildLineGeoJSON(line: [number, number][]) {
    const coords: [number, number][] = line.map(([lat, lng]) => [lng, lat]);
    return { type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: coords } };
  }

  function buildActiveSegmentGeoJSON(line: [number, number][], startIdx: number, endIdx: number) {
    if (!line || line.length < 2) return buildLineGeoJSON([]);
    const s = clamp(Math.floor(startIdx), 0, line.length - 1);
    const e = clamp(Math.floor(endIdx), 0, line.length - 1);
    const a = Math.min(s, e);
    const b = Math.max(s, e);
    const slice = line.slice(a, b + 1);
    if (slice.length < 2) {
      const fallback = line.slice(Math.max(0, b - 1), b + 1);
      return buildLineGeoJSON(fallback);
    }
    return buildLineGeoJSON(slice);
  }

  function buildStopsGeoJSON(pts: StopPoint[]) {
    return {
      type: "FeatureCollection" as const,
      features: pts.map((p, i) => ({
        type: "Feature" as const,
        properties: {
          stopId: String(i),
          idx: i,
          num: String(i + 1),
          label: p.label ?? "",
          t: stopTypeOrDefault(p.stop_type),
        },
        geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] as [number, number] },
      })),
    };
  }

  function buildActiveStopGeoJSON(pts: StopPoint[], activeIdx: number) {
    const p = pts[activeIdx];
    if (!p) return { type: "FeatureCollection" as const, features: [] };

    return {
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature" as const,
          properties: {
            stopId: String(activeIdx),
            idx: activeIdx,
            num: String(activeIdx + 1),
            label: p.label ?? "",
            t: stopTypeOrDefault(p.stop_type),
          },
          geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] as [number, number] },
        },
      ],
    };
  }

  function computeStopIdsToHideNearActive(m: mapboxgl.Map, pts: StopPoint[], activeIdx: number) {
    if (!pts.length) return [];

    const active = pts[activeIdx];
    if (!active) return [];

    const activePt = m.project([active.lng, active.lat]);
    const zoom = m.getZoom();

    const hidePx = zoom >= 18 ? 26 : zoom >= 17 ? 32 : zoom >= 16 ? 40 : zoom >= 15 ? 48 : 56;

    const toHide: string[] = [];

    for (let i = 0; i < pts.length; i++) {
      if (i === activeIdx) continue;
      const p = pts[i];
      const pt = m.project([p.lng, p.lat]);

      const dx = pt.x - activePt.x;
      const dy = pt.y - activePt.y;
      const d = Math.hypot(dx, dy);

      if (d < hidePx) toHide.push(String(i));
    }

    return toHide;
  }

  function applyActiveStopPriorityFilter() {
    const m = mapRef.current;
    if (!m || !m.isStyleLoaded()) return;
    if (!stopsRef.current.length) return;

    try {
      const hideIds = computeStopIdsToHideNearActive(m, stopsRef.current, targetIdx);

      if (hideIds.length > 0) {
        const filter = ["!", ["in", ["get", "stopId"], ["literal", hideIds]]];

        if (m.getLayer(MAP_STOPS_LAYER)) m.setFilter(MAP_STOPS_LAYER, filter as any);
        if (m.getLayer(MAP_STOPS_NUM_LAYER)) m.setFilter(MAP_STOPS_NUM_LAYER, filter as any);
      } else {
        if (m.getLayer(MAP_STOPS_LAYER)) m.setFilter(MAP_STOPS_LAYER, null as any);
        if (m.getLayer(MAP_STOPS_NUM_LAYER)) m.setFilter(MAP_STOPS_NUM_LAYER, null as any);
      }
    } catch (e) {
      console.error("applyActiveStopPriorityFilter failed:", e);
    }
  }

  const FULL_LINE_WIDTH: any = ["interpolate", ["linear"], ["zoom"], 13, 3.8, 15, 5.0, 17, 6.3, 19, 7.4];
  const FULL_HALO_WIDTH: any = ["interpolate", ["linear"], ["zoom"], 13, 7.4, 15, 9.8, 17, 12.4, 19, 14.8];

  const ACTIVE_LINE_WIDTH: any = ["interpolate", ["linear"], ["zoom"], 13, 7.2, 15, 9.8, 17, 12.8, 19, 15.8];
  const ACTIVE_HALO_WIDTH: any = ["interpolate", ["linear"], ["zoom"], 13, 12.2, 15, 16.8, 17, 22.6, 19, 28.2];

  /* =========================
     Stop index sur trace
  ========================= */

  const stopIdxOnTrace = useMemo(() => {
    if (!hasOfficial || officialLine.length < 2) return [];
    if (!points.length) return [];

    const line = officialLine;
    const out: number[] = [];

    const AHEAD_WINDOW = Math.min(2500, Math.max(400, Math.floor(line.length * 0.25)));

    const first = nearestLineIndex({ lat: points[0].lat, lng: points[0].lng }, line);
    let prevIdx = clamp(first?.idx ?? 0, 0, line.length - 1);
    out.push(prevIdx);

    for (let i = 1; i < points.length; i++) {
      const p = points[i];

      const near = nearestLineIndexWindow(
        { lat: p.lat, lng: p.lng },
        line,
        prevIdx,
        Math.min(line.length - 1, prevIdx + AHEAD_WINDOW)
      );

      const pick = near ?? nearestLineIndex({ lat: p.lat, lng: p.lng }, line);
      let idx = clamp(pick?.idx ?? prevIdx, 0, line.length - 1);

      if (idx <= prevIdx) idx = Math.min(prevIdx + 1, line.length - 1);

      out.push(idx);
      prevIdx = idx;
    }

    return out;
  }, [hasOfficial, officialLine, points]);

  function computeStopIdxOnTraceFor(line: [number, number][], pts: StopPoint[]) {
    if (!line.length || line.length < 2 || !pts.length) return [];

    const out: number[] = [];
    const AHEAD_WINDOW = Math.min(2500, Math.max(400, Math.floor(line.length * 0.25)));

    const first = nearestLineIndex({ lat: pts[0].lat, lng: pts[0].lng }, line);
    let prevIdx = clamp(first?.idx ?? 0, 0, line.length - 1);
    out.push(prevIdx);

    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];

      const near = nearestLineIndexWindow(
        { lat: p.lat, lng: p.lng },
        line,
        prevIdx,
        Math.min(line.length - 1, prevIdx + AHEAD_WINDOW)
      );

      const pick = near ?? nearestLineIndex({ lat: p.lat, lng: p.lng }, line);
      let idx = clamp(pick?.idx ?? prevIdx, 0, line.length - 1);

      if (idx <= prevIdx) idx = Math.min(prevIdx + 1, line.length - 1);

      out.push(idx);
      prevIdx = idx;
    }

    return out;
  }

  function shouldOfferResumeOverlayAtLoad(pos: LatLng, line: [number, number][], pts: StopPoint[]) {
    if (!line.length || line.length < 2 || !pts.length) return false;

    const dLine = minDistanceToPolylineMeters(pos, line);
    if (dLine == null || dLine > SNAP_MAX_DIST_M) return false;

    const pick = nearestLineIndex(pos, line);
    const traceIdxNow = clamp(Math.floor(pick?.idx ?? 0), 0, line.length - 1);

    const stopIdxs = computeStopIdxOnTraceFor(line, pts);
    const stop1TraceIdx = stopIdxs[0] ?? 0;

    const RESUME_AFTER_STOP1_MARGIN_PTS = 10;

    if (traceIdxNow <= stop1TraceIdx + RESUME_AFTER_STOP1_MARGIN_PTS) return false;

    joinedTraceRef.current = true;
    traceIdxRef.current = traceIdxNow;
    snappedApproxIdxRef.current = traceIdxNow;
    snappedPointRef.current = pos;
    logicPosRef.current = pos;
    prevTraceApproxRef.current = traceIdxNow;
    lastAcceptedTraceApproxRef.current = traceIdxNow;

    return true;
  }

  function getActiveSegmentIdxs(fullLineLen: number) {
    const last = Math.max(0, fullLineLen - 1);

    const safeStop0 = stopIdxOnTrace[0];
    if (!stopIdxOnTrace.length || safeStop0 == null) {
      return { start: 0, end: clamp(ACTIVE_MIN_POINTS, 1, last) };
    }

    if (targetIdx <= 0) {
      return { start: 0, end: clamp(stopIdxOnTrace[0], 1, last) };
    }

    const prevStopTrace = clamp(stopIdxOnTrace[targetIdx - 1] ?? 0, 0, last);
    const curStopTrace = clamp(stopIdxOnTrace[targetIdx] ?? prevStopTrace + 1, 0, last);

    const start = Math.min(prevStopTrace, curStopTrace);
    const end = Math.max(prevStopTrace, curStopTrace);

    if (end <= start) return { start: Math.max(0, end - 1), end };
    return { start, end };
  }

  function getSnapWindowForCurrentTarget(fullLineLen: number) {
    const last = Math.max(0, fullLineLen - 1);

    if (!stopIdxOnTrace.length) {
      return {
        start: 0,
        end: Math.min(last, SNAP_AHEAD_PTS),
      };
    }

    if (targetIdx <= 0) {
      const firstStop = clamp(stopIdxOnTrace[0] ?? 0, 0, last);
      return {
        start: 0,
        end: clamp(firstStop + 18, 1, last),
      };
    }

    const prevStop = clamp(stopIdxOnTrace[targetIdx - 1] ?? 0, 0, last);
    const curStop = clamp(stopIdxOnTrace[targetIdx] ?? prevStop + 1, 0, last);

    const segStart = Math.min(prevStop, curStop);
    const segEnd = Math.max(prevStop, curStop);

    return {
      start: clamp(segStart - SNAP_BACK_PTS, 0, last),
      end: clamp(segEnd + 40, 1, last),
    };
  }

  function applyOverlays() {
    const m = mapRef.current;
    if (!m || !m.isStyleLoaded()) return;

    const fullLine = lineRef.current;
    const pts = stopsRef.current;

    safeRemoveLayer(m, MAP_LINE_LAYER);
    safeRemoveLayer(m, MAP_LINE_HALO);
    safeRemoveSource(m, MAP_LINE_SRC);

    safeRemoveLayer(m, MAP_ACTIVE_LAYER);
    safeRemoveLayer(m, MAP_ACTIVE_HALO);
    safeRemoveSource(m, MAP_ACTIVE_SRC);

    safeRemoveLayer(m, MAP_STOPS_NUM_LAYER);
    safeRemoveLayer(m, MAP_STOPS_LAYER);
    safeRemoveSource(m, MAP_STOPS_SRC);

    safeRemoveLayer(m, MAP_ACTIVE_STOP_NUM);
    safeRemoveLayer(m, MAP_ACTIVE_STOP_FILL);
    safeRemoveLayer(m, MAP_ACTIVE_STOP_HALO);
    safeRemoveSource(m, MAP_ACTIVE_STOP_SRC);

    if (fullLine && fullLine.length >= 2) {
      try {
        const geo = buildLineGeoJSON(fullLine);
        m.addSource(MAP_LINE_SRC, { type: "geojson", data: geo as any });

        m.addLayer({
          id: MAP_LINE_HALO,
          type: "line",
          source: MAP_LINE_SRC,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": "#FFFFFF",
            "line-width": FULL_HALO_WIDTH,
            "line-opacity": 0.22,
            "line-blur": 0.2,
          },
        });

        m.addLayer({
          id: MAP_LINE_LAYER,
          type: "line",
          source: MAP_LINE_SRC,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": "#6b7280",
            "line-width": FULL_LINE_WIDTH,
            "line-opacity": 0.72,
            "line-blur": 0.04,
          },
        });
      } catch (e) {
        console.error("Mapbox apply full line failed:", e);
      }
    }

    if (fullLine && fullLine.length >= 2) {
      try {
        const { start, end } = getActiveSegmentIdxs(fullLine.length);
        const activeGeo = buildActiveSegmentGeoJSON(fullLine, start, end);

        m.addSource(MAP_ACTIVE_SRC, { type: "geojson", data: activeGeo as any });

        m.addLayer({
          id: MAP_ACTIVE_HALO,
          type: "line",
          source: MAP_ACTIVE_SRC,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": "#93c5fd",
            "line-width": ACTIVE_HALO_WIDTH,
            "line-opacity": 0.28,
            "line-blur": 1.15,
          },
        });

        m.addLayer({
          id: MAP_ACTIVE_LAYER,
          type: "line",
          source: MAP_ACTIVE_SRC,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": "#1d4ed8",
            "line-width": ACTIVE_LINE_WIDTH,
            "line-opacity": 1,
            "line-blur": 0.02,
          },
        });
      } catch (e) {
        console.error("Mapbox apply active line failed:", e);
      }
    }

    if (pts && pts.length > 0) {
      const fc = buildStopsGeoJSON(pts);
      const activeFc = buildActiveStopGeoJSON(pts, targetIdx);

      try {
        m.addSource(MAP_STOPS_SRC, { type: "geojson", data: fc as any });

        m.addLayer({
          id: MAP_STOPS_LAYER,
          type: "circle",
          source: MAP_STOPS_SRC,
          paint: {
            "circle-radius": 16,
            "circle-color": [
              "match",
              ["get", "t"],
              "school",
              "#FF0000",
              "school_uturn",
              "#f97316",
              "uturn",
              "#a855f7",
              "transfer",
              "#06b6d4",
              "ecole",
              "#22c55e",
              "#ef4444",
            ],
            "circle-stroke-width": 0,
            "circle-stroke-color": "rgba(255,255,255,0)",
          },
        });

        m.addLayer({
          id: MAP_STOPS_NUM_LAYER,
          type: "symbol",
          source: MAP_STOPS_SRC,
          layout: {
            "text-field": ["get", "num"],
            "text-size": 16,
            "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
            "text-allow-overlap": true,
            "text-ignore-placement": true,
          },
          paint: { "text-color": "#ffffff", "text-halo-color": "rgba(0,0,0,0.55)", "text-halo-width": 1.6 },
        });

        m.addSource(MAP_ACTIVE_STOP_SRC, { type: "geojson", data: activeFc as any });

        m.addLayer({
          id: MAP_ACTIVE_STOP_HALO,
          type: "circle",
          source: MAP_ACTIVE_STOP_SRC,
          paint: {
            "circle-radius": 26,
            "circle-color": [
              "match",
              ["get", "t"],
              "school",
              "#FBBF24",
              "school_uturn",
              "#f97316",
              "uturn",
              "#a855f7",
              "transfer",
              "#06b6d4",
              "ecole",
              "#22c55e",
              "#93c5fd",
            ],
            "circle-opacity": 0.32,
            "circle-blur": 0.65,
          },
        });

        m.addLayer({
          id: MAP_ACTIVE_STOP_FILL,
          type: "circle",
          source: MAP_ACTIVE_STOP_SRC,
          paint: {
            "circle-radius": 16,
            "circle-color": [
              "match",
              ["get", "t"],
              "school",
              "#FF0000",
              "school_uturn",
              "#f97316",
              "uturn",
              "#a855f7",
              "transfer",
              "#06b6d4",
              "ecole",
              "#22c55e",
              "#ef4444",
            ],
            "circle-stroke-width": 6,
            "circle-stroke-color": "#1d4ed8",
          },
        });

        m.addLayer({
          id: MAP_ACTIVE_STOP_NUM,
          type: "symbol",
          source: MAP_ACTIVE_STOP_SRC,
          layout: {
            "text-field": ["get", "num"],
            "text-size": 16,
            "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
            "text-allow-overlap": true,
            "text-ignore-placement": true,
          },
          paint: {
            "text-color": "#ffffff",
            "text-halo-color": "rgba(0,0,0,0.55)",
            "text-halo-width": 1.8,
          },
        });

        applyActiveStopPriorityFilter();
      } catch (e) {
        console.error("Mapbox apply stops failed:", e);
      }
    }
  }

  function upsertStopsOnMap() {
    const m = mapRef.current;
    if (!m || !m.isStyleLoaded()) return;

    try {
      const src = m.getSource(MAP_STOPS_SRC) as mapboxgl.GeoJSONSource | undefined;
      const activeSrc = m.getSource(MAP_ACTIVE_STOP_SRC) as mapboxgl.GeoJSONSource | undefined;

      const data = buildStopsGeoJSON(stopsRef.current) as any;
      const activeData = buildActiveStopGeoJSON(stopsRef.current, targetIdx) as any;

      if (src) src.setData(data);
      else {
        applyOverlays();
        return;
      }

      if (activeSrc) activeSrc.setData(activeData);
      else {
        applyOverlays();
        return;
      }

      if (!m.getLayer(MAP_STOPS_LAYER) || !m.getLayer(MAP_STOPS_NUM_LAYER)) applyOverlays();
      if (!m.getLayer(MAP_ACTIVE_STOP_HALO) || !m.getLayer(MAP_ACTIVE_STOP_FILL) || !m.getLayer(MAP_ACTIVE_STOP_NUM)) {
        applyOverlays();
      }

      const tt = stopTypeOrDefault(target?.stop_type);
      const halo = haloColorForType(tt);

      try {
        if (m.getLayer(MAP_ACTIVE_STOP_HALO)) m.setPaintProperty(MAP_ACTIVE_STOP_HALO, "circle-color", halo);
      } catch {}

      applyActiveStopPriorityFilter();
    } catch (e) {
      console.error("upsertStopsOnMap failed:", e);
      applyOverlays();
      applyActiveStopPriorityFilter();
    }
  }

  const lastActiveUpdateRef = useRef<{ t: number; targetIdx: number }>({ t: 0, targetIdx: -1 });

  function upsertActiveLineOnMap() {
    const m = mapRef.current;
    if (!m || !m.isStyleLoaded()) return;

    try {
      const full = lineRef.current;
      if (!full || full.length < 2) return;

      const now = performance.now();
      const last = lastActiveUpdateRef.current;
      const targetChanged = targetIdx !== last.targetIdx;
      const timeOk = now - last.t >= 250;

      if (!targetChanged && !timeOk) return;

      lastActiveUpdateRef.current = { t: now, targetIdx };

      const src = m.getSource(MAP_ACTIVE_SRC) as mapboxgl.GeoJSONSource | undefined;

      const { start, end } = getActiveSegmentIdxs(full.length);
      const data = buildActiveSegmentGeoJSON(full, start, end) as any;

      if (src) {
        src.setData(data);
        if (!m.getLayer(MAP_ACTIVE_LAYER) || !m.getLayer(MAP_ACTIVE_HALO)) applyOverlays();
      } else {
        applyOverlays();
      }

      const tt = stopTypeOrDefault(target?.stop_type);
      const halo = haloColorForType(tt);
      const lineCol = activeLineColorForType(tt);

      try {
        if (m.getLayer(MAP_ACTIVE_HALO)) m.setPaintProperty(MAP_ACTIVE_HALO, "line-color", halo);
        if (m.getLayer(MAP_ACTIVE_LAYER)) m.setPaintProperty(MAP_ACTIVE_LAYER, "line-color", lineCol);
        if (m.getLayer(MAP_ACTIVE_STOP_HALO)) m.setPaintProperty(MAP_ACTIVE_STOP_HALO, "circle-color", halo);
      } catch {}

      upsertStopsOnMap();
    } catch (e) {
      console.error("upsertActiveLineOnMap failed:", e);
      applyOverlays();
    }
  }

  function ensureMap() {
    if (mapRef.current) return mapRef.current;
    if (!mapElRef.current) return null;

    const token = ensureMapToken();
    if (!token) {
      setErr("Mapbox: token manquant (VITE_MAPBOX_TOKEN).");
      return null;
    }

    const m = new mapboxgl.Map({
      container: mapElRef.current,
      style: "mapbox://styles/mapbox/streets-v12",
      center: [-73.0, 46.8],
      zoom: 16.6,
      pitch: 55,
      bearing: 0,
      attributionControl: false,
    });

    mapRef.current = m;

    m.on("dblclick", (e: any) => e?.originalEvent && (followRef.current = false));
    m.on("dragstart", (e: any) => e?.originalEvent && (followRef.current = false));
    m.on("pitchstart", (e: any) => e?.originalEvent && (followRef.current = false));
    m.on("rotatestart", (e: any) => e?.originalEvent && (followRef.current = false));
    m.on("zoomstart", (e: any) => e?.originalEvent && (followRef.current = false));

    m.on("load", () => {
      applyOverlays();
      try {
        m.resize();
      } catch {}
    });

    m.on("style.load", () => applyOverlays());

    return m;
  }

  function zoomIn() {
    const m = mapRef.current;
    if (!m) return;
    try {
      m.stop();
    } catch {}

    const z = clamp(m.getZoom() + 0.9, 2, 20);
    lockManualZoom(z);

    try {
      m.easeTo({ zoom: z, duration: 140, easing: (t) => t, essential: true });
    } catch {}
  }

  function zoomOut() {
    const m = mapRef.current;
    if (!m) return;
    try {
      m.stop();
    } catch {}

    const z = clamp(m.getZoom() - 0.9, 2, 20);
    lockManualZoom(z);

    try {
      m.easeTo({ zoom: z, duration: 140, easing: (t) => t, essential: true });
    } catch {}
  }

  function computeFollowOffsetPx(m: mapboxgl.Map) {
    const h = m.getCanvas().clientHeight || window.innerHeight;
    const usable = Math.max(280, h - 140);

    const v = speedRef.current ?? null;
    const kmh = v != null ? v * 3.6 : 0;

    const base = Math.round(usable * 0.22);
    const extra = Math.round(clamp(kmh * 0.6, 0, 35));
    const yOff = clamp(base + extra, 30, 120);

    return yOff;
  }

  function recenter() {
  const m = mapRef.current;
  const p = animPosRef.current ?? me;
  if (!m || !p) return;

  followRef.current = true;

  try {
    m.stop();
  } catch {}

  manualZoomRef.current = null;
  manualZoomUntilRef.current = 0;

  const targetZoom = computeAutoFollowZoom();
  const yOff = computeFollowOffsetPx(m);
  const b = wrap360((headingRef.current ?? lastBearingRef.current) || 0);

  try {
    m.easeTo({
      center: [p.lng, p.lat],
      zoom: targetZoom,
      pitch: 55,
      bearing: b,
      offset: [0, yOff],
      duration: 300,
      essential: true,
    });
  } catch {}
}

function recenterOrResume() {
  setErr(null);

  // 1. Toujours recentrer IMMÉDIATEMENT
  recenter();

  // 2. Ensuite essayer de reprendre la trace (sans bloquer)
  if (!followRef.current && canResumeOnTrace) {
    setTimeout(() => {
      const joinedOk = joinedTraceRef.current || tryJoinAndSnapNow().ok;

      if (joinedOk) {
        resumeWhereIAmOnTrace();
      }
    }, 50);
  }
}
  function enableAudio() {
    if (audioOn) return;
    sfx.unlock();
    sfx.preloadAll();
    sfx.play("audioOn", { volume: 1, cooldownMs: 0 });
    setAudioOn(true);
  }

  function clearNoteNow() {
    clearNoteTimer();
    setActiveNote(null);
    noteHoldIdxRef.current = -1;
    noteHoldUntilRef.current = 0;
    setFullscreenImage(null);

    void persistNavSession({
      activeNote: null,
    });
  }

  function resetStopGatesFor(idx: number) {
  stopWarnRef.current = null;
  stopWarnMaxRef.current = null;
  stopDingRef.current = null;
  stopBannerLastMRef.current = null;

  currentTargetDistRef.current = null;
  stopStillSinceRef.current = null;
  stopCompletedForIdxRef.current = -1;
  peakKmhSinceTargetRef.current = 0;

  stopApproachStoppedAtRef.current = null;
  stopApproachHasStoppedRef.current = false;

  closestDistToTargetRef.current = null;
  skipArmedRef.current = false;

  autoResumeCandidateRef.current = null;
  autoResumeSinceRef.current = null;

  setStopBanner({ show: false, meters: 0, label: null, max: warnStopMeters() });

  travelSinceTargetSetRef.current = 0;

  const p = logicPosRef.current ?? animPosRef.current ?? me;
  const curTarget = points[idx] ?? null;
  initialDistToTargetRef.current = p && curTarget ? haversineMeters(p, curTarget as any) : null;

  prevTraceApproxRef.current = snappedApproxIdxRef.current ?? traceIdxRef.current ?? 0;
  lastAcceptedTraceApproxRef.current = snappedApproxIdxRef.current ?? traceIdxRef.current ?? 0;
}

  function continueAfterGeneralStartNote() {
    setShowGeneralStartNote(false);
    setPaused(false);
    void persistNavSession({
      paused: false,
      showGeneralStartNote: false,
    });
  }

  function resumeAfterNote() {
    noteSuppressForIdxRef.current.add(targetIdx);

    setPaused(false);
    clearNoteNow();

    const nextIdx = targetIdx + 1;

    if (nextIdx < points.length) {
      setTargetIdx(nextIdx);
      resetStopGatesFor(nextIdx);
    } else {
      if (audioOn) sfx.play("circuitDone", { volume: 1, cooldownMs: 1500 });
      setFinished(true);
    }

    void persistNavSession({
      paused: false,
      activeNote: null,
    });
  }

  function stop() {
    setRunning(false);
    setFinished(false);

    lastMeRef.current = null;
    travelSinceTargetSetRef.current = 0;
    initialDistToTargetRef.current = null;

    joinedTraceRef.current = false;
    traceIdxRef.current = 0;
    snappedApproxIdxRef.current = 0;
    snappedPointRef.current = null;
    logicPosRef.current = null;
    prevTraceApproxRef.current = 0;
    lastAcceptedTraceApproxRef.current = 0;

    stopApproachHoldUntilRef.current = 0;
    stopApproachHoldActiveRef.current = false;
    stopApproachStoppedAtRef.current = null;
    stopApproachHasStoppedRef.current = false;

    closestDistToTargetRef.current = null;
    skipArmedRef.current = false;

    autoResumeCandidateRef.current = null;
    autoResumeSinceRef.current = null;

    setPaused(false);
    clearNoteNow();
    setShowAllNotes(false);
    setShowGeneralStartNote(false);
    setStartPrompt(false);
    setFullscreenImage(null);

    void clearNavLiveSession(circuitId);
    nav("/");
  }

   /* =========================
     Reprise “où je suis”
  ========================= */

  function pickTargetIdxAheadFromTrace(traceIdxNow: number) {
    const stops = stopIdxOnTrace;
    if (!stops || !stops.length) return 0;

    const AHEAD_MARGIN_PTS = 8;
    const minTrace = traceIdxNow + AHEAD_MARGIN_PTS;

    for (let i = 0; i < stops.length; i++) {
      const sIdx = Number(stops[i]);
      if (Number.isFinite(sIdx) && sIdx > minTrace) return i;
    }

    return Math.max(0, stops.length - 1);
  }

  function tryJoinAndSnapNow(): { ok: boolean; traceIdx: number } {
    const p = animPosRef.current ?? me;
    const line = lineRef.current;

    if (!p || !line || line.length < 2) return { ok: false, traceIdx: 0 };

    const d = minDistanceToPolylineMeters(p, line);
    if (d == null) return { ok: false, traceIdx: 0 };

    if (d <= SNAP_MAX_DIST_M) {
      joinedTraceRef.current = true;

      const snapWindow = getSnapWindowForCurrentTarget(line.length);
      const snapped = snapPointToPolyline(p, line, snapWindow.start, snapWindow.end);
      const idx = clamp(Math.floor(snapped?.approxIdx ?? 0), 0, line.length - 1);
      const approx = snapped?.approxIdx ?? idx;
      const point = snapped?.point ?? p;

      traceIdxRef.current = idx;
      snappedApproxIdxRef.current = approx;
      snappedPointRef.current = point;
      logicPosRef.current = point;

      prevTraceApproxRef.current = approx;
      lastAcceptedTraceApproxRef.current = approx;

      return { ok: true, traceIdx: idx };
    }

    return { ok: false, traceIdx: 0 };
  }

  function resumeWhereIAmOnTrace() {
    if (!hasOfficial || lineRef.current.length < 2 || !points.length || !stopIdxOnTrace.length) {
      setErr("Reprise indisponible (trace officielle manquante).");
      return;
    }

    const joinedOk = joinedTraceRef.current || tryJoinAndSnapNow().ok;
    if (!joinedOk) {
      setErr("Trop loin de la route. Rapproche-toi de la trace puis réessaie.");
      return;
    }

    stopApproachHoldUntilRef.current = 0;
    stopApproachHoldActiveRef.current = false;

    const lineLen = lineRef.current.length;
    const traceIdxNow = clamp(Math.floor(traceIdxRef.current ?? 0), 0, lineLen - 1);

    const idx = pickTargetIdxAheadFromTrace(traceIdxNow);

    setStartPrompt(false);
    setShowGeneralStartNote(false);
    clearNoteNow();
    setShowAllNotes(false);

    setTargetIdx(idx);
    resetStopGatesFor(idx);

    snappedApproxIdxRef.current = traceIdxNow;
    snappedPointRef.current = logicPosRef.current ?? animPosRef.current ?? me ?? null;

    prevTraceApproxRef.current = traceIdxNow;
    lastAcceptedTraceApproxRef.current = traceIdxNow;

    setPaused(false);

    try {
      recenter();
    } catch {}

    void persistNavSession({
      running: true,
      paused: false,
      startPrompt: false,
      showGeneralStartNote: false,
      targetIdx: idx,
    });
  }

  function restartFromBeginning() {
    setStartPrompt(false);
    setTargetIdx(0);

    joinedTraceRef.current = false;
    traceIdxRef.current = 0;
    snappedApproxIdxRef.current = 0;
    snappedPointRef.current = null;
    logicPosRef.current = null;

    prevTraceApproxRef.current = 0;
    lastAcceptedTraceApproxRef.current = 0;

    stopApproachHoldUntilRef.current = 0;
    stopApproachHoldActiveRef.current = false;

    resetStopGatesFor(0);

    clearNoteNow();
    setPaused(false);

    try {
      recenter();
    } catch {}

    void persistNavSession({
      running: true,
      paused: false,
      startPrompt: false,
      showGeneralStartNote: false,
      targetIdx: 0,
    });
  }

  /* =========================
     Load circuit
  ========================= */

  async function loadCircuit() {
    if (!circuitId) throw new Error("Circuit manquant.");

    const r = await callFn<PointsResp>("circuits-api", { action: "get_active_points", circuit_id: circuitId });
    const pts: StopPoint[] = r.points.map((p) => ({
      lat: p.lat,
      lng: p.lng,
      label: p.label ?? null,
      stop_type: (p.stop_type ?? "school") as StopType,
      note: p.note ?? null,
      note_trigger_m: p.note_trigger_m ?? null,
      note_once: p.note_once ?? null,
      note_images: Array.isArray(p.note_images) ? p.note_images.filter(Boolean) : [],
    }));
    if (pts.length === 0) throw new Error("Ce circuit n’a aucun arrêt enregistré.");

    const generalNote = String(r.general_note_start ?? "").trim() || null;

    const tr = await callFn<TraceResp>("circuits-api", { action: "get_latest_trace", circuit_id: circuitId });
    const line: [number, number][] = (tr.trail ?? []).map((p) => [p.lat, p.lng]);

    setPoints(pts);
    setGeneralStartNote(generalNote);
    setTargetIdx(0);
    setFinished(false);

    noteShownForIdxRef.current = new Set();
    noteLastShowAtRef.current = {};
    noteSuppressForIdxRef.current = new Set();

    stopsRef.current = pts;

    if (line.length >= 2) {
      setOfficialLine(line);
      setHasOfficial(true);
      lineRef.current = line;
    } else {
      setOfficialLine([]);
      setHasOfficial(false);
      lineRef.current = [];
    }

    traceIdxRef.current = 0;
    joinedTraceRef.current = false;
    snappedApproxIdxRef.current = 0;
    snappedPointRef.current = null;
    logicPosRef.current = null;
    prevTraceApproxRef.current = 0;
    lastAcceptedTraceApproxRef.current = 0;
    lastActiveUpdateRef.current = { t: 0, targetIdx: -1 };

    stopWarnRef.current = null;
    stopWarnMaxRef.current = null;
    stopDingRef.current = null;
    stopBannerLastMRef.current = null;
    currentTargetDistRef.current = null;
    stopStillSinceRef.current = null;
    stopCompletedForIdxRef.current = -1;
    stopApproachHoldUntilRef.current = 0;
    stopApproachHoldActiveRef.current = false;
    stopApproachStoppedAtRef.current = null;
    stopApproachHasStoppedRef.current = false;
    peakKmhSinceTargetRef.current = 0;

    closestDistToTargetRef.current = null;
    skipArmedRef.current = false;

    autoResumeCandidateRef.current = null;
    autoResumeSinceRef.current = null;

    setStopBanner({ show: false, meters: 0, label: null, max: 50 });

    travelSinceTargetSetRef.current = 0;
    initialDistToTargetRef.current = null;

    setPaused(false);
    clearNoteNow();
    setShowAllNotes(false);
    setShowGeneralStartNote(false);

    const m = ensureMap();
    if (m) {
      applyOverlays();
      ensureMeMarker();
      upsertActiveLineOnMap();
      upsertStopsOnMap();
      applyActiveStopPriorityFilter();
    }

    return { pts, line, generalNote };
  }

    /* =========================
     Restore local session
  ========================= */

  useEffect(() => {
    let cancelled = false;

    async function restoreLocalSession() {
      if (!circuitId) return;
      if (restoreDoneRef.current) return;
      restoreDoneRef.current = true;

      try {
        const local = await getNavLiveSession(circuitId);
        if (!local || !local.running) return;
        if (cancelled) return;

        setRunning(local.running);
        setFinished(local.finished);
        setPaused(local.paused);
        setTargetIdx(local.targetIdx);

        setMe(local.me ?? null);
        setAcc(local.acc ?? null);
        setSpeed(local.speed ?? null);
        setHeading(local.heading ?? null);

        accRef.current = local.acc ?? null;
        speedRef.current = local.speed ?? null;
        headingRef.current = local.heading ?? null;
        if (local.heading != null && Number.isFinite(local.heading)) {
          lastBearingRef.current = local.heading;
        }

        setShowGeneralStartNote(local.showGeneralStartNote);
        setStartPrompt(local.startPrompt);
        setActiveNote(local.activeNote ?? null);

        noteShownForIdxRef.current = new Set(local.noteShownIdxs ?? []);
        noteSuppressForIdxRef.current = new Set(local.noteSuppressIdxs ?? []);

        joinedTraceRef.current = Boolean(local.joinedTrace);
        traceIdxRef.current = local.traceIdx ?? 0;
        snappedApproxIdxRef.current = local.snappedApproxIdx ?? 0;
        snappedPointRef.current = local.snappedPoint ?? null;
        logicPosRef.current = local.logicPos ?? local.me ?? null;
        prevTraceApproxRef.current = local.snappedApproxIdx ?? local.traceIdx ?? 0;
        lastAcceptedTraceApproxRef.current = local.snappedApproxIdx ?? local.traceIdx ?? 0;
        animPosRef.current = local.me ?? null;
        targetPosRef.current = local.me ?? null;
        rawGpsRef.current = local.me ?? null;
        rawGpsAtRef.current = Date.now();

        if (!navigator.onLine) setSyncBadge("offline");
      } catch {
        // silence
      }
    }

    restoreLocalSession();

    return () => {
      cancelled = true;
    };
  }, [circuitId]);

  /* =========================
     AUTO START
  ========================= */

  async function startAuto() {
    setErr(null);

    if (!circuitId) {
      setErr("Circuit manquant.");
      return;
    }

    setRunning(true);

    tryEnterFullscreen();
    installAutoFullscreenOnce();

    const got = await new Promise<{ lat: number; lng: number; acc?: number | null }>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (p) =>
          resolve({
            lat: p.coords.latitude,
            lng: p.coords.longitude,
            acc: p.coords.accuracy ?? null,
          }),
        (e) => reject(new Error(e.message)),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
      );
    });

    const initial = { lat: got.lat, lng: got.lng };

    rawGpsRef.current = initial;
    rawGpsAtRef.current = Date.now();
    targetPosRef.current = initial;
    animPosRef.current = initial;
    logicPosRef.current = initial;

    setMe(initial);
    setAcc(got.acc ?? null);
    accRef.current = got.acc ?? null;

    lastMeRef.current = initial;
    travelSinceTargetSetRef.current = 0;
    initialDistToTargetRef.current = null;

    setTimeout(() => {
      ensureMap();
      ensureMeMarker();
    }, 0);

    const { pts, line, generalNote } = await loadCircuit();

    try {
      const m = mapRef.current;
      if (m) {
        followRef.current = true;
        const yOff = computeFollowOffsetPx(m);
        (m as any).jumpTo({
          center: [initial.lng, initial.lat],
          zoom: computeBaseFollowZoom(),
          bearing: 0,
          pitch: 55,
          offset: [0, yOff],
        });
      }
    } catch {}

    const offerResume = shouldOfferResumeOverlayAtLoad(initial, line, pts);

    if (offerResume) {
      setPaused(true);
      setStartPrompt(true);
      setShowGeneralStartNote(false);
    } else {
      setStartPrompt(false);
      setTargetIdx(0);
      resetStopGatesFor(0);

      if (generalNote) {
        setPaused(true);
        setShowGeneralStartNote(true);
      } else {
        setPaused(false);
        setShowGeneralStartNote(false);
      }
    }

    void persistNavSession({
      running: true,
      finished: false,
      paused: offerResume ? true : !!generalNote,
      targetIdx: 0,
      me: initial,
      acc: got.acc ?? null,
      showGeneralStartNote: !offerResume && !!generalNote,
      startPrompt: offerResume,
      activeNote: null,
    });
  }

  useEffect(() => {
    if (!circuitId) return;
    if (running) return;

    let cancelled = false;

    (async () => {
      try {
        const local = await getNavLiveSession(circuitId);
        if (cancelled) return;

        if (local?.running) return;

        await startAuto();
      } catch (e: any) {
        if (cancelled) return;
        setErr(e?.message || "Erreur démarrage.");
        setRunning(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [circuitId, running]);

  /* =========================
     GPS tracking
  ========================= */

  useEffect(() => {
    if (!running) return;

    let watchId: number | null = null;

    watchId = watchPos(
      (p) => {
        const raw = { lat: p.lat, lng: p.lng };
        rawGpsRef.current = raw;
        rawGpsAtRef.current = Date.now();

        setAcc(p.acc ?? null);
        setSpeed(p.speed ?? null);
        accRef.current = p.acc ?? null;
        speedRef.current = p.speed ?? null;

        const hd = p.heading ?? null;
        if (hd != null && Number.isFinite(hd)) {
          setHeading(hd);
          headingRef.current = hd;
          lastBearingRef.current = hd;
        } else {
          setHeading(null);
          headingRef.current = null;
        }
      },
      (m) => setErr(m)
    );

    return () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    };
  }, [running]);

  /* =========================
     Persist session
  ========================= */

  useEffect(() => {
    if (!circuitId) return;
    if (!running) return;

    void persistNavSession();
  }, [
    circuitId,
    running,
    finished,
    paused,
    targetIdx,
    me,
    acc,
    speed,
    heading,
    showGeneralStartNote,
    startPrompt,
    activeNote,
  ]);

  useEffect(() => {
    if (!running || !circuitId) return;

    const id = window.setInterval(() => {
      void persistNavSession();
    }, 3000);

    return () => window.clearInterval(id);
  }, [running, circuitId]);

  useEffect(() => {
    const onOnline = () => setSyncBadge("normal");
    const onOffline = () => setSyncBadge("offline");

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    setSyncBadge(navigator.onLine ? "normal" : "offline");

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

/* =========================
   Animation loop + follow + rotation
========================= */

useEffect(() => {
  if (!running) return;

  let raf = 0;
  let lastT = performance.now();

  const tick = (t: number) => {
    const dt = Math.max(0, Math.min(0.05, (t - lastT) / 1000));
    lastT = t;

    const raw = rawGpsRef.current;
    if (raw) {
      let logicTarget = raw;
      let displayTarget = raw;

      const rawAgeMs = Date.now() - (rawGpsAtRef.current || Date.now());
      const predictMs = clamp(rawAgeMs, 0, PREDICT_AHEAD_MAX_MS);
      const sp = Math.max(0, speedRef.current ?? 0);
      const hd = headingRef.current ?? lastBearingRef.current ?? 0;

      let predicted = raw;
      if (sp > 0.7 && Number.isFinite(hd)) {
        predicted = movePointMeters(raw, hd, sp * (predictMs / 1000));
      }

      if (hasOfficial && lineRef.current.length >= 2) {
        const line = lineRef.current;

        if (!joinedTraceRef.current) {
          const d = minDistanceToPolylineMeters(predicted, line);
          if (d != null && d <= JOIN_DIST_M) {
            const snapWindow = getSnapWindowForCurrentTarget(line.length);

            const snapped = snapPointToPolyline(
              predicted,
              line,
              snapWindow.start,
              snapWindow.end
            );

            if (snapped && snapped.dist <= SNAP_VISUAL_MAX_DIST_M) {
              joinedTraceRef.current = true;
              traceIdxRef.current = clamp(Math.floor(snapped.approxIdx), 0, line.length - 1);
              snappedApproxIdxRef.current = snapped.approxIdx;
              snappedPointRef.current = snapped.point;

             prevTraceApproxRef.current = snapped.approxIdx;
             lastAcceptedTraceApproxRef.current = snapped.approxIdx;
            }
          }
        }

        if (joinedTraceRef.current) {
          const curApprox = snappedApproxIdxRef.current ?? traceIdxRef.current ?? 0;
          const snapWindow = getSnapWindowForCurrentTarget(line.length);

          const start = Math.max(
            snapWindow.start,
            Math.floor(curApprox - SNAP_BACK_PTS)
          );

          const end = Math.min(
            snapWindow.end,
            Math.ceil(curApprox + 18)
          );

          const snapped =
            snapPointToPolyline(predicted, line, start, end) ??
            snapPointToPolyline(
              predicted,
              line,
              Math.max(snapWindow.start, Math.floor(curApprox) - 4),
              Math.min(snapWindow.end, Math.ceil(curApprox) + 18)
            );

          if (snapped && snapped.dist <= SNAP_VISUAL_MAX_DIST_M) {
            const rawPrev = animPosRef.current ?? rawGpsRef.current ?? predicted;
            const movedMeters = rawPrev ? haversineMeters(rawPrev, predicted) : 0;
            const gpsMoved = rawPrev ? haversineMeters(rawPrev, predicted) : 0;
            const prevApprox = lastAcceptedTraceApproxRef.current ?? curApprox;

            // 🔥 Limitation agressive anti-jump
            const maxTraceAdvancePts =
              movedMeters <= 3 ? 3 :
              movedMeters <= 8 ? 6 :
              movedMeters <= 15 ? 10 :
              14;

            // direction sur la trace
            const deltaTrace = snapped.approxIdx - prevApprox;

            // 🔥 distance réelle au point snap
            const distToSnap = haversineMeters(predicted, snapped.point);

            // 🔥 validation forte anti-rue parallèle / anti-retour / anti-saut
            const isValidSnap =
              distToSnap < 35 &&
              deltaTrace > -2 &&
              deltaTrace < maxTraceAdvancePts;

            if (!isValidSnap && gpsMoved > 2) {
              logicTarget = predicted;
              displayTarget = predicted;
            } else {
              // 🔒 Clamp strict
              const minAllowed = Math.max(0, prevApprox - 1);
              const maxAllowed = Math.min(line.length - 1, prevApprox + maxTraceAdvancePts);

              const nextApprox = clamp(snapped.approxIdx, minAllowed, maxAllowed);

              snappedApproxIdxRef.current = nextApprox;
              traceIdxRef.current = clamp(Math.floor(nextApprox), 0, line.length - 1);
              snappedPointRef.current = snapped.point;
              lastAcceptedTraceApproxRef.current = nextApprox;

              logicTarget = snapped.point;

              const dToTargetNow =
                target ? haversineMeters(snapped.point, { lat: target.lat, lng: target.lng }) : Infinity;

              const liveKmh = Math.max(0, (speedRef.current ?? 0) * 3.6);

              const inPreciseZone = dToTargetNow <= PRECISE_STOP_ZONE_M || liveKmh <= LOW_SPEED_PRECISE_KMH;
              const inVeryPreciseZone =
                dToTargetNow <= VERY_PRECISE_STOP_ZONE_M || liveKmh <= VERY_LOW_SPEED_PRECISE_KMH;

              let forwardMeters = Math.min(8, Math.max(0, sp * SNAP_DISPLAY_AHEAD_SEC));

              if (inPreciseZone) forwardMeters = Math.min(forwardMeters, 2.0);
              if (inVeryPreciseZone) forwardMeters = 0;

              if (dToTargetNow <= STOP_LOCK_ZONE_M && liveKmh <= STOP_LOCK_SPEED_KMH) {
                forwardMeters = 0;
              }

              if (dToTargetNow <= STOP_LOCK_VERY_NEAR_M) {
                forwardMeters = 0;
              }

              const ahead = advanceAlongPolyline(line, nextApprox, forwardMeters);
              displayTarget = ahead?.point ?? snapped.point;

              if (dToTargetNow <= STOP_LOCK_VERY_NEAR_M) {
                displayTarget = snapped.point;
              }
            }
          } else {
            logicTarget = predicted;
            displayTarget = predicted;
          }
        } else {
          logicTarget = predicted;
          displayTarget = predicted;
        }
      } else {
        logicTarget = predicted;
        displayTarget = predicted;
      }

      logicPosRef.current = logicTarget;
      targetPosRef.current = displayTarget;

      const cur = animPosRef.current ?? displayTarget;

      const dToTargetForSmooth =
        target && logicTarget ? haversineMeters(logicTarget, { lat: target.lat, lng: target.lng }) : Infinity;

      const liveKmhForSmooth = Math.max(0, (speedRef.current ?? 0) * 3.6);

      const inPreciseZoneForSmooth =
        dToTargetForSmooth <= PRECISE_STOP_ZONE_M || liveKmhForSmooth <= LOW_SPEED_PRECISE_KMH;

      const inVeryPreciseZoneForSmooth =
        dToTargetForSmooth <= VERY_PRECISE_STOP_ZONE_M || liveKmhForSmooth <= VERY_LOW_SPEED_PRECISE_KMH;

      let smoothGain = hasOfficial && joinedTraceRef.current ? 10.5 : 6.2;
      if (inPreciseZoneForSmooth) smoothGain = 14;
      if (inVeryPreciseZoneForSmooth) smoothGain = 18;

      const inStopLockZoneForSmooth =
        dToTargetForSmooth <= STOP_LOCK_ZONE_M && liveKmhForSmooth <= STOP_LOCK_SPEED_KMH;

      const inVeryNearStopLockZoneForSmooth = dToTargetForSmooth <= STOP_LOCK_VERY_NEAR_M;

      const isAlmostStoppedForLock = liveKmhForSmooth <= STOP_LOCK_STOPPED_KMH;

      let next: LatLng;

      if (inVeryNearStopLockZoneForSmooth && snappedPointRef.current) {
        const alpha = isAlmostStoppedForLock ? 1 : 0.72;
        next = {
          lat: cur.lat + (snappedPointRef.current.lat - cur.lat) * alpha,
          lng: cur.lng + (snappedPointRef.current.lng - cur.lng) * alpha,
        };
      } else if (inStopLockZoneForSmooth && snappedPointRef.current) {
        const alpha = 0.55;
        next = {
          lat: cur.lat + (snappedPointRef.current.lat - cur.lat) * alpha,
          lng: cur.lng + (snappedPointRef.current.lng - cur.lng) * alpha,
        };
      } else {
        const k = 1 - Math.pow(0.001, dt);
        const alpha = clamp(k * smoothGain, 0.1, 0.98);

        next = {
          lat: cur.lat + (displayTarget.lat - cur.lat) * alpha,
          lng: cur.lng + (displayTarget.lng - cur.lng) * alpha,
        };
      }

      const movingEnough = sp >= 0.6;
      if ((headingRef.current == null || !Number.isFinite(headingRef.current)) && movingEnough) {
        const d = haversineMeters(cur, next);
        if (d >= 0.7) {
          const b = bearingDeg(cur, next);
          const prev = wrap360(lastBearingRef.current || 0);
          lastBearingRef.current = wrap360(smoothAngle(prev, b));
        }
      } else if (headingRef.current != null && Number.isFinite(headingRef.current)) {
        const prev = wrap360(lastBearingRef.current || headingRef.current);
        lastBearingRef.current = wrap360(smoothAngle(prev, headingRef.current));
      }

      animPosRef.current = next;
      setMe(next);

      const m = ensureMap();
      if (m) {
        ensureMeMarker()?.setLngLat([next.lng, next.lat]);

        upsertActiveLineOnMap();

        const nowFilter = performance.now();
        if (nowFilter - lastStopFilterAtRef.current >= 180) {
          lastStopFilterAtRef.current = nowFilter;
          applyActiveStopPriorityFilter();
        }

        if (m.isStyleLoaded()) {
          if (!m.getLayer(MAP_LINE_LAYER) && lineRef.current.length >= 2) applyOverlays();
          if (!m.getLayer(MAP_STOPS_LAYER) && stopsRef.current.length > 0) applyOverlays();
          if (!m.getLayer(MAP_ACTIVE_LAYER) && lineRef.current.length >= 2) applyOverlays();
          if (!m.getLayer(MAP_ACTIVE_STOP_HALO) && stopsRef.current.length > 0) applyOverlays();
        }

        if (followRef.current) {
          const computedZoom = computeAutoFollowZoom();

          const zoomLocked = Date.now() < manualZoomUntilRef.current && manualZoomRef.current != null;
          const targetZoom = zoomLocked ? (manualZoomRef.current as number) : computedZoom;

          const yOff = computeFollowOffsetPx(m);
          const b = wrap360(lastBearingRef.current || 0);

          try {
            m.stop();
          } catch {}

          try {
            (m as any).easeTo({
              center: [next.lng, next.lat],
              zoom: targetZoom,
              pitch: 55,
              bearing: b,
              offset: [0, yOff],
              duration: 110,
              easing: (x: number) => x,
              essential: true,
            });
          } catch {}
        }
      }
    }

    raf = requestAnimationFrame(tick);
  };

  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}, [running, hasOfficial, targetIdx, stopIdxOnTrace, target]);  /* =========================
     Quand le targetIdx change
  ========================= */

  useEffect(() => {
    if (!running) return;
    upsertStopsOnMap();
    upsertActiveLineOnMap();

    if (!startPrompt && !showGeneralStartNote) {
      setPaused(false);
      clearNoteNow();
    }

    noteSuppressForIdxRef.current.delete(targetIdx);
  }, [targetIdx, running, showGeneralStartNote, startPrompt]);

  /* =========================
     Distance à la trace
  ========================= */

  useEffect(() => {
    if (!running) return;
    const raw = logicPosRef.current ?? rawGpsRef.current ?? me;
    if (!raw) return;
    if (!hasOfficial || officialLine.length < 2) return;

    const dLine = minDistanceToPolylineMeters(raw, officialLine);
    setOffRouteM(dLine);
  }, [running, me, hasOfficial, officialLine]);

  /* =========================
     Stops + bandeau + sons + notes + skip
  ========================= */

  useEffect(() => {
    if (!running) return;
    const p = logicPosRef.current ?? animPosRef.current ?? me;
    if (!p || !target) return;
    if (finished) return;

    if (startPrompt) return;
    if (showGeneralStartNote) return;

    if (lastMeRef.current) {
      travelSinceTargetSetRef.current += haversineMeters(lastMeRef.current, p);
    }
    lastMeRef.current = p;

    if (initialDistToTargetRef.current == null && target) {
      initialDistToTargetRef.current = haversineMeters(p, target as any);
    }

    const t = stopTypeOrDefault(target.stop_type);
    const arriveM = isBlockingType(t) ? ARRIVE_STOP_M_BLOCKING : ARRIVE_STOP_M_DEFAULT;

    const dStop = haversineMeters(p, target as any);
    currentTargetDistRef.current = dStop;

    const rawStopM = Math.round(dStop);

    const liveKmh = Math.max(0, (speedRef.current ?? 0) * 3.6);
    peakKmhSinceTargetRef.current = Math.max(peakKmhSinceTargetRef.current || 0, liveKmh);

    maybeAutoResumeOnTrace();

    const dynamicMax = warnStopMetersFromKmh(
      Math.max(liveKmh, peakKmhSinceTargetRef.current || 0)
    );
    stopWarnMaxRef.current = Math.max(stopWarnMaxRef.current ?? 0, dynamicMax);
    const WARN_STOP_M = stopWarnMaxRef.current ?? dynamicMax;

    const noteTriggerM = clamp(Number(target.note_trigger_m ?? WARN_STOP_M), 0, 1200);

    if (closestDistToTargetRef.current == null || dStop < closestDistToTargetRef.current) {
      closestDistToTargetRef.current = dStop;
    }
    if (dStop <= SKIP_ARM_DIST_M) {
      skipArmedRef.current = true;
    }

    const nearStopForComplete = rawStopM <= arriveM + 3;

    if (nearStopForComplete && liveKmh < 1) {
      if (stopStillSinceRef.current == null) {
        stopStillSinceRef.current = Date.now();
      } else if (Date.now() - stopStillSinceRef.current >= 1000) {
        stopCompletedForIdxRef.current = targetIdx;
      }
    } else {
      stopStillSinceRef.current = null;
    }

    if (rawStopM > WARN_STOP_M) {
      if (stopBanner.show) {
        setStopBanner({ show: false, meters: 0, label: null, max: WARN_STOP_M });
      }
      stopBannerLastMRef.current = null;
    }

    if (rawStopM <= WARN_STOP_M && rawStopM > arriveM) {
      const prevShown = stopBannerLastMRef.current;
      let shown = prevShown == null ? rawStopM : Math.min(prevShown, rawStopM);
      shown = Math.round(shown / 5) * 5;
      stopBannerLastMRef.current = shown;

      setStopBanner({
        show: true,
        meters: shown,
        label: target.label ?? null,
        max: WARN_STOP_M,
      });
    }

    const liveKmhVoice = Math.max(0, (speedRef.current ?? 0) * 3.6);

    let VOICE_TRIGGER_M = WARN_STOP_M;

    if (liveKmhVoice > 70) {
      const spNow = speedRef.current ?? null;
      const spAssume = spNow != null && Number.isFinite(spNow) ? spNow : 10;
      const leadM = clamp(spAssume * 4.0, 15, 140);
      VOICE_TRIGGER_M = WARN_STOP_M + leadM;
    }

    if (audioOn && stopWarnRef.current !== targetIdx) {
      if (rawStopM <= VOICE_TRIGGER_M && rawStopM > arriveM) {
        stopWarnRef.current = targetIdx;
        const key = audioKeyForStopType(t);
        sfx.play(key, { volume: 1, cooldownMs: 2500 });
      }
    }

    if (audioOn && rawStopM <= DING_AT_M && rawStopM > 1) {
      if (stopDingRef.current !== targetIdx) {
        stopDingRef.current = targetIdx;
        sfx.play("ding", { volume: 1, cooldownMs: 900 });
      }
    }

    let didShowBlockingNoteThisTick = false;

    const noteRaw = String(target.note ?? "").trim();
    const hasNote = noteRaw.length > 0;
    const inNoteZone = rawStopM <= noteTriggerM;

    if (
      noteSuppressForIdxRef.current.has(targetIdx) &&
      rawStopM > noteTriggerM + NOTE_SUPPRESS_HYSTERESIS_M
    ) {
      noteSuppressForIdxRef.current.delete(targetIdx);
    }

    if (hasNote && inNoteZone) {
      const once = Boolean(target.note_once ?? true);
      const alreadyOnce = noteShownForIdxRef.current.has(targetIdx);

      const now = Date.now();
      const last = noteLastShowAtRef.current[targetIdx] ?? 0;
      const cooldownOk = now - last >= NOTE_REPEAT_COOLDOWN_MS;

      const canShow = once ? !alreadyOnce : cooldownOk;
      const suppressed = noteSuppressForIdxRef.current.has(targetIdx);

      if (canShow && !suppressed) {
        noteLastShowAtRef.current[targetIdx] = now;
        if (once) noteShownForIdxRef.current.add(targetIdx);

        noteSuppressForIdxRef.current.add(targetIdx);

        if (isBlockingType(t)) {
          clearNoteTimer();
          setPaused(true);
          setActiveNote(noteRaw);
          if (audioOn) speakNoteTTS(noteRaw);
          didShowBlockingNoteThisTick = true;

          void persistNavSession({
            paused: true,
            activeNote: noteRaw,
          });
        } else {
          clearNoteTimer();
          setPaused(false);
          setActiveNote(noteRaw);
          if (audioOn) speakNoteTTS(noteRaw);

          noteHoldIdxRef.current = targetIdx;
          noteHoldUntilRef.current = Date.now() + NOTE_AUTO_HIDE_MS;

          noteTimerRef.current = window.setTimeout(() => {
            clearNoteNow();
          }, NOTE_AUTO_HIDE_MS);

          void persistNavSession({
            paused: false,
            activeNote: noteRaw,
          });
        }
      }
    }

    if (didShowBlockingNoteThisTick) return;
    if (pausedRef.current) return;

    if (!isBlockingType(t) && activeNote && noteHoldIdxRef.current === targetIdx) {
      if (Date.now() < (noteHoldUntilRef.current || 0)) return;
    }

    const initD = initialDistToTargetRef.current;
    const allowArrive =
      initD == null ||
      initD > arriveM + ARRIVE_EPS_M ||
      travelSinceTargetSetRef.current >= MIN_TRAVEL_AFTER_TARGET_SET_M;

    if (dStop <= arriveM && allowArrive && canAdvanceStopNow()) {
      if (audioOn) {
        if (targetIdx + 1 < points.length) {
          sfx.play("stopReached", { volume: 1, cooldownMs: 1200 });
        } else {
          sfx.play("circuitDone", { volume: 1, cooldownMs: 1500 });
        }
      }

      advanceToNextTarget("arrival", WARN_STOP_M);
      return;
    }

    const currentTraceApprox = snappedApproxIdxRef.current ?? traceIdxRef.current ?? 0;
    const stopTraceIdx = Number(stopIdxOnTrace[targetIdx] ?? -1);
    const distToTrace = minDistanceToPolylineMeters(p, officialLine);

    // vraie progression mémorisée entre deux ticks
    const prevApprox = prevTraceApproxRef.current ?? currentTraceApprox;
    const deltaTrace = currentTraceApprox - prevApprox;

    // on mémorise tout de suite pour le prochain tick
    prevTraceApproxRef.current = currentTraceApprox;

    const traceSkipOk =
      hasOfficial &&
      joinedTraceRef.current &&
      Number.isFinite(stopTraceIdx) &&
      stopTraceIdx >= 0 &&
      skipArmedRef.current &&
      liveKmh >= SKIP_MIN_SPEED_KMH &&

      // très proche de la trace
      distToTrace != null &&
      distToTrace < 30 &&

      // progression réelle vers l’avant
      deltaTrace > -0.5 &&

      // arrêt réellement dépassé mais sans téléportation lointaine
      currentTraceApprox > stopTraceIdx + SKIP_TRACE_MARGIN_PTS + 5 &&
      currentTraceApprox < stopTraceIdx + SKIP_TRACE_MARGIN_PTS + 20 &&

      // on s’éloigne vraiment du stop
      dStop > arriveM + 10 &&

      // on s’est éloigné du meilleur point atteint
      closestDistToTargetRef.current != null &&
      dStop > closestDistToTargetRef.current + 12;

    if (traceSkipOk && canAdvanceStopNow()) {
      if (audioOn) {
        if (targetIdx + 1 < points.length) {
          sfx.play("stopMissed", { volume: 1, cooldownMs: 1200 });
        } else {
          sfx.play("circuitDone", { volume: 1, cooldownMs: 1500 });
        }
      }

      advanceToNextTarget("skip_trace", WARN_STOP_M);
      return;
    }

    const closest = closestDistToTargetRef.current ?? dStop;
    const movedAway = dStop - closest;

    const awaySkipOk =
      skipArmedRef.current &&
      liveKmh >= SKIP_MIN_SPEED_KMH &&
      dStop >= SKIP_AWAY_DIST_M &&
      movedAway >= SKIP_GROWTH_FROM_MIN_M;

    if (awaySkipOk && canAdvanceStopNow()) {
      if (audioOn) {
        if (targetIdx + 1 < points.length) {
          sfx.play("stopMissed", { volume: 1, cooldownMs: 1200 });
        } else {
          sfx.play("circuitDone", { volume: 1, cooldownMs: 1500 });
        }
      }

      lastAcceptedTraceApproxRef.current = currentTraceApprox;

      advanceToNextTarget("skip_away", WARN_STOP_M);
      return;
    }
  }, [
    running,
    me,
    target,
    targetIdx,
    points,
    finished,
    stopBanner?.show,
    hasOfficial,
    officialLine,
    stopIdxOnTrace,
    audioOn,
    activeNote,
    startPrompt,
    showGeneralStartNote,
  ]);

    /* =========================
     UI
  ========================= */

  const overlayBtn: React.CSSProperties = {
    width: 48,
    height: 48,
    borderRadius: 14,
    border: "1px solid rgba(0,0,0,.12)",
    background: "#ffffff",
    boxShadow: "0 10px 24px rgba(0,0,0,.18)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 22,
    fontWeight: 900,
    cursor: "pointer",
    userSelect: "none",
    touchAction: "none",
    WebkitTapHighlightColor: "transparent",
    WebkitTouchCallout: "none",
  };

  const dangerBtn: React.CSSProperties = {
    ...overlayBtn,
    background: "#ef4444",
    color: "#fff",
    border: "1px solid rgba(0,0,0,.08)",
    boxShadow: "0 16px 34px rgba(0,0,0,.22)",
  };

  const hasBanner = !!stopBanner?.show;

  const topStack: React.CSSProperties = {
    position: "absolute",
    top: "calc(env(safe-area-inset-top) + 10px)",
    left: 12,
    right: 12,
    zIndex: 20000,
    pointerEvents: "none",
    display: "grid",
    gap: hasBanner ? 10 : 0,
  };

  const topButtonsRow: React.CSSProperties = {
    pointerEvents: "auto",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
  };

  const zoomCol: React.CSSProperties = {
    display: "grid",
    gap: 10,
    pointerEvents: "auto",
  };

  const noteOverlayWrap: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    zIndex: 24000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    background: "rgba(0,0,0,.45)",
    pointerEvents: "auto",
  };

  const noteCard: React.CSSProperties = {
    width: "min(92vw, 900px)",
    background: "rgba(17,24,39,.96)",
    color: "#fff",
    border: "2px solid rgba(255,255,255,.15)",
    borderRadius: 24,
    padding: "30px 32px",
    boxShadow: "0 30px 80px rgba(0,0,0,.55)",
    display: "grid",
    gap: 22,
    textAlign: "center",
  };

  const noteBtn: React.CSSProperties = {
    width: "100%",
    height: 64,
    fontSize: 20,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.12)",
    background: "#FBBF24",
    color: "#111827",
    fontWeight: 950,
    cursor: "pointer",
    touchAction: "none",
    WebkitTapHighlightColor: "transparent",
  };

  const noteImagesRow: React.CSSProperties = {
    display: "flex",
    gap: 12,
    justifyContent: "center",
    alignItems: "center",
    flexWrap: "wrap",
  };

  const noteImageThumb: React.CSSProperties = {
    width: 150,
    height: 110,
    objectFit: "cover",
    borderRadius: 14,
    border: "2px solid rgba(255,255,255,.18)",
    boxShadow: "0 10px 24px rgba(0,0,0,.28)",
    cursor: "pointer",
    background: "rgba(255,255,255,.06)",
    touchAction: "manipulation",
    WebkitTapHighlightColor: "transparent",
  };

  const imageFullscreenWrap: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    zIndex: 26000,
    background: "rgba(0,0,0,.92)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 18,
    pointerEvents: "auto",
  };

  const imageFullscreenCard: React.CSSProperties = {
    position: "relative",
    width: "100%",
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };

  const imageFullscreenImg: React.CSSProperties = {
    maxWidth: "100%",
    maxHeight: "100%",
    objectFit: "contain",
    borderRadius: 16,
    boxShadow: "0 24px 70px rgba(0,0,0,.45)",
  };

  const imageCloseBtn: React.CSSProperties = {
    position: "absolute",
    top: "calc(env(safe-area-inset-top) + 10px)",
    right: 4,
    minWidth: 64,
    height: 52,
    padding: "0 18px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.16)",
    background: "rgba(255,255,255,.10)",
    color: "#fff",
    fontWeight: 950,
    fontSize: 18,
    cursor: "pointer",
    touchAction: "none",
    WebkitTapHighlightColor: "transparent",
  };

  const notesOverlayWrap: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    zIndex: 24500,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 18,
    background: "rgba(0,0,0,.55)",
    pointerEvents: "auto",
  };

  const notesCard: React.CSSProperties = {
    width: "min(92vw, 980px)",
    maxHeight: "min(82vh, 820px)",
    background: "rgba(17,24,39,.97)",
    color: "#fff",
    border: "1px solid rgba(255,255,255,.14)",
    borderRadius: 22,
    boxShadow: "0 30px 80px rgba(0,0,0,.55)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  };

  const notesHeader: React.CSSProperties = {
    padding: "14px 16px",
    borderBottom: "1px solid rgba(255,255,255,.10)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  };

  const notesList: React.CSSProperties = {
    padding: 14,
    overflowY: "auto",
    WebkitOverflowScrolling: "touch",
    display: "grid",
    gap: 12,
  };

  const notesItem: React.CSSProperties = {
    border: "1px solid rgba(255,255,255,.12)",
    borderRadius: 16,
    padding: "12px 12px",
    background: "rgba(255,255,255,.04)",
    display: "grid",
    gap: 8,
  };

  const notesCloseBtn: React.CSSProperties = {
    height: 44,
    padding: "0 14px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.10)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    touchAction: "none",
    WebkitTapHighlightColor: "transparent",
  };

  const notesPhotoBtn: React.CSSProperties = {
    height: 40,
    padding: "0 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.10)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    touchAction: "none",
    WebkitTapHighlightColor: "transparent",
  };

  const startCard: React.CSSProperties = {
    width: "min(92vw, 760px)",
    background: "rgba(17,24,39,.97)",
    color: "#fff",
    border: "1px solid rgba(255,255,255,.14)",
    borderRadius: 24,
    boxShadow: "0 30px 90px rgba(0,0,0,.65)",
    padding: "18px 18px",
    display: "grid",
    gap: 12,
    textAlign: "center",
  };

  const startBtnPrimary: React.CSSProperties = {
    height: 60,
    borderRadius: 14,
    border: "1px solid rgba(0,0,0,.10)",
    background: "#FBBF24",
    color: "#111827",
    fontWeight: 950,
    fontSize: 18,
    cursor: "pointer",
    touchAction: "none",
    WebkitTapHighlightColor: "transparent",
  };

  const startBtnGhost: React.CSSProperties = {
    height: 60,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.16)",
    background: "rgba(255,255,255,.10)",
    color: "#fff",
    fontWeight: 900,
    fontSize: 16,
    cursor: "pointer",
    touchAction: "none",
    WebkitTapHighlightColor: "transparent",
  };

  const canResumeOnTrace = hasOfficial && officialLine.length >= 2 && stopIdxOnTrace.length > 0;

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative", overflow: "hidden", background: "#0b1220" }}>
      <div ref={mapElRef} style={{ width: "100%", height: "100%" }} />

      {startPrompt ? (
        <div style={noteOverlayWrap}>
          <div style={startCard}>
            <div style={{ fontSize: 22, fontWeight: 950 }}>Reprendre le trajet ?</div>
            <div style={{ opacity: 0.92, lineHeight: 1.35, fontSize: 14 }}>
              Tu sembles déjà être plus loin sur le trajet.
              <br />
              <b>Reprendre où je suis</b>
              <br />
              ou <b>Départ du début</b>.
            </div>

            <div style={{ display: "grid", gap: 10, marginTop: 6 }}>
              {canResumeOnTrace ? (
                <button
                  style={startBtnPrimary}
                  onPointerDown={tapHandler(resumeWhereIAmOnTrace)}
                  onTouchStart={tapHandler(resumeWhereIAmOnTrace)}
                  onClick={tapHandler(resumeWhereIAmOnTrace)}
                >
                  Reprendre où je suis
                </button>
              ) : null}

              <button
                style={startBtnGhost}
                onPointerDown={tapHandler(restartFromBeginning)}
                onTouchStart={tapHandler(restartFromBeginning)}
                onClick={tapHandler(restartFromBeginning)}
              >
                Départ du début
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showGeneralStartNote ? (
        <div style={noteOverlayWrap}>
          <div style={noteCard}>
            <div
              style={{
                fontSize: 38,
                fontWeight: 900,
                lineHeight: 1.25,
                whiteSpace: "pre-wrap",
                letterSpacing: 0.3,
              }}
            >
              {generalStartNote}
            </div>

            <button
              style={noteBtn}
              onPointerDown={tapHandler(continueAfterGeneralStartNote)}
              onTouchStart={tapHandler(continueAfterGeneralStartNote)}
              onClick={tapHandler(continueAfterGeneralStartNote)}
            >
              Continuer
            </button>
          </div>
        </div>
      ) : null}

      {activeNote ? (
        <div style={noteOverlayWrap}>
          <div style={noteCard}>
            <div
              style={{
                fontSize: 38,
                fontWeight: 900,
                lineHeight: 1.25,
                whiteSpace: "pre-wrap",
                letterSpacing: 0.3,
              }}
            >
              {activeNote}
            </div>

            {activeNoteImages.length > 0 ? (
              <div style={noteImagesRow}>
                {activeNoteImages.map((img, i) => (
                  <img
                    key={`${img}-${i}`}
                    src={img}
                    alt={`Photo repère ${i + 1}`}
                    style={noteImageThumb}
                    onPointerDown={tapHandler(() => setFullscreenImage(img))}
                    onTouchStart={tapHandler(() => setFullscreenImage(img))}
                    onClick={tapHandler(() => setFullscreenImage(img))}
                  />
                ))}
              </div>
            ) : null}

            {paused ? (
              <button
                style={noteBtn}
                onPointerDown={tapHandler(resumeAfterNote)}
                onTouchStart={tapHandler(resumeAfterNote)}
                onClick={tapHandler(resumeAfterNote)}
              >
                Continuer
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {fullscreenImage ? (
        <div style={imageFullscreenWrap}>
          <div style={imageFullscreenCard}>
            <button
              style={imageCloseBtn}
              onPointerDown={tapHandler(() => setFullscreenImage(null))}
              onTouchStart={tapHandler(() => setFullscreenImage(null))}
              onClick={tapHandler(() => setFullscreenImage(null))}
            >
              Retour
            </button>

            <img
              src={fullscreenImage}
              alt="Photo plein écran"
              style={imageFullscreenImg}
              onPointerDown={(e) => {
                try {
                  e.stopPropagation?.();
                } catch {}
              }}
              onTouchStart={(e) => {
                try {
                  e.stopPropagation?.();
                } catch {}
              }}
              onClick={(e) => {
                try {
                  e.stopPropagation?.();
                } catch {}
              }}
            />
          </div>
        </div>
      ) : null}

      {showAllNotes ? (
        <div style={notesOverlayWrap}>
          <div style={notesCard}>
            <div style={notesHeader}>
              <div style={{ display: "grid", gap: 2 }}>
                <div style={{ fontWeight: 950, fontSize: 18 }}>Notes du trajet</div>
                <div style={{ opacity: 0.85, fontSize: 12 }}>
                  {(String(generalStartNote ?? "").trim() ? 1 : 0) + allNotes.length
                    ? `${(String(generalStartNote ?? "").trim() ? 1 : 0) + allNotes.length} note(s)`
                    : "Aucune note sur ce trajet"}
                </div>
              </div>

              <button
                style={notesCloseBtn}
                onPointerDown={tapHandler(() => setShowAllNotes(false))}
                onTouchStart={tapHandler(() => setShowAllNotes(false))}
                onClick={tapHandler(() => setShowAllNotes(false))}
              >
                Fermer
              </button>
            </div>

            <div style={notesList}>
              {String(generalStartNote ?? "").trim() ? (
                <div style={notesItem}>
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
                    <div style={{ fontWeight: 950 }}>Note générale de départ</div>
                    <div style={{ fontSize: 12, opacity: 0.85, whiteSpace: "nowrap" }}>Début du trajet</div>
                  </div>

                  <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.25, fontSize: 16 }}>{generalStartNote}</div>
                </div>
              ) : null}

              {allNotes.length ? (
                allNotes.map((n) => (
                  <div key={n.idx} style={notesItem}>
                    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
                      <div style={{ fontWeight: 950 }}>
                        Arrêt #{n.idx + 1} — {n.label ?? "(sans nom)"}
                      </div>

                      <div style={{ fontSize: 12, opacity: 0.85, whiteSpace: "nowrap" }}>
                        {isBlockingType(n.type) ? "Bloquante" : "Auto 5s"} {n.triggerM != null ? `• ${Math.round(n.triggerM)} m` : ""}
                      </div>
                    </div>

                    <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.25, fontSize: 16 }}>{n.text}</div>

                    {n.images.length > 0 ? (
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
                        {n.images.map((img, imgIdx) => (
                          <button
                            key={`${img}-${imgIdx}`}
                            style={notesPhotoBtn}
                            onPointerDown={tapHandler(() => setFullscreenImage(img))}
                            onTouchStart={tapHandler(() => setFullscreenImage(img))}
                            onClick={tapHandler(() => setFullscreenImage(img))}
                          >
                            {n.images.length > 1 ? `Voir photo ${imgIdx + 1}` : "Voir photo"}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))
              ) : !String(generalStartNote ?? "").trim() ? (
                <div style={{ opacity: 0.9, padding: 8 }}>Aucune note configurée.</div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <div style={topStack}>
        <div
          style={{
            pointerEvents: "none",
            display: "flex",
            justifyContent: "center",
            marginBottom: hasBanner ? 0 : 8,
          }}
        >
          <div
            style={{
              background: syncBadge === "offline" ? "rgba(185,28,28,.92)" : "rgba(17,24,39,.78)",
              color: "#fff",
              border: "1px solid rgba(255,255,255,.14)",
              borderRadius: 999,
              padding: "8px 12px",
              boxShadow: "0 10px 24px rgba(0,0,0,.18)",
              fontSize: 12,
              fontWeight: 900,
            }}
          >
            {syncBadge === "offline" ? "Hors ligne — progression conservée localement" : "Navigation active"}
          </div>
        </div>

        {stopBanner?.show &&
          (() => {
            const MAX = Number.isFinite(stopBanner.max) ? stopBanner.max : 50;
            const meters = Number.isFinite(stopBanner.meters) ? stopBanner.meters : 0;
            const m = Math.max(0, Math.min(MAX, Math.round(meters)));
            const pct = Math.round((1 - m / MAX) * 100);

            const tt = stopTypeOrDefault(target?.stop_type);
            const title = bannerTitleForType(tt);
            const icon = bannerIconForType(tt);

            return (
              <div
                style={{
                  pointerEvents: "none",
                  zIndex: 20010,
                  background: "#FBBF24",
                  color: "#111827",
                  border: "1px solid rgba(0,0,0,.12)",
                  borderRadius: 18,
                  padding: "12px 14px",
                  boxShadow: "0 14px 30px rgba(0,0,0,.22)",
                  display: "grid",
                  gap: 10,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 14,
                      background: "#111827",
                      color: "#FBBF24",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 20,
                      fontWeight: 900,
                    }}
                    aria-hidden
                  >
                    {icon}
                  </div>

                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 950, fontSize: 20 }}>
                      {title} {m} m
                    </div>
                    <div style={{ fontSize: 13, opacity: 0.9 }}>{stopBanner.label ?? "Zone d’embarquement / débarquement"}</div>
                  </div>
                </div>

                <div style={{ height: 12, borderRadius: 999, background: "rgba(0,0,0,.18)", overflow: "hidden" }}>
                  <div
                    style={{
                      height: "100%",
                      width: `${pct}%`,
                      background: "#111827",
                      borderRadius: 999,
                      transition: "width 140ms linear",
                    }}
                  />
                </div>
              </div>
            );
          })()}

        <div style={topButtonsRow}>
          <button style={dangerBtn} onPointerDown={tapHandler(stop)} onTouchStart={tapHandler(stop)} onClick={tapHandler(stop)} title="Terminer">
            ✕
          </button>

          <div style={zoomCol}>
            <button
              style={overlayBtn}
              onPointerDown={tapHandler(() => (mapRef.current ? zoomIn() : void 0))}
              onTouchStart={tapHandler(() => (mapRef.current ? zoomIn() : void 0))}
              onClick={tapHandler(() => (mapRef.current ? zoomIn() : void 0))}
              aria-label="Zoom in"
              title="Zoom +"
            >
              +
            </button>

            <button
              style={overlayBtn}
              onPointerDown={tapHandler(() => (mapRef.current ? zoomOut() : void 0))}
              onTouchStart={tapHandler(() => (mapRef.current ? zoomOut() : void 0))}
              onClick={tapHandler(() => (mapRef.current ? zoomOut() : void 0))}
              aria-label="Zoom out"
              title="Zoom -"
            >
              −
            </button>

            <button
  style={{ ...overlayBtn, fontSize: 30 }}
  onPointerDown={tapHandler(recenterOrResume)}
  onTouchStart={tapHandler(recenterOrResume)}
  onClick={tapHandler(recenterOrResume)}
  aria-label="Recentrer"
  title={!followRef.current && canResumeOnTrace ? "Recentrer / reprendre où je suis" : "Recentrer"}
>
  🎯
</button>

            <button
              style={{
                ...overlayBtn,
                fontSize: 36,
                background: hasAnyNotes ? "#dbeafe" : "#ffffff",
                color: "#111827",
                border: hasAnyNotes ? "3px solid rgba(37,99,235,.45)" : "1px solid rgba(0,0,0,.12)",
                boxShadow: hasAnyNotes ? "0 16px 34px rgba(37,99,235,.20)" : (overlayBtn as any).boxShadow,
              }}
              onPointerDown={tapHandler(() => setShowAllNotes(true))}
              onTouchStart={tapHandler(() => setShowAllNotes(true))}
              onClick={tapHandler(() => setShowAllNotes(true))}
              aria-label="Voir les notes"
              title={
                hasAnyNotes
                  ? `Voir les notes (${(String(generalStartNote ?? "").trim() ? 1 : 0) + allNotes.length})`
                  : "Voir les notes"
              }
            >
              📋
            </button>

            {!audioOn ? (
              <button
                style={{ ...overlayBtn, fontSize: 30 }}
                onPointerDown={tapHandler(enableAudio)}
                onTouchStart={tapHandler(enableAudio)}
                onClick={tapHandler(enableAudio)}
                aria-label="Activer l'audio"
                title="Activer l'audio"
              >
                🔇
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {err ? (
        <div
          style={{
            position: "absolute",
            right: 12,
            bottom: "calc(env(safe-area-inset-bottom) + 12px)",
            zIndex: 25000,
            background: "rgba(255,255,255,.92)",
            border: "1px solid rgba(0,0,0,.12)",
            borderRadius: 14,
            padding: "10px 12px",
            boxShadow: "0 12px 26px rgba(0,0,0,.18)",
            maxWidth: "82vw",
            fontSize: 12,
            fontWeight: 900,
            color: "#b91c1c",
          }}
        >
          {err}
        </div>
      ) : null}

      {offRouteM != null && running ? (
        <div
          style={{
            position: "absolute",
            left: 12,
            bottom: "calc(env(safe-area-inset-bottom) + 12px)",
            zIndex: 25000,
            background: "rgba(17,24,39,.75)",
            border: "1px solid rgba(255,255,255,.10)",
            borderRadius: 14,
            padding: "8px 10px",
            boxShadow: "0 12px 26px rgba(0,0,0,.22)",
            fontSize: 12,
            fontWeight: 900,
            color: "#fff",
            pointerEvents: "none",
            opacity: 0,
          }}
        >
          Hors-trace: {Math.round(offRouteM)} m
        </div>
      ) : null}
    </div>
  );
}
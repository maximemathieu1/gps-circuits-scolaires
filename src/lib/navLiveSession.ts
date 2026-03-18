// src/lib/navLiveSession.ts
import { get, set, del } from "idb-keyval";

export type NavLiveSession = {
  circuitId: string;

  running: boolean;
  finished: boolean;
  paused: boolean;

  targetIdx: number;

  me: { lat: number; lng: number } | null;
  acc: number | null;
  speed: number | null;
  heading: number | null;

  showGeneralStartNote: boolean;
  startPrompt: boolean;
  activeNote: string | null;

  noteShownIdxs: number[];
  noteSuppressIdxs: number[];

  joinedTrace: boolean;
  traceIdx: number;
  snappedApproxIdx: number;
  snappedPoint: { lat: number; lng: number } | null;
  logicPos: { lat: number; lng: number } | null;

  updatedAt: string;
};

const keyFor = (circuitId: string) => `gps_navlive_session:${circuitId}`;

export async function getNavLiveSession(circuitId: string): Promise<NavLiveSession | null> {
  if (!circuitId) return null;
  return (await get(keyFor(circuitId))) ?? null;
}

export async function saveNavLiveSession(session: NavLiveSession): Promise<void> {
  await set(keyFor(session.circuitId), {
    ...session,
    updatedAt: new Date().toISOString(),
  });
}

export async function clearNavLiveSession(circuitId: string): Promise<void> {
  if (!circuitId) return;
  await del(keyFor(circuitId));
}
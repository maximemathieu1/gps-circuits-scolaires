import { haversineMeters } from "@/lib/geo";
import type { LatLng } from "./types";

export function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

export function projectMeters(originLat: number, p: LatLng) {
  const R = 6371000;
  const lat = (p.lat * Math.PI) / 180;
  const lng = (p.lng * Math.PI) / 180;
  const lat0 = (originLat * Math.PI) / 180;
  return { x: R * lng * Math.cos(lat0), y: R * lat };
}

export function unprojectMeters(originLat: number, x: number, y: number): LatLng {
  const R = 6371000;
  const lat0 = (originLat * Math.PI) / 180;
  const lat = (y / R) * (180 / Math.PI);
  const lng = (x / (R * Math.cos(lat0))) * (180 / Math.PI);
  return { lat, lng };
}

export function distPointToSegmentMeters(originLat: number, p: LatLng, a: LatLng, b: LatLng) {
  const P = projectMeters(originLat, p);
  const A = projectMeters(originLat, a);
  const B = projectMeters(originLat, b);

  const ABx = B.x - A.x;
  const ABy = B.y - A.y;
  const APx = P.x - A.x;
  const APy = P.y - A.y;

  const denom = ABx * ABx + ABy * ABy;
  if (denom <= 1e-9) return Math.hypot(P.x - A.x, P.y - A.y);

  const t = clamp((APx * ABx + APy * ABy) / denom, 0, 1);
  const cx = A.x + t * ABx;
  const cy = A.y + t * ABy;

  return Math.hypot(P.x - cx, P.y - cy);
}

export function minDistanceToPolylineMeters(me: LatLng, line: [number, number][]) {
  if (!line || line.length < 2) return null;

  const originLat = me.lat;
  let best = Infinity;

  for (let i = 0; i < line.length - 1; i++) {
    const a = { lat: line[i][0], lng: line[i][1] };
    const b = { lat: line[i + 1][0], lng: line[i + 1][1] };
    const d = distPointToSegmentMeters(originLat, me, a, b);
    if (d < best) best = d;
  }

  return Number.isFinite(best) ? best : null;
}

export function nearestLineIndex(me: LatLng, line: [number, number][]) {
  if (!line || line.length === 0) return null;
  let best = Infinity;
  let bestIdx = 0;
  for (let i = 0; i < line.length; i++) {
    const d = haversineMeters(me, { lat: line[i][0], lng: line[i][1] });
    if (d < best) {
      best = d;
      bestIdx = i;
    }
  }
  return { idx: bestIdx, dist: best };
}

export function nearestLineIndexWindow(me: LatLng, line: [number, number][], start: number, end: number) {
  if (!line || line.length === 0) return null;
  const s = clamp(Math.floor(start), 0, line.length - 1);
  const e = clamp(Math.floor(end), 0, line.length - 1);
  const a = Math.min(s, e);
  const b = Math.max(s, e);

  let best = Infinity;
  let bestIdx = a;

  for (let i = a; i <= b; i++) {
    const d = haversineMeters(me, { lat: line[i][0], lng: line[i][1] });
    if (d < best) {
      best = d;
      bestIdx = i;
    }
  }
  return { idx: bestIdx, dist: best };
}

export function projectPointOnSegment(originLat: number, p: LatLng, a: LatLng, b: LatLng) {
  const P = projectMeters(originLat, p);
  const A = projectMeters(originLat, a);
  const B = projectMeters(originLat, b);

  const ABx = B.x - A.x;
  const ABy = B.y - A.y;
  const APx = P.x - A.x;
  const APy = P.y - A.y;

  const denom = ABx * ABx + ABy * ABy;
  if (denom <= 1e-9) {
    return {
      point: a,
      t: 0,
      dist: Math.hypot(P.x - A.x, P.y - A.y),
    };
  }

  const t = clamp((APx * ABx + APy * ABy) / denom, 0, 1);
  const cx = A.x + t * ABx;
  const cy = A.y + t * ABy;

  return {
    point: unprojectMeters(originLat, cx, cy),
    t,
    dist: Math.hypot(P.x - cx, P.y - cy),
  };
}

export function snapPointToPolyline(
  me: LatLng,
  line: [number, number][],
  startIdx = 0,
  endIdx = Math.max(0, line.length - 1)
) {
  if (!line || line.length < 2) return null;

  const s = clamp(Math.floor(startIdx), 0, line.length - 2);
  const e = clamp(Math.floor(endIdx), 1, line.length - 1);
  const a = Math.min(s, e - 1);
  const b = Math.max(s + 1, e);

  let best: {
    point: LatLng;
    dist: number;
    segIdx: number;
    t: number;
  } | null = null;

  for (let i = a; i < b; i++) {
    const A = { lat: line[i][0], lng: line[i][1] };
    const B = { lat: line[i + 1][0], lng: line[i + 1][1] };
    const pr = projectPointOnSegment(me.lat, me, A, B);

    if (!best || pr.dist < best.dist) {
      best = {
        point: pr.point,
        dist: pr.dist,
        segIdx: i,
        t: pr.t,
      };
    }
  }

  if (!best) return null;

  return {
    point: best.point,
    dist: best.dist,
    segIdx: best.segIdx,
    approxIdx: best.segIdx + best.t,
  };
}

export function movePointMeters(p: LatLng, bearingDegValue: number, meters: number): LatLng {
  const R = 6371000;
  const br = (bearingDegValue * Math.PI) / 180;
  const lat1 = (p.lat * Math.PI) / 180;
  const lon1 = (p.lng * Math.PI) / 180;
  const d = meters / R;

  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
  const lon2 =
    lon1 +
    Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));

  return {
    lat: (lat2 * 180) / Math.PI,
    lng: (lon2 * 180) / Math.PI,
  };
}

export function interpolateLatLng(a: LatLng, b: LatLng, t: number): LatLng {
  const tt = clamp(t, 0, 1);
  return {
    lat: a.lat + (b.lat - a.lat) * tt,
    lng: a.lng + (b.lng - a.lng) * tt,
  };
}

export function advanceAlongPolyline(
  line: [number, number][],
  approxIdx: number,
  metersAhead: number
): { point: LatLng; approxIdx: number } | null {
  if (!line || line.length < 2) return null;

  const idx = clamp(approxIdx, 0, line.length - 1);
  let i = Math.floor(idx);
  const frac = idx - i;

  if (i >= line.length - 1) {
    const last = line[line.length - 1];
    return { point: { lat: last[0], lng: last[1] }, approxIdx: line.length - 1 };
  }

  let remaining = Math.max(0, metersAhead);

  let a: LatLng = { lat: line[i][0], lng: line[i][1] };
  let b: LatLng = { lat: line[i + 1][0], lng: line[i + 1][1] };

  let segLen = haversineMeters(a, b);
  if (segLen < 0.01) segLen = 0.01;

  const onSeg = interpolateLatLng(a, b, frac);
  const distLeftOnSeg = haversineMeters(onSeg, b);

  if (remaining <= distLeftOnSeg) {
    const t = frac + (1 - frac) * (remaining / distLeftOnSeg || 0);
    return { point: interpolateLatLng(a, b, t), approxIdx: i + t };
  }

  remaining -= distLeftOnSeg;
  i += 1;

  while (i < line.length - 1) {
    a = { lat: line[i][0], lng: line[i][1] };
    b = { lat: line[i + 1][0], lng: line[i + 1][1] };
    segLen = haversineMeters(a, b);

    if (segLen < 0.01) {
      i += 1;
      continue;
    }

    if (remaining <= segLen) {
      const t = remaining / segLen;
      return { point: interpolateLatLng(a, b, t), approxIdx: i + t };
    }

    remaining -= segLen;
    i += 1;
  }

  const last = line[line.length - 1];
  return { point: { lat: last[0], lng: last[1] }, approxIdx: line.length - 1 };
}

export function wrap360(deg: number) {
  let d = deg % 360;
  if (d < 0) d += 360;
  return d;
}

export function bearingDeg(a: LatLng, b: LatLng) {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;

  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lng - a.lng);

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

  let brng = toDeg(Math.atan2(y, x));
  brng = (brng + 360) % 360;
  return brng;
}

export function smoothAngle(prev: number, next: number) {
  const delta = ((next - prev + 540) % 360) - 180;
  return prev + delta;
}
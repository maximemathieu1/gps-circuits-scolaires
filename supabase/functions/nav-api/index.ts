import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

function cors(req: Request) {
  const origin = req.headers.get("origin") ?? "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers":
      "authorization, apikey, x-app-key, x-client-info, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(req: Request, status: number, data: unknown) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
  });
}

function getEnv(name: string) {
  const v = Deno.env.get(name);
  if (!v || !v.trim()) throw new Error(`${name} manquant`);
  return v.trim();
}

const APP_KEY = getEnv("APP_KEY");
const MAPBOX_TOKEN = getEnv("MAPBOX_TOKEN");

type Req = {
  action: "route";
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: cors(req) });

  try {
    const key = req.headers.get("x-app-key") ?? "";
    if (key !== APP_KEY) return json(req, 401, { error: "Unauthorized" });

    const body = (await req.json()) as Req;
    if (body.action !== "route") return json(req, 400, { error: "Action inconnue" });

    const { from, to } = body;

    const url =
      `https://api.mapbox.com/directions/v5/mapbox/driving/` +
      `${from.lng},${from.lat};${to.lng},${to.lat}` +
      `?geometries=geojson&steps=true&overview=full&language=fr&access_token=${encodeURIComponent(MAPBOX_TOKEN)}`;

    const r = await fetch(url);
    const data = await r.json();

    if (!r.ok) return json(req, 400, { error: data?.message ?? "Mapbox error" });

    const route = data?.routes?.[0];
    const leg = route?.legs?.[0];

    const steps = (leg?.steps ?? []).map((s: any) => ({
      distance: s.distance,
      duration: s.duration,
      name: s.name,
      instruction: s.maneuver?.instruction ?? "",
      type: s.maneuver?.type ?? "",
      modifier: s.maneuver?.modifier ?? "",
      location: { lng: s.maneuver?.location?.[0], lat: s.maneuver?.location?.[1] },
    }));

    return json(req, 200, {
      distance: route?.distance ?? 0,
      duration: route?.duration ?? 0,
      geometry: route?.geometry ?? null,
      steps,
    });
  } catch (e: any) {
    return json(req, 500, { error: String(e?.message ?? e) });
  }
});

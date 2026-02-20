import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function cors(req: Request) {
  const origin = req.headers.get("origin") ?? "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "authorization, apikey, x-app-key, x-client-info, content-type",
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

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function isFiniteNumber(n: any) {
  return typeof n === "number" && Number.isFinite(n);
}

function validLatLng(lat: any, lng: any) {
  return isFiniteNumber(lat) && isFiniteNumber(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

const APP_KEY = getEnv("APP_KEY");
const SERVICE_ROLE = getEnv("SERVICE_ROLE_KEY");

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")?.trim();
if (!SUPABASE_URL) throw new Error("SUPABASE_URL introuvable dans l'environnement Edge");

// ✅ Service role (bypass RLS) — mais on garde APP_KEY pour bloquer l’accès public
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

type TCode = "B" | "C" | "S";

type Req =
  | { action: "list_circuits"; transporteur_code: TCode }
  | { action: "create_circuit"; transporteur_code: TCode; nom: string; created_by?: string; user_id?: string }
  | { action: "rename_circuit"; circuit_id: string; nom: string }
  | { action: "start_update"; circuit_id: string; note?: string }
  | { action: "get_active_version"; circuit_id: string }
  | { action: "get_active_points"; circuit_id: string }
  | { action: "get_points_by_version"; version_id: string }
  | { action: "add_point"; version_id: string; lat: number; lng: number; label?: string | null }
  | { action: "delete_last_point"; version_id: string }
  // ✅ NOUVEAU : trace officielle (polyline)
  | { action: "save_trace"; version_id: string; trail: { idx: number; lat: number; lng: number }[] }
  | { action: "get_latest_trace"; circuit_id: string };

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: cors(req) });

  try {
    const key = req.headers.get("x-app-key") ?? "";
    if (key !== APP_KEY) return json(req, 401, { error: "Unauthorized" });

    const body = (await req.json()) as Req;

    if (body.action === "list_circuits") {
      const { data, error } = await supabase
        .from("circuits")
        .select("id, nom, actif, created_at")
        .eq("transporteur_code", body.transporteur_code)
        .eq("actif", true)
        .order("nom", { ascending: true });

      if (error) return json(req, 400, { error: error.message });
      return json(req, 200, { circuits: data ?? [] });
    }

    if (body.action === "create_circuit") {
      const nom = (body.nom ?? "").trim();
      if (!nom) return json(req, 400, { error: "Nom requis" });

      const createdBy = (body.created_by ?? body.user_id ?? "").trim();
      if (!createdBy || !isUuid(createdBy)) {
        return json(req, 400, {
          error: "Utilisateur non connecté (created_by manquant/invalide). Connecte-toi puis réessaie.",
        });
      }

      const { data: c, error: e1 } = await supabase
        .from("circuits")
        .insert({
          transporteur_code: body.transporteur_code,
          nom,
          created_by: createdBy,
        })
        .select("id")
        .single();

      if (e1 || !c) return json(req, 400, { error: e1?.message ?? "Erreur create_circuit" });

      const { data: v, error: e2 } = await supabase
        .from("circuit_versions")
        .insert({
          circuit_id: c.id,
          version_no: 1,
          is_active: true,
          note: "Version 1",
          created_by: createdBy,
        })
        .select("id, version_no")
        .single();

      if (e2 || !v) return json(req, 400, { error: e2?.message ?? "Erreur create_version" });

      return json(req, 200, { circuit_id: c.id, version_id: v.id, version_no: v.version_no });
    }

    if (body.action === "rename_circuit") {
      const nom = (body.nom ?? "").trim();
      if (!nom) return json(req, 400, { error: "Nom requis" });

      const circuit_id = String(body.circuit_id ?? "").trim();
      if (!isUuid(circuit_id)) return json(req, 400, { error: "circuit_id invalide" });

      const { error } = await supabase.from("circuits").update({ nom }).eq("id", circuit_id);
      if (error) return json(req, 400, { error: error.message });

      return json(req, 200, { ok: true });
    }

    if (body.action === "start_update") {
      const circuit_id = String(body.circuit_id ?? "").trim();
      if (!isUuid(circuit_id)) return json(req, 400, { error: "circuit_id invalide" });

      const { data: cir, error: eCir } = await supabase.from("circuits").select("created_by").eq("id", circuit_id).single();
      if (eCir) return json(req, 400, { error: eCir.message });

      const createdBy = String((cir as any)?.created_by ?? "").trim();
      if (!createdBy) return json(req, 400, { error: "created_by introuvable pour ce circuit" });

      const { data: rows, error: eMax } = await supabase
        .from("circuit_versions")
        .select("version_no")
        .eq("circuit_id", circuit_id)
        .order("version_no", { ascending: false })
        .limit(1);

      if (eMax) return json(req, 400, { error: eMax.message });

      const maxNo = rows?.[0]?.version_no ?? 0;
      const nextNo = maxNo + 1;

      const { error: eOff } = await supabase.from("circuit_versions").update({ is_active: false }).eq("circuit_id", circuit_id);
      if (eOff) return json(req, 400, { error: eOff.message });

      const { data: v, error: eNew } = await supabase
        .from("circuit_versions")
        .insert({
          circuit_id,
          version_no: nextNo,
          is_active: true,
          note: body.note ?? null,
          created_by: createdBy,
        })
        .select("id, version_no")
        .single();

      if (eNew || !v) return json(req, 400, { error: eNew?.message ?? "Erreur start_update" });

      return json(req, 200, { version_id: v.id, version_no: v.version_no });
    }

    if (body.action === "get_active_version") {
      const circuit_id = String(body.circuit_id ?? "").trim();
      if (!isUuid(circuit_id)) return json(req, 400, { error: "circuit_id invalide" });

      const { data: v, error } = await supabase
        .from("circuit_versions")
        .select("id, version_no")
        .eq("circuit_id", circuit_id)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) return json(req, 400, { error: error.message });
      if (!v?.id) return json(req, 404, { error: "Aucune version active" });

      return json(req, 200, { version_id: v.id, version_no: v.version_no });
    }

    if (body.action === "get_active_points") {
      const circuit_id = String(body.circuit_id ?? "").trim();
      console.log("get_active_points", { circuit_id });

      if (!isUuid(circuit_id)) return json(req, 400, { error: "circuit_id invalide", circuit_id });

      const { data: activeV, error: eV } = await supabase
        .from("circuit_versions")
        .select("id, created_at")
        .eq("circuit_id", circuit_id)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (eV) return json(req, 400, { error: eV.message });

      const { data: v, error: eLast } = activeV?.id
        ? { data: activeV, error: null }
        : await supabase
            .from("circuit_versions")
            .select("id, created_at")
            .eq("circuit_id", circuit_id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

      if (eLast) return json(req, 400, { error: eLast.message });

      if (!v?.id) return json(req, 404, { error: "Aucune version pour ce circuit", circuit_id });

      const { data: pts, error: eP } = await supabase
        .from("circuit_points")
        .select("idx, lat, lng, label, created_at")
        .eq("version_id", v.id)
        .order("idx", { ascending: true });

      if (eP) return json(req, 400, { error: eP.message });

      return json(req, 200, { version_id: v.id, points: pts ?? [] });
    }

    if (body.action === "get_points_by_version") {
      const version_id = String(body.version_id ?? "").trim();
      if (!isUuid(version_id)) return json(req, 400, { error: "version_id invalide" });

      const { data: pts, error } = await supabase
        .from("circuit_points")
        .select("idx, lat, lng, label, created_at")
        .eq("version_id", version_id)
        .order("idx", { ascending: true });

      if (error) return json(req, 400, { error: error.message });

      return json(req, 200, { points: pts ?? [] });
    }

    if (body.action === "add_point") {
      const version_id = String(body.version_id ?? "").trim();
      if (!isUuid(version_id)) return json(req, 400, { error: "version_id invalide" });

      if (!validLatLng(body.lat, body.lng)) return json(req, 400, { error: "lat/lng invalides" });

      const { data: last, error: eLast } = await supabase
        .from("circuit_points")
        .select("idx")
        .eq("version_id", version_id)
        .order("idx", { ascending: false })
        .limit(1);

      if (eLast) return json(req, 400, { error: eLast.message });

      const nextIdx = (last?.[0]?.idx ?? 0) + 1;

      const { error } = await supabase.from("circuit_points").insert({
        version_id,
        idx: nextIdx,
        lat: body.lat,
        lng: body.lng,
        label: body.label ?? null,
      });

      if (error) return json(req, 400, { error: error.message });

      return json(req, 200, { ok: true, idx: nextIdx });
    }

    if (body.action === "delete_last_point") {
      const version_id = String(body.version_id ?? "").trim();
      if (!isUuid(version_id)) return json(req, 400, { error: "version_id invalide" });

      const { data: last, error: eLast } = await supabase
        .from("circuit_points")
        .select("id, idx")
        .eq("version_id", version_id)
        .order("idx", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (eLast) return json(req, 400, { error: eLast.message });
      if (!last?.id) return json(req, 200, { ok: true, deleted: false });

      const { error: eDel } = await supabase.from("circuit_points").delete().eq("id", last.id);
      if (eDel) return json(req, 400, { error: eDel.message });

      return json(req, 200, { ok: true, deleted: true, idx: last.idx });
    }

    /* ==========================
       ✅ NOUVEAU : SAVE TRACE
    =========================== */
    if (body.action === "save_trace") {
      const version_id = String(body.version_id ?? "").trim();
      if (!isUuid(version_id)) return json(req, 400, { error: "version_id invalide" });

      const trail = Array.isArray((body as any).trail) ? (body as any).trail : [];
      if (!Array.isArray(trail) || trail.length < 10) return json(req, 400, { error: "trail manquant ou trop court" });

      // Validation + normalisation
      const normalized: { idx: number; lat: number; lng: number }[] = [];
      for (let i = 0; i < trail.length; i++) {
        const p = trail[i];
        const lat = p?.lat;
        const lng = p?.lng;
        if (!validLatLng(lat, lng)) continue;
        normalized.push({ idx: Number.isFinite(p?.idx) ? Number(p.idx) : i, lat, lng });
      }

      if (normalized.length < 10) return json(req, 400, { error: "trail invalide (pas assez de points valides)" });

      // Retrouver created_by depuis la version (NOT NULL dans circuit_traces)
      const { data: v, error: eV } = await supabase
        .from("circuit_versions")
        .select("created_by")
        .eq("id", version_id)
        .single();

      if (eV) return json(req, 400, { error: eV.message });

      const createdBy = String((v as any)?.created_by ?? "").trim();
      if (!createdBy || !isUuid(createdBy)) return json(req, 400, { error: "created_by introuvable pour cette version" });

      // Upsert (version_id unique)
      const { error: eUp } = await supabase
        .from("circuit_traces")
        .upsert(
          {
            version_id,
            trail: normalized,
            points_count: normalized.length,
            created_by: createdBy,
          },
          { onConflict: "version_id" }
        );

      if (eUp) return json(req, 400, { error: eUp.message });

      return json(req, 200, { ok: true, version_id, points_saved: normalized.length });
    }

    /* ==========================
       ✅ NOUVEAU : GET LATEST TRACE
    =========================== */
    if (body.action === "get_latest_trace") {
      const circuit_id = String(body.circuit_id ?? "").trim();
      if (!isUuid(circuit_id)) return json(req, 400, { error: "circuit_id invalide" });

      // 1) version active
      const { data: activeV, error: eV } = await supabase
        .from("circuit_versions")
        .select("id, created_at")
        .eq("circuit_id", circuit_id)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (eV) return json(req, 400, { error: eV.message });

      // 2) fallback dernière version
      const { data: v, error: eLast } = activeV?.id
        ? { data: activeV, error: null }
        : await supabase
            .from("circuit_versions")
            .select("id, created_at")
            .eq("circuit_id", circuit_id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

      if (eLast) return json(req, 400, { error: eLast.message });
      if (!v?.id) return json(req, 404, { error: "Aucune version pour ce circuit" });

      // 3) trace pour cette version
      const { data: tr, error: eTr } = await supabase
        .from("circuit_traces")
        .select("version_id, trail, points_count, updated_at")
        .eq("version_id", v.id)
        .maybeSingle();

      if (eTr) return json(req, 400, { error: eTr.message });
      if (!tr?.trail) return json(req, 404, { error: "Aucune trace enregistrée pour la version active" });

      return json(req, 200, {
        version_id: tr.version_id,
        points_count: tr.points_count ?? (Array.isArray(tr.trail) ? tr.trail.length : 0),
        trail: tr.trail,
        updated_at: tr.updated_at,
      });
    }

    return json(req, 400, { error: "Action inconnue" });
  } catch (e: any) {
    return json(req, 500, { error: String(e?.message ?? e) });
  }
});
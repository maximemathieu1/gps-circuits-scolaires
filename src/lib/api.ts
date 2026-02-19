import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const APP_KEY = import.meta.env.VITE_APP_KEY as string;

if (!SUPABASE_URL || !ANON_KEY) {
  throw new Error("VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY manquants");
}

/** ✅ Client Supabase Auth (pour login/session) */
export const supabase = createClient(SUPABASE_URL, ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

function fnUrl(name: string) {
  return `${SUPABASE_URL}/functions/v1/${name}`;
}

/**
 * Appels Edge Functions (comme avant).
 * NOTE: on garde tes headers x-app-key + apikey.
 */
export async function callFn<T>(
  fnName: "circuits-api" | "nav-api",
  payload: any
): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: ANON_KEY,
    "x-app-key": APP_KEY,
  };

  // ✅ seulement si user connecté
  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  const r = await fetch(fnUrl(fnName), {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const dataJson = await r.json().catch(() => ({}));
  if (!r.ok)
    throw new Error(
      (dataJson as any)?.error ??
        (dataJson as any)?.message ??
        `HTTP ${r.status}`
    );

  return dataJson as T;
}


const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const APP_KEY = import.meta.env.VITE_APP_KEY;

function fnUrl(name: string) {
  return `${SUPABASE_URL}/functions/v1/${name}`;
}

export async function callFn<T>(fnName: "circuits-api" | "nav-api", payload: any): Promise<T> {
  const r = await fetch(fnUrl(fnName), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ANON_KEY}`,
      apikey: ANON_KEY,
      "x-app-key": APP_KEY,
    },
    body: JSON.stringify(payload),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as any)?.error ?? (data as any)?.message ?? `HTTP ${r.status}`);
  return data as T;
}

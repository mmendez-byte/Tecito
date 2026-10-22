import type { Env, Origen, Session } from "./types";

const SESSION_TTL_SECONDS = 60 * 60 * 24; // 24 h
const TOKEN_TTL_SECONDS = 60 * 60 * 6; // el token firmado vive 6 h

// ---------- Origen del visitante ----------

export function parseOrigen(input: { url?: string; referrer?: string }): Origen {
  let u: URL | null = null;
  try {
    u = input.url ? new URL(input.url) : null;
  } catch {
    u = null;
  }
  const q = u?.searchParams;
  const get = (k: string) => (q?.get(k) ?? "").slice(0, 200);
  const referrer = (input.referrer ?? "").slice(0, 500);
  const gclid = get("gclid");
  const utm_source = get("utm_source");
  const utm_medium = get("utm_medium");
  const utm_campaign = get("utm_campaign");
  const linea = get("linea");

  let canal: Origen["canal"] = "otro";
  if (gclid || utm_medium.toLowerCase() === "cpc" || utm_source.toLowerCase().includes("google")) {
    canal = "campaña";
  } else if (u && /\/blog\//i.test(u.pathname)) {
    canal = "blog";
  } else if (/google\.|bing\.|duckduckgo\./i.test(referrer)) {
    canal = "orgánico";
  } else if (!referrer) {
    canal = "directo";
  }

  return {
    url: (input.url ?? "").slice(0, 500),
    referrer,
    gclid,
    utm_source,
    utm_medium,
    utm_campaign,
    linea,
    canal,
  };
}

// ---------- Token firmado (HMAC) ----------

async function hmac(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function signSession(env: Env, sessionId: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const payload = `${sessionId}.${exp}`;
  const sig = await hmac(env.SESSION_SIGNING_KEY, payload);
  return `${payload}.${sig}`;
}

export async function verifySession(env: Env, token: string): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [sessionId, expStr, sig] = parts;
  if (Number(expStr) < Math.floor(Date.now() / 1000)) return null;
  const expected = await hmac(env.SESSION_SIGNING_KEY, `${sessionId}.${expStr}`);
  return expected === sig ? sessionId : null;
}

// ---------- KV ----------

export async function createSession(env: Env, origen: Origen): Promise<Session> {
  const session: Session = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    origen,
    messages: [],
    tokensUsed: 0,
    costUsd: 0,
  };
  await saveSession(env, session);
  return session;
}

export async function loadSession(env: Env, id: string): Promise<Session | null> {
  return env.SESSIONS.get<Session>(`session:${id}`, "json");
}

export async function saveSession(env: Env, session: Session): Promise<void> {
  await env.SESSIONS.put(`session:${session.id}`, JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
}

/** Resumen por sesión para leer después dónde se cae la gente. Vive 90 días. */
export async function recordSessionSummary(env: Env, session: Session): Promise<void> {
  const day = session.createdAt.slice(0, 10);
  await env.METRICS.put(
    `summary:${day}:${session.id}`,
    JSON.stringify({
      canal: session.origen.canal,
      linea: session.origen.linea,
      campaign: session.origen.utm_campaign,
      mensajes: session.messages.filter((m) => m.role === "user").length,
      calificacion: session.lead?.calificacion ?? null,
      whatsapp: session.whatsappClicked ?? false,
      costUsd: Number(session.costUsd.toFixed(4)),
    }),
    { expirationTtl: 60 * 60 * 24 * 90 },
  );
}

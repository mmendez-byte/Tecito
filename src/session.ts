import type { Env, Origen, Session } from "./types";

const SESSION_TTL_SECONDS = 60 * 60 * 24; // 24 h
const TOKEN_TTL_SECONDS = 60 * 60 * 6; // el token firmado vive 6 h

// ---------- Origen del visitante ----------

const MEDIOS_PAGOS = /^(cpc|ppc|paid|paid[_-]?search|paid[_-]?social|display|cpm|cpv|ads?)$/;

/**
 * `url` y `referrer` son los de la entrada al sitio (el widget los guarda al cargar la primera página),
 * `pagina` es donde se abrió el chat. Así un clic de anuncio que navega antes de abrir el chat
 * no pierde el gclid.
 */
export function parseOrigen(input: { url?: string; referrer?: string; pagina?: string }): Origen {
  const entrada = parseUrl(input.url);
  const pagina = parseUrl(input.pagina) ?? entrada;
  const q = entrada?.searchParams;
  const get = (k: string) => (q?.get(k) ?? "").slice(0, 200);
  const referrer = (input.referrer ?? "").slice(0, 500);
  const gclid = get("gclid");
  const utm_source = get("utm_source");
  const utm_medium = get("utm_medium");
  const utm_campaign = get("utm_campaign");
  // La línea es la de la página donde abrió el chat; si no tiene, la de la entrada.
  const linea = (pagina?.searchParams.get("linea") ?? "").slice(0, 200) || get("linea");

  // gbraid/wbraid: Google los usa en lugar del gclid en clics desde iOS. fbclid lo agrega Meta a
  // cualquier link (también publicaciones orgánicas), así que solo marca la plataforma.
  const src = utm_source.toLowerCase();
  const medium = utm_medium.toLowerCase();
  const clicGoogle = Boolean(gclid || get("gbraid") || get("wbraid"));
  const clicMicrosoft = Boolean(get("msclkid"));
  const clicLinkedin = Boolean(get("li_fat_id"));

  let plataforma: Origen["plataforma"] = "";
  if (clicGoogle || src.includes("google")) plataforma = "google";
  else if (get("fbclid") || /facebook|instagram|meta|^fb$|^ig$/.test(src)) plataforma = "meta";
  else if (clicMicrosoft || /bing|microsoft/.test(src)) plataforma = "microsoft";
  else if (clicLinkedin || src.includes("linkedin")) plataforma = "linkedin";

  const pagado =
    clicGoogle || clicMicrosoft || clicLinkedin || MEDIOS_PAGOS.test(medium) || (src.includes("google") && medium !== "organic");

  let canal: Origen["canal"] = "otro";
  if (pagado) {
    canal = "campaña";
  } else if (entrada && /\/blog\//i.test(entrada.pathname)) {
    canal = "blog";
  } else if (/google\.|bing\.|duckduckgo\./i.test(referrer)) {
    canal = "orgánico";
  } else if (!referrer) {
    canal = "directo";
  }

  return {
    url: (input.url ?? "").slice(0, 500),
    referrer,
    pagina: (input.pagina ?? input.url ?? "").slice(0, 500),
    gclid,
    utm_source,
    utm_medium,
    utm_campaign,
    utm_term: get("utm_term"),
    utm_content: get("utm_content"),
    linea,
    canal,
    plataforma,
  };
}

function parseUrl(s: string | undefined): URL | null {
  try {
    return s ? new URL(s) : null;
  } catch {
    return null;
  }
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

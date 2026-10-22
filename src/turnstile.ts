import type { Env } from "./types";

/**
 * Valida el token de Turnstile que manda el widget al abrir sesión.
 * En dev/staging, si no hay secreto configurado, deja pasar y lo loguea.
 */
export async function verifyTurnstile(env: Env, token: string | undefined, ip: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) {
    if (env.ENVIRONMENT === "production") return false;
    console.warn("TURNSTILE_SECRET no configurado; se omite la verificación en", env.ENVIRONMENT);
    return true;
  }
  if (!token) return false;

  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET);
  body.append("response", token);
  if (ip) body.append("remoteip", ip);

  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body,
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { success: boolean };
  return data.success === true;
}

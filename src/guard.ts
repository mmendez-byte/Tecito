import type { Env, Session } from "./types";

/**
 * Capas de protección que corren ANTES de gastar un token:
 *  - filtro de mensaje (vacío, repetido, no español, intento de extraer el prompt)
 *  - tope de tokens por sesión
 *  - presupuesto diario y mensual (contadores en KV)
 *  - kill switch manual (clave KV `killswitch` = "1")
 *
 * El rate limiting por IP se configura en Cloudflare (WAF > Rate limiting rules),
 * no acá: 10 req/min y 40 req/h a /message. Ver README.
 */

export type GuardResult =
  | { ok: true }
  | { ok: false; reason: "empty" | "repeated" | "language" | "injection" | "session_cap" | "budget" | "killswitch"; message: string };

const DERIVAR = "Para continuar con su consulta, le comunico con Jackeline, nuestra asesora comercial. Toque el botón de WhatsApp.";

export async function guardMessage(env: Env, session: Session, text: string): Promise<GuardResult> {
  const clean = text.trim();

  if (!clean || clean.length < 2) {
    return { ok: false, reason: "empty", message: "Cuénteme qué equipo necesita calibrar y en qué ciudad se encuentra." };
  }
  if (clean.length > 2000) {
    return { ok: false, reason: "empty", message: "El mensaje es muy largo. ¿Puede resumirlo en un par de líneas?" };
  }

  const last = [...session.messages].reverse().find((m) => m.role === "user");
  if (last && last.content.trim() === clean) {
    return { ok: false, reason: "repeated", message: "Ya recibí ese mensaje. ¿Desea agregar algo más?" };
  }

  if (looksLikeInjection(clean)) {
    return { ok: false, reason: "injection", message: "Soy Tecito, el asistente de Test & Control. Puedo ayudarle con la calibración de sus equipos. ¿Qué necesita?" };
  }

  if (!looksSpanish(clean)) {
    return { ok: false, reason: "language", message: "Por ahora solo atiendo en español. ¿Me indica en español qué equipo necesita calibrar?" };
  }

  if (session.tokensUsed > Number(env.MAX_TOKENS_PER_SESSION)) {
    return { ok: false, reason: "session_cap", message: DERIVAR };
  }

  if ((await env.METRICS.get("killswitch")) === "1") {
    return { ok: false, reason: "killswitch", message: DERIVAR };
  }

  const budget = await checkBudget(env);
  if (!budget.ok) {
    return { ok: false, reason: "budget", message: DERIVAR };
  }

  return { ok: true };
}

function looksLikeInjection(t: string): boolean {
  const s = t.toLowerCase();
  const patterns = [
    /system prompt/,
    /ignor(a|e|á) (todas )?las instrucciones/,
    /ignore (all )?(previous|prior) instructions/,
    /repeat (the|your) (instructions|prompt)/,
    /mostr(a|á|ame) (tu|el) prompt/,
    /act(ú|u)a como/,
    /you are now/,
    /jailbreak/,
  ];
  return patterns.some((p) => p.test(s));
}

function looksSpanish(t: string): boolean {
  // Heurística barata: letras latinas y algo que parezca castellano o un sustantivo de equipo.
  if (!/[a-záéíóúñü]/i.test(t)) return false;
  if (/[Ѐ-ӿ一-鿿؀-ۿ]/.test(t)) return false;
  const words = t.toLowerCase().split(/\s+/);
  if (words.length <= 3) return true; // "manómetro lima", "hola" etc.
  const es = /\b(el|la|los|las|de|que|y|en|un|una|para|por|con|necesito|quiero|calibrar|equipo|cuánto|hola|buenas|tengo|se|es|no|si|mi|nos)\b/;
  const en = /\b(the|and|with|need|want|please|how|much|you|is|are|we|our)\b/;
  const esHits = words.filter((w) => es.test(w)).length;
  const enHits = words.filter((w) => en.test(w)).length;
  return esHits >= enHits;
}

// ---------- Presupuesto ----------

function keys(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  return { day: `spend:day:${day}`, month: `spend:month:${month}` };
}

export async function checkBudget(env: Env): Promise<{ ok: boolean; day: number; month: number }> {
  const k = keys();
  const [d, m] = await Promise.all([env.METRICS.get(k.day), env.METRICS.get(k.month)]);
  const day = Number(d ?? 0);
  const month = Number(m ?? 0);
  const ok = day < Number(env.DAILY_BUDGET_USD) && month < Number(env.MONTHLY_BUDGET_USD);
  return { ok, day, month };
}

/**
 * Suma el costo de una llamada a los contadores. KV no es atómico: con el volumen
 * de Tecito (decenas de conversaciones por día) la pérdida eventual de un incremento
 * es tolerable; el tope duro lo pone de todos modos el workspace de la Console.
 */
export async function recordSpend(env: Env, usd: number): Promise<void> {
  const k = keys();
  const [d, m] = await Promise.all([env.METRICS.get(k.day), env.METRICS.get(k.month)]);
  await Promise.all([
    env.METRICS.put(k.day, String(Number(d ?? 0) + usd), { expirationTtl: 60 * 60 * 24 * 40 }),
    env.METRICS.put(k.month, String(Number(m ?? 0) + usd), { expirationTtl: 60 * 60 * 24 * 400 }),
  ]);
}

/** Precios USD por millón de tokens (oct 2026). Ajustar acá si cambian. */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
};

export function estimateCost(
  model: string,
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number },
): number {
  const p = PRICES[model] ?? PRICES["claude-sonnet-5-5"];
  const M = 1_000_000;
  return (
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      (usage.cache_read_input_tokens ?? 0) * p.cacheRead +
      (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite) /
    M
  );
}

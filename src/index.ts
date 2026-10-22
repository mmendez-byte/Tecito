import demoHtml from "../widget/demo.html";
import widgetCss from "../widget/widget.css";
import widgetJs from "../widget/widget.js";
import { aplicarAlcance } from "./alcance";
import { chat, validarLead } from "./claude";
import { checkBudget, estimateCost, guardMessage, recordSpend } from "./guard";
import { encolarLead, linkWhatsapp, textoWhatsapp } from "./lead";
import { enviarAlerta } from "./mail";
import { consumirLeads } from "./queue";
import { createSession, loadSession, parseOrigen, recordSessionSummary, saveSession, signSession, verifySession } from "./session";
import { verifyTurnstile } from "./turnstile";
import type { Env, LeadMessage } from "./types";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(env, request);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      switch (url.pathname) {
        case "/health":
          return json({ ok: true, env: env.ENVIRONMENT }, cors);
        case "/widget.js":
          return asset(widgetJs, "application/javascript; charset=utf-8", url, env);
        case "/demo":
          return asset(demoHtml.replace("./widget.js", "/widget.js"), "text/html; charset=utf-8", url, env);
        case "/widget.css":
          return asset(widgetCss, "text/css; charset=utf-8", url, env);
        case "/session":
          if (request.method !== "POST") return methodNotAllowed(cors);
          return handleSession(request, env, cors);
        case "/message":
          if (request.method !== "POST") return methodNotAllowed(cors);
          return handleMessage(request, env, ctx, cors);
        case "/whatsapp-click":
          if (request.method !== "POST") return methodNotAllowed(cors);
          return handleWhatsappClick(request, env, ctx, cors);
        default:
          return new Response("Not found", { status: 404, headers: cors });
      }
    } catch (e) {
      console.error(e);
      return json({ error: "internal" }, cors, 500);
    }
  },

  async queue(batch: MessageBatch<LeadMessage>, env: Env): Promise<void> {
    await consumirLeads(batch, env);
  },
} satisfies ExportedHandler<Env, LeadMessage>;

// ---------- /session ----------

async function handleSession(request: Request, env: Env, cors: Headers): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { url?: string; referrer?: string; turnstile?: string };
  const ip = request.headers.get("cf-connecting-ip") ?? "";

  if (!(await verifyTurnstile(env, body.turnstile, ip))) {
    return json({ error: "turnstile" }, cors, 403);
  }

  const budget = await checkBudget(env);
  const killed = (await env.METRICS.get("killswitch")) === "1";
  const session = await createSession(env, parseOrigen(body));
  const token = await signSession(env, session.id);

  return json(
    {
      token,
      sessionId: session.id,
      enabled: budget.ok && !killed,
      whatsapp: `https://wa.me/${env.WHATSAPP_NUMBER}`,
      linea: session.origen.linea,
    },
    cors,
  );
}

// ---------- /message (SSE) ----------

async function handleMessage(request: Request, env: Env, ctx: ExecutionContext, cors: Headers): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { token?: string; text?: string };
  const sessionId = body.token ? await verifySession(env, body.token) : null;
  if (!sessionId) return json({ error: "unauthorized" }, cors, 401);

  const session = await loadSession(env, sessionId);
  if (!session) return json({ error: "session_expired" }, cors, 410);

  const text = (body.text ?? "").toString();
  const guard = await guardMessage(env, session, text);

  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (event: string, data: unknown) => writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  const headers = new Headers(cors);
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-cache");

  if (!guard.ok) {
    ctx.waitUntil(
      (async () => {
        await send("text", { delta: guard.message });
        if (guard.reason === "budget" || guard.reason === "killswitch" || guard.reason === "session_cap") {
          await send("handoff", { whatsapp: `https://wa.me/${env.WHATSAPP_NUMBER}`, text: "" });
        }
        await send("done", { reason: guard.reason });
        await writer.close();
      })(),
    );
    return new Response(readable, { headers });
  }

  session.messages.push({ role: "user", content: text.trim() });

  ctx.waitUntil(
    (async () => {
      try {
        const result = await chat(env, session.origen, session.messages, (delta) => {
          void send("text", { delta });
        });

        let cost = estimateCost(env.MODEL_CHAT, result.usage);
        session.tokensUsed += result.usage.input_tokens + result.usage.output_tokens;
        if (result.text) session.messages.push({ role: "assistant", content: result.text });

        if (result.lead && !session.lead) {
          let lead = aplicarAlcance(result.lead);

          if (lead.calificacion === "CALIFICA") {
            try {
              const v = await validarLead(env, lead, session.messages);
              lead = aplicarAlcance(v.lead);
              cost += estimateCost(env.MODEL_VALIDATE, v.usage);
              session.tokensUsed += v.usage.input_tokens + v.usage.output_tokens;
            } catch (e) {
              console.error("validación falló, se usa la ficha de Haiku", e);
            }
          }

          session.lead = lead;

          if (lead.calificacion === "CALIFICA") {
            await encolarLead(env, session, lead, session.origen);
            await send("handoff", { whatsapp: linkWhatsapp(env, lead), text: textoWhatsapp(lead), lead: publicLead(lead) });
          } else {
            await send("closed", { calificacion: lead.calificacion, motivo: lead.motivo });
          }
        }

        session.costUsd += cost;
        await Promise.all([saveSession(env, session), recordSpend(env, cost), recordSessionSummary(env, session)]);
        await send("done", { reason: "ok" });
      } catch (e) {
        console.error("chat falló", e);
        await send("error", { message: "No pude responder en este momento. Podés escribirle directo a Jackeline por WhatsApp.", whatsapp: `https://wa.me/${env.WHATSAPP_NUMBER}` });
        await enviarAlerta(env, "Fallo en /message", String(e)).catch(() => {});
      } finally {
        await writer.close().catch(() => {});
      }
    })(),
  );

  return new Response(readable, { headers });
}

// ---------- /whatsapp-click ----------

async function handleWhatsappClick(request: Request, env: Env, ctx: ExecutionContext, cors: Headers): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { token?: string };
  const sessionId = body.token ? await verifySession(env, body.token) : null;
  if (!sessionId) return json({ error: "unauthorized" }, cors, 401);
  const session = await loadSession(env, sessionId);
  if (session) {
    session.whatsappClicked = true;
    ctx.waitUntil(Promise.all([saveSession(env, session), recordSessionSummary(env, session)]));
  }
  return json({ ok: true }, cors);
}

// ---------- helpers ----------

function publicLead(l: { empresa: string; equipo: string; cantidad: string; ciudad: string; plazo: string }) {
  return { empresa: l.empresa, equipo: l.equipo, cantidad: l.cantidad, ciudad: l.ciudad, plazo: l.plazo };
}

function corsHeaders(env: Env, request: Request): Headers {
  const h = new Headers();
  const origin = request.headers.get("origin") ?? "";
  const allowed = env.ALLOWED_ORIGIN.split(",").map((s) => s.trim());
  if (allowed.includes("*") || allowed.includes(origin)) {
    h.set("access-control-allow-origin", allowed.includes("*") ? "*" : origin);
  }
  h.set("access-control-allow-methods", "GET, POST, OPTIONS");
  h.set("access-control-allow-headers", "content-type");
  h.set("vary", "origin");
  return h;
}

function json(data: unknown, cors: Headers, status = 200): Response {
  const h = new Headers(cors);
  h.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers: h });
}

function methodNotAllowed(cors: Headers): Response {
  return new Response("Method not allowed", { status: 405, headers: cors });
}

function asset(content: string, type: string, url: URL, env: Env): Response {
  // El widget necesita saber dónde está el Worker y el site key de Turnstile; se inyectan al servirlo.
  const body = content.replace(/__TECITO_BASE__/g, url.origin).replace(/__TECITO_TURNSTILE_SITEKEY__/g, env.TURNSTILE_SITEKEY ?? "");
  return new Response(body, {
    headers: {
      "content-type": type,
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}

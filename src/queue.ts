import { enviarAlerta, enviarAvisoLead } from "./mail";
import { entregaHecha, marcarEntrega } from "./registro";
import type { Env, LeadMessage } from "./types";

/**
 * Consumidor de la cola de leads. Por cada lead que califica:
 *  1. manda el mail de aviso (TES-59): va primero porque es lo que hace que el equipo comercial
 *     tome la consulta en el momento, aunque la planilla esté caída
 *  2. escribe la fila en la planilla de Jackeline (Apps Script, TES-58)
 * La fila de conversión para Ads la agrega el propio Apps Script cuando hay GCLID.
 *
 * Cada paso se marca en D1 al terminar, así un reintento hace solo lo que faltó: no duplica el mail
 * si falló la planilla ni la fila si falló el mail. Si algo falla, el mensaje se reintenta
 * (max_retries y retry_delay en wrangler.jsonc: 12 intentos cada 15 min ≈ 3 h; si se agota,
 * va a la dead letter queue y se avisa).
 */
export async function consumirLeads(batch: MessageBatch<LeadMessage>, env: Env): Promise<void> {
  for (const m of batch.messages) {
    const id = m.body.sessionId;
    const hecho = await entregaHecha(env, id);
    const errores: string[] = [];

    if (!hecho.mail) {
      try {
        await enviarAvisoLead(env, m.body);
        await marcarEntrega(env, id, "mail");
      } catch (e) {
        errores.push(`mail: ${(e as Error).message}`);
      }
    }
    if (!hecho.planilla) {
      try {
        if (await escribirPlanilla(env, m.body)) await marcarEntrega(env, id, "planilla");
      } catch (e) {
        errores.push(`planilla: ${(e as Error).message}`);
      }
    }

    if (!errores.length) {
      m.ack();
      continue;
    }
    console.error("lead falló, se reintenta", id, errores);
    if (m.attempts >= 12) {
      await enviarAlerta(env, "Lead sin registrar tras 12 intentos", `${errores.join("\n")}\n\n${JSON.stringify(m.body, null, 2)}`).catch(() => {});
    }
    m.retry();
  }
}

/** Devuelve true si escribió la fila; false si no hay planilla configurada (fuera de producción). */
async function escribirPlanilla(env: Env, msg: LeadMessage): Promise<boolean> {
  if (!env.SHEETS_ENDPOINT_URL) {
    if (env.ENVIRONMENT === "production") throw new Error("SHEETS_ENDPOINT_URL no configurado");
    console.warn("SHEETS_ENDPOINT_URL no configurado; se omite la planilla en", env.ENVIRONMENT);
    return false;
  }
  const l = msg.lead;
  // Apps Script no expone headers HTTP en doPost, así que el token va como parámetro de la URL.
  const endpoint = new URL(env.SHEETS_ENDPOINT_URL);
  endpoint.searchParams.set("token", env.SHEETS_ENDPOINT_TOKEN);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=utf-8" }, // text/plain evita el preflight y el 405 de Apps Script
    body: JSON.stringify({
      fecha: msg.timestamp,
      nombre: l.nombre,
      empresa: l.empresa,
      contacto: l.contacto,
      equipo: l.equipo,
      magnitud: l.magnitud,
      cantidad: l.cantidad,
      ciudad: l.ciudad,
      plazo: l.plazo,
      calificacion: l.calificacion,
      motivoPerdida: l.motivo,
      tipoCliente: l.tipoCliente,
      origen: msg.origen.canal + (msg.origen.utm_campaign ? ` / ${msg.origen.utm_campaign}` : ""),
      gclid: msg.origen.gclid,
      urlEntrada: msg.origen.url,
      fuente: "Tecito",
      notas: l.resumen,
    }),
    redirect: "follow", // Apps Script responde con 302 a script.googleusercontent.com
  });
  // Apps Script siempre responde 200; el estado real viene en el cuerpo.
  const texto = await res.text();
  let data: { status?: number; error?: string } = {};
  try { data = JSON.parse(texto); } catch { /* respuesta no JSON */ }
  if (!res.ok || (data.status && data.status >= 400)) {
    throw new Error(`Apps Script ${data.status ?? res.status}: ${data.error ?? texto.slice(0, 200)}`);
  }
  return true;
}

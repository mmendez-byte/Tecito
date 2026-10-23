import { enviarAlerta } from "./mail";
import type { Env, Session } from "./types";

/**
 * Registro durable en D1. La sesión viva sigue en KV (24 h); acá queda cada conversación para
 * cotejar que ningún lead se haya perdido y para el informe semanal. Nada de esto está en el
 * camino crítico: si D1 falla, se loguea y el chat y la cola siguen.
 */

/** Transcripción, nombre y contacto se borran a los 90 días; la ficha y el origen quedan. */
export const DIAS_DATOS_PERSONALES = 90;

export type Paso = "mail" | "planilla";

export async function registrarConversacion(env: Env, s: Session): Promise<void> {
  const o = s.origen;
  const l = s.lead;
  const fila: Record<string, string | number | null> = {
    id: s.id,
    creada: s.createdAt,
    actualizada: new Date().toISOString(),
    canal: o.canal,
    plataforma: o.plataforma ?? "",
    campania: o.utm_campaign,
    termino: o.utm_term ?? "",
    contenido: o.utm_content ?? "",
    linea: o.linea,
    url_entrada: o.url,
    pagina: o.pagina ?? o.url,
    referrer: o.referrer,
    gclid: o.gclid,
    mensajes: s.messages.filter((m) => m.role === "user").length,
    ultimo_tecito: [...s.messages].reverse().find((m) => m.role === "assistant")?.content.slice(0, 1000) ?? null,
    transcripcion: JSON.stringify(s.messages),
    whatsapp: s.whatsappClicked ? 1 : 0,
    costo_usd: Number(s.costUsd.toFixed(6)),
    calificacion: l?.calificacion ?? null,
    motivo: l?.motivo ?? null,
    equipo: l?.equipo ?? null,
    magnitud: l?.magnitud ?? null,
    cantidad: l?.cantidad ?? null,
    ciudad: l?.ciudad ?? null,
    plazo: l?.plazo ?? null,
    tipo_cliente: l?.tipoCliente ?? null,
    resumen: l?.resumen ?? null,
    empresa: l?.empresa ?? null,
    nombre: l?.nombre ?? null,
    contacto: l?.contacto ?? null,
    lead_encolado: s.leadEncolado ?? null,
  };
  const cols = Object.keys(fila);
  // mail_ok y planilla_ok no van en el UPDATE: los escribe solo el consumidor de la cola.
  const sql =
    `INSERT INTO conversaciones (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ` +
    `ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`).join(", ")}`;
  try {
    await env.DB.prepare(sql).bind(...cols.map((c) => fila[c])).run();
  } catch (e) {
    console.error("D1: no se pudo registrar la conversación", s.id, e);
  }
}

/** Qué pasos de entrega ya se hicieron para este lead. Si D1 falla, se asume que ninguno. */
export async function entregaHecha(env: Env, sessionId: string): Promise<Record<Paso, boolean>> {
  try {
    const r = await env.DB.prepare("SELECT mail_ok, planilla_ok FROM conversaciones WHERE id = ?")
      .bind(sessionId)
      .first<{ mail_ok: string | null; planilla_ok: string | null }>();
    return { mail: Boolean(r?.mail_ok), planilla: Boolean(r?.planilla_ok) };
  } catch (e) {
    console.error("D1: no se pudo leer la entrega", sessionId, e);
    return { mail: false, planilla: false };
  }
}

export async function marcarEntrega(env: Env, sessionId: string, paso: Paso): Promise<void> {
  const col = paso === "mail" ? "mail_ok" : "planilla_ok";
  const ahora = new Date().toISOString();
  // La cola puede correr antes de que la conversación quede registrada: si no existe la fila, se crea.
  try {
    await env.DB.prepare(
      `INSERT INTO conversaciones (id, creada, actualizada, ${col}) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ${col} = excluded.${col}`,
    )
      .bind(sessionId, ahora, ahora, ahora)
      .run();
  } catch (e) {
    console.error("D1: no se pudo marcar la entrega", sessionId, paso, e);
  }
}

// ---------- Cotejo diario ----------

interface Pendiente {
  id: string;
  creada: string;
  lead_encolado: string | null;
  empresa: string | null;
  equipo: string | null;
  contacto: string | null;
  mail_ok: string | null;
  planilla_ok: string | null;
}

/**
 * Busca leads que calificaron en los últimos 7 días y no tienen el mail o la fila de la planilla
 * (o que ni siquiera llegaron a la cola), y avisa a Matías. Después borra los datos personales
 * de las conversaciones con más de 90 días.
 */
export async function cotejar(env: Env, ahora = new Date()): Promise<{ pendientes: Pendiente[]; borradas: number }> {
  const hace = (ms: number) => new Date(ahora.getTime() - ms).toISOString();
  const conPlanilla = Boolean(env.SHEETS_ENDPOINT_URL);

  const { results: pendientes } = await env.DB.prepare(
    `SELECT id, creada, lead_encolado, empresa, equipo, contacto, mail_ok, planilla_ok
       FROM conversaciones
      WHERE calificacion = 'CALIFICA'
        AND creada >= ? AND creada < ?
        AND (lead_encolado IS NULL OR mail_ok IS NULL OR (? = 1 AND planilla_ok IS NULL))
      ORDER BY creada`,
  )
    .bind(hace(7 * 864e5), hace(30 * 60e3), conPlanilla ? 1 : 0)
    .all<Pendiente>();

  if (pendientes.length) {
    const lineas = pendientes.map((p) => {
      const falta = [
        !p.lead_encolado && "no llegó a la cola",
        p.lead_encolado && !p.mail_ok && "sin mail",
        p.lead_encolado && conPlanilla && !p.planilla_ok && "sin fila en la planilla",
      ].filter(Boolean);
      return `- ${p.creada.slice(0, 16).replace("T", " ")} UTC · ${p.empresa || "sin empresa"} · ${p.equipo || "—"} · ${p.contacto || "sin contacto"} → ${falta.join(", ")} (sesión ${p.id})`;
    });
    await enviarAlerta(
      env,
      `${pendientes.length} lead(s) sin entregar completos`,
      [
        "El cotejo diario encontró leads que calificaron y no tienen todas sus entregas registradas.",
        "Si la cola sigue reintentando, puede resolverse sola; si no, la ficha completa está en D1 (tabla conversaciones).",
        "",
        ...lineas,
      ].join("\n"),
    ).catch((e) => console.error("no se pudo mandar el aviso del cotejo", e));
  }

  const borrado = await env.DB.prepare(
    `UPDATE conversaciones SET transcripcion = NULL, nombre = NULL, contacto = NULL
      WHERE creada < ? AND (transcripcion IS NOT NULL OR nombre IS NOT NULL OR contacto IS NOT NULL)`,
  )
    .bind(hace(DIAS_DATOS_PERSONALES * 864e5))
    .run();

  return { pendientes, borradas: borrado.meta.changes ?? 0 };
}

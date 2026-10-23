import { API, VERSION } from "./claude";
import { checkBudget, estimateCost, recordSpend } from "./guard";
import { enviarAlerta } from "./mail";
import type { ChatMessage, Env } from "./types";

/**
 * Informe semanal para nutrir las campañas: los números de la semana desde D1 y, si hay muestra
 * y presupuesto, una lectura de Sonnet con hallazgos accionables. Va por mail solo a Matías
 * (el primer destinatario de MAIL_TO, como las alertas).
 */

const MUESTRA_MINIMA = 10; // con menos conversaciones no se pide lectura: serían conclusiones sobre ruido
const MAX_CONSULTAS = 40;
const MAX_CORTES = 30;
const LIMA_UTC_OFFSET_MS = 5 * 3600e3; // Perú no tiene horario de verano

interface Totales {
  conversaciones: number;
  conMensajes: number;
  califica: number;
  fueraDeAlcance: number;
  noEsLead: number;
  sinFicha: number;
  whatsapp: number;
  costoUsd: number;
}

export interface DatosSemana {
  desde: string;
  hasta: string;
  totales: Totales;
  semanaAnterior: Totales;
  porOrigen: { canal: string; plataforma: string; campania: string; conversaciones: number; califica: number; fuera: number; whatsapp: number }[];
  porTermino: { termino: string; conversaciones: number; califica: number; fuera: number }[];
  porLinea: { linea: string; conversaciones: number; califica: number }[];
  magnitudesQueCalifican: { magnitud: string; n: number }[];
  equiposFueraDeAlcance: { equipo: string; motivo: string; n: number }[];
  ciudades: { ciudad: string; n: number }[];
  tiposCliente: { tipo: string; n: number }[];
  entrega: { leads: number; encolados: number; mail: number; planilla: number };
  /** Último mensaje de Tecito en conversaciones que se cortaron sin ficha. */
  cortes: string[];
  /** Lo que escribió el visitante, sin correos ni teléfonos. */
  consultas: string[];
}

/** Semana que termina el día de hoy a las 00:00 de Lima. */
export function semanaCerrada(ahora: Date): { desde: string; hasta: string } {
  const dia = 864e5;
  const hasta = Math.floor((ahora.getTime() - LIMA_UTC_OFFSET_MS) / dia) * dia + LIMA_UTC_OFFSET_MS;
  return { desde: new Date(hasta - 7 * dia).toISOString(), hasta: new Date(hasta).toISOString() };
}

/** Saca correos y teléfonos antes de mandar texto del visitante al modelo o a un mail. */
export function sinDatosDeContacto(t: string): string {
  return t
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[correo]")
    .replace(/\+?\d[\d\s-]{6,}\d/g, "[número]");
}

export async function datosDeLaSemana(env: Env, desde: string, hasta: string): Promise<DatosSemana> {
  const db = env.DB;
  const rango = "creada >= ?1 AND creada < ?2";
  const todas = <T>(sql: string, a = desde, b = hasta) => db.prepare(sql).bind(a, b).all<T>().then((r) => r.results);

  const totales = async (a: string, b: string): Promise<Totales> => {
    const r = await db
      .prepare(
        `SELECT COUNT(*) AS conversaciones,
                COALESCE(SUM(mensajes > 0), 0) AS conMensajes,
                COALESCE(SUM(calificacion IS 'CALIFICA'), 0) AS califica,
                COALESCE(SUM(calificacion IS 'FUERA DE ALCANCE'), 0) AS fueraDeAlcance,
                COALESCE(SUM(calificacion IS 'NO ES LEAD'), 0) AS noEsLead,
                COALESCE(SUM(mensajes > 0 AND calificacion IS NULL), 0) AS sinFicha,
                COALESCE(SUM(whatsapp), 0) AS whatsapp,
                ROUND(COALESCE(SUM(costo_usd), 0), 4) AS costoUsd
           FROM conversaciones WHERE ${rango}`,
      )
      .bind(a, b)
      .first<Totales>();
    return r!;
  };

  const semana = 7 * 864e5;
  const [actual, anterior] = await Promise.all([
    totales(desde, hasta),
    totales(new Date(Date.parse(desde) - semana).toISOString(), desde),
  ]);

  const [porOrigen, porTermino, porLinea, magnitudesQueCalifican, equiposFueraDeAlcance, ciudades, tiposCliente, entregaRows, textos] =
    await Promise.all([
      todas<DatosSemana["porOrigen"][number]>(
        `SELECT canal, COALESCE(plataforma, '') AS plataforma, COALESCE(campania, '') AS campania, COUNT(*) AS conversaciones,
                SUM(calificacion IS 'CALIFICA') AS califica, SUM(calificacion IS 'FUERA DE ALCANCE') AS fuera, SUM(whatsapp) AS whatsapp
           FROM conversaciones WHERE ${rango} AND mensajes > 0
          GROUP BY 1, 2, 3 ORDER BY conversaciones DESC LIMIT 25`,
      ),
      todas<DatosSemana["porTermino"][number]>(
        `SELECT lower(termino) AS termino, COUNT(*) AS conversaciones,
                SUM(calificacion IS 'CALIFICA') AS califica, SUM(calificacion IS 'FUERA DE ALCANCE') AS fuera
           FROM conversaciones WHERE ${rango} AND mensajes > 0 AND termino <> ''
          GROUP BY 1 ORDER BY conversaciones DESC LIMIT 25`,
      ),
      todas<DatosSemana["porLinea"][number]>(
        `SELECT linea, COUNT(*) AS conversaciones, SUM(calificacion IS 'CALIFICA') AS califica
           FROM conversaciones WHERE ${rango} AND mensajes > 0 AND linea <> ''
          GROUP BY 1 ORDER BY conversaciones DESC`,
      ),
      todas<DatosSemana["magnitudesQueCalifican"][number]>(
        `SELECT COALESCE(NULLIF(magnitud, ''), 'sin magnitud') AS magnitud, COUNT(*) AS n
           FROM conversaciones WHERE ${rango} AND calificacion = 'CALIFICA'
          GROUP BY 1 ORDER BY n DESC`,
      ),
      todas<DatosSemana["equiposFueraDeAlcance"][number]>(
        `SELECT lower(equipo) AS equipo, COALESCE(motivo, '') AS motivo, COUNT(*) AS n
           FROM conversaciones WHERE ${rango} AND calificacion = 'FUERA DE ALCANCE'
          GROUP BY 1, 2 ORDER BY n DESC LIMIT 20`,
      ),
      todas<DatosSemana["ciudades"][number]>(
        `SELECT ciudad, COUNT(*) AS n FROM conversaciones WHERE ${rango} AND COALESCE(ciudad, '') <> ''
          GROUP BY lower(ciudad) ORDER BY n DESC LIMIT 15`,
      ),
      todas<DatosSemana["tiposCliente"][number]>(
        `SELECT tipo_cliente AS tipo, COUNT(*) AS n FROM conversaciones WHERE ${rango} AND COALESCE(tipo_cliente, '') <> ''
          GROUP BY lower(tipo_cliente) ORDER BY n DESC LIMIT 15`,
      ),
      todas<{ leads: number; encolados: number; mail: number; planilla: number }>(
        `SELECT COUNT(*) AS leads, COUNT(lead_encolado) AS encolados, COUNT(mail_ok) AS mail, COUNT(planilla_ok) AS planilla
           FROM conversaciones WHERE ${rango} AND calificacion = 'CALIFICA'`,
      ),
      todas<{ transcripcion: string | null; ultimo_tecito: string | null; calificacion: string | null }>(
        `SELECT transcripcion, ultimo_tecito, calificacion FROM conversaciones
          WHERE ${rango} AND mensajes > 0 ORDER BY creada DESC LIMIT 200`,
      ),
    ]);

  const consultas: string[] = [];
  const cortes: string[] = [];
  for (const t of textos) {
    if (consultas.length < MAX_CONSULTAS && t.transcripcion) {
      const msgs = safeParse(t.transcripcion);
      const delVisitante = msgs.filter((m) => m.role === "user").map((m) => m.content).join(" / ");
      if (delVisitante) consultas.push(sinDatosDeContacto(delVisitante).slice(0, 300));
    }
    if (cortes.length < MAX_CORTES && !t.calificacion && t.ultimo_tecito) {
      cortes.push(sinDatosDeContacto(t.ultimo_tecito).slice(0, 200));
    }
  }

  return {
    desde,
    hasta,
    totales: actual,
    semanaAnterior: anterior,
    porOrigen,
    porTermino,
    porLinea,
    magnitudesQueCalifican,
    equiposFueraDeAlcance,
    ciudades,
    tiposCliente,
    entrega: entregaRows[0] ?? { leads: 0, encolados: 0, mail: 0, planilla: 0 },
    cortes,
    consultas,
  };
}

const SISTEMA_ANALISTA = `Sos analista de marketing de COMPi. Leés los datos de una semana de Tecito, el asistente de chat del sitio de Test & Control, un laboratorio de calibración acreditado por INACAL en Lima, Perú. Tecito conversa con el visitante, califica la consulta contra el alcance acreditado (CALIFICA, FUERA DE ALCANCE, NO ES LEAD; "sin ficha" es una conversación que se cortó antes) y deriva a la asesora comercial por WhatsApp.

Tu lector es Matías, que maneja las campañas de Google Ads y el sitio. Escribí entre 3 y 6 hallazgos que le sirvan para decidir algo esta semana. Cada hallazgo en un párrafo corto:
- qué muestran los datos, con el número;
- qué hacer: una acción concreta (palabra clave negativa, ajuste de ubicación, anuncio o landing por línea, pregunta para la base de conocimiento, tema para el blog, cambio en cómo pregunta Tecito);
- cuán firme es, según el tamaño de la muestra.

Reglas: usá solo los datos que te paso; no inventes números ni causas. Si algo tiene menos de 5 casos, decilo y no saques conclusiones fuertes. Nada de introducción ni cierre. Texto plano, sin markdown; cada hallazgo empieza con un guion.`;

export async function informeSemanal(env: Env, ahora = new Date()): Promise<void> {
  const { desde, hasta } = semanaCerrada(ahora);
  const datos = await datosDeLaSemana(env, desde, hasta);

  let lectura: string;
  if (datos.totales.conMensajes < MUESTRA_MINIMA) {
    lectura = `Esta semana hubo ${datos.totales.conMensajes} conversaciones con mensajes; con menos de ${MUESTRA_MINIMA} no se pide lectura al modelo.`;
  } else if (!(await checkBudget(env)).ok) {
    lectura = "El presupuesto del Worker está agotado; va solo con los números.";
  } else {
    try {
      lectura = await leerConSonnet(env, datos);
    } catch (e) {
      console.error("informe: la lectura falló", e);
      lectura = "La lectura del modelo falló; van solo los números.";
    }
  }

  const fecha = (iso: string) => new Date(Date.parse(iso) - LIMA_UTC_OFFSET_MS).toISOString().slice(0, 10);
  const ultimoDia = new Date(Date.parse(hasta) - 864e5).toISOString();
  await enviarAlerta(env, `Informe semanal ${fecha(desde)} a ${fecha(ultimoDia)}`, cuerpoDelInforme(datos, lectura));
}

async function leerConSonnet(env: Env, datos: DatosSemana): Promise<string> {
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": VERSION },
    body: JSON.stringify({
      model: env.MODEL_VALIDATE,
      max_tokens: 1500,
      system: [{ type: "text", text: SISTEMA_ANALISTA }],
      messages: [{ role: "user", content: `Datos de la semana:\n${JSON.stringify(datos, null, 1)}` }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic informe ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    content: { type: string; text?: string }[];
    usage: { input_tokens: number; output_tokens: number };
  };
  await recordSpend(env, estimateCost(env.MODEL_VALIDATE, data.usage));
  return data.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim();
}

export function cuerpoDelInforme(d: DatosSemana, lectura: string): string {
  const t = d.totales;
  const a = d.semanaAnterior;
  const pct = (n: number, de: number) => (de ? `${Math.round((100 * n) / de)} %` : "—");
  const delta = (n: number, antes: number) => (antes ? ` (semana anterior: ${antes})` : "");
  const tabla = (filas: string[]) => (filas.length ? filas : ["  (sin datos)"]);

  return [
    "LECTURA",
    lectura,
    "",
    "NÚMEROS DE LA SEMANA",
    `Conversaciones con mensajes: ${t.conMensajes}${delta(t.conMensajes, a.conMensajes)}`,
    `Califican: ${t.califica} (${pct(t.califica, t.conMensajes)})${delta(t.califica, a.califica)}`,
    `Fuera de alcance: ${t.fueraDeAlcance} · No es lead: ${t.noEsLead} · Se cortaron sin ficha: ${t.sinFicha}`,
    `Tocaron WhatsApp: ${t.whatsapp}`,
    `Costo de la API: USD ${t.costoUsd.toFixed(2)}`,
    "",
    "Por origen (conversaciones · califican · fuera de alcance · WhatsApp)",
    ...tabla(d.porOrigen.map((o) => `  ${[o.canal, o.plataforma, o.campania].filter(Boolean).join(" / ")}: ${o.conversaciones} · ${o.califica} · ${o.fuera} · ${o.whatsapp}`)),
    "",
    "Por búsqueda de Ads (conversaciones · califican · fuera de alcance)",
    ...tabla(d.porTermino.map((o) => `  ${o.termino}: ${o.conversaciones} · ${o.califica} · ${o.fuera}`)),
    "",
    "Por línea (conversaciones · califican)",
    ...tabla(d.porLinea.map((o) => `  ${o.linea}: ${o.conversaciones} · ${o.califica}`)),
    "",
    "Magnitudes que califican",
    ...tabla(d.magnitudesQueCalifican.map((o) => `  ${o.magnitud}: ${o.n}`)),
    "",
    "Equipos fuera de alcance",
    ...tabla(d.equiposFueraDeAlcance.map((o) => `  ${o.equipo}${o.motivo ? ` (${o.motivo})` : ""}: ${o.n}`)),
    "",
    "Ciudades",
    ...tabla(d.ciudades.map((o) => `  ${o.ciudad}: ${o.n}`)),
    "",
    "Tipo de cliente",
    ...tabla(d.tiposCliente.map((o) => `  ${o.tipo}: ${o.n}`)),
    "",
    "COTEJO DE ENTREGA",
    `Leads que calificaron: ${d.entrega.leads} · encolados: ${d.entrega.encolados} · con mail: ${d.entrega.mail} · con fila en la planilla: ${d.entrega.planilla}`,
  ].join("\n");
}

function safeParse(s: string): ChatMessage[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

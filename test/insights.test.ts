import { beforeEach, describe, expect, it, vi } from "vitest";
import wrangler from "../wrangler.jsonc?raw";
import { CRON_COTEJO, CRON_INFORME } from "../src/crons";
import { cuerpoDelInforme, datosDeLaSemana, informeSemanal, semanaCerrada, sinDatosDeContacto } from "../src/insights";
import { registrarConversacion } from "../src/registro";
import { parseOrigen } from "../src/session";
import type { Env, Lead, Session } from "../src/types";
import { d1 } from "./d1";

const enviarAlerta = vi.fn(async () => {});
vi.mock("../src/mail", () => ({ enviarAlerta: (...a: unknown[]) => enviarAlerta(...(a as [])), enviarAvisoLead: vi.fn() }));

function kv(): KVNamespace {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v) } as unknown as KVNamespace;
}

const base: Lead = {
  empresa: "", nombre: "", contacto: "", equipo: "", magnitud: "", cantidad: "", ciudad: "", plazo: "",
  calificacion: "CALIFICA", motivo: "", tipoCliente: "", resumen: "",
};

let n = 0;
function sesion(url: string, lead: Partial<Lead> | null, createdAt = "2026-10-15T15:00:00.000Z", textoVisitante = "Necesito calibrar"): Session {
  return {
    id: `s-${++n}`,
    createdAt,
    origen: parseOrigen({ url, referrer: "https://www.google.com/" }),
    messages: [
      { role: "user", content: textoVisitante },
      { role: "assistant", content: "¿En qué ciudad está el equipo?" },
    ],
    tokensUsed: 0,
    costUsd: 0.004,
    lead: lead ? { ...base, ...lead } : undefined,
  };
}

const ADS = "https://testcontrol.com.pe/?gclid=G&utm_campaign=search-presion&utm_term=calibracion manometros";
const ADS_ENSAYOS = "https://testcontrol.com.pe/?gclid=G&utm_campaign=search-presion&utm_term=laboratorio de ensayos";

let env: Env;
beforeEach(() => {
  env = { DB: d1(), METRICS: kv(), MODEL_VALIDATE: "claude-sonnet-5-5", ANTHROPIC_API_KEY: "k", DAILY_BUDGET_USD: "2", MONTHLY_BUDGET_USD: "15", MAIL_TO: "a@b.c", ENVIRONMENT: "production" } as unknown as Env;
  enviarAlerta.mockClear();
  n = 0;
});

async function sembrar() {
  const filas = [
    sesion(ADS, { equipo: "manómetros", magnitud: "Presión", ciudad: "Arequipa", tipoCliente: "Minería" }),
    sesion(ADS, { equipo: "manómetro", magnitud: "Presión", ciudad: "Lima" }),
    sesion(ADS_ENSAYOS, { equipo: "Análisis de agua", calificacion: "FUERA DE ALCANCE", motivo: "NO ES CALIBRACIÓN" }),
    sesion(ADS_ENSAYOS, { equipo: "análisis de agua", calificacion: "FUERA DE ALCANCE", motivo: "NO ES CALIBRACIÓN" }),
    sesion("https://testcontrol.com.pe/?linea=electrica", null, undefined, "Hola, mi correo es ana@empresa.pe y mi cel 987 654 321"),
    sesion("https://testcontrol.com.pe/", null, "2026-10-08T15:00:00.000Z"), // semana anterior
  ];
  for (const s of filas) await registrarConversacion(env, s);
}

describe("semanaCerrada", () => {
  it("toma los 7 días que terminan hoy a las 00:00 de Lima", () => {
    expect(semanaCerrada(new Date("2026-10-19T13:00:00.000Z"))).toEqual({ desde: "2026-10-12T05:00:00.000Z", hasta: "2026-10-19T05:00:00.000Z" });
  });
});

describe("datosDeLaSemana", () => {
  it("cruza origen, búsqueda y calificación, y compara con la semana anterior", async () => {
    await sembrar();
    const d = await datosDeLaSemana(env, "2026-10-12T05:00:00.000Z", "2026-10-19T05:00:00.000Z");
    expect(d.totales).toMatchObject({ conversaciones: 5, conMensajes: 5, califica: 2, fueraDeAlcance: 2, sinFicha: 1 });
    expect(d.semanaAnterior.conversaciones).toBe(1);
    expect(d.porTermino).toEqual(
      expect.arrayContaining([
        { termino: "calibracion manometros", conversaciones: 2, califica: 2, fuera: 0 },
        { termino: "laboratorio de ensayos", conversaciones: 2, califica: 0, fuera: 2 },
      ]),
    );
    expect(d.equiposFueraDeAlcance).toEqual([{ equipo: "análisis de agua", motivo: "NO ES CALIBRACIÓN", n: 2 }]);
    expect(d.magnitudesQueCalifican).toEqual([{ magnitud: "Presión", n: 2 }]);
    expect(d.porLinea).toEqual([{ linea: "electrica", conversaciones: 1, califica: 0 }]);
    expect(d.cortes).toEqual(["¿En qué ciudad está el equipo?"]);
  });

  it("no pasa correos ni teléfonos del visitante", async () => {
    await sembrar();
    const d = await datosDeLaSemana(env, "2026-10-12T05:00:00.000Z", "2026-10-19T05:00:00.000Z");
    const todo = d.consultas.join(" ");
    expect(todo).not.toContain("ana@empresa.pe");
    expect(todo).not.toContain("987 654 321");
    expect(sinDatosDeContacto("escribime a ana@empresa.pe o al +51 987-654-321")).toBe("escribime a [correo] o al [número]");
    expect(sinDatosDeContacto("12 manómetros de 0 a 10 bar")).toBe("12 manómetros de 0 a 10 bar");
  });
});

describe("informeSemanal", () => {
  it("con poca muestra manda solo los números y no llama al modelo", async () => {
    await sembrar();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await informeSemanal(env, new Date("2026-10-19T13:00:00.000Z"));
    expect(fetch).not.toHaveBeenCalled();
    expect(enviarAlerta).toHaveBeenCalledOnce();
    const [, asunto, cuerpo] = enviarAlerta.mock.calls[0] as unknown as [Env, string, string];
    expect(asunto).toBe("Informe semanal 2026-10-12 a 2026-10-18");
    expect(cuerpo).toContain("no se pide lectura");
    expect(cuerpo).toContain("laboratorio de ensayos: 2 · 0 · 2");
  });

  it("con muestra pide la lectura a Sonnet y suma el gasto al presupuesto", async () => {
    for (let i = 0; i < 12; i++) await registrarConversacion(env, sesion(ADS, { equipo: "manómetro", magnitud: "Presión" }));
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "- La búsqueda «calibracion manometros» trae 12 de 12 leads." }], usage: { input_tokens: 4000, output_tokens: 300 } })),
    );
    vi.stubGlobal("fetch", fetch);
    await informeSemanal(env, new Date("2026-10-19T13:00:00.000Z"));
    expect(fetch).toHaveBeenCalledOnce();
    const req = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(req.model).toBe("claude-sonnet-5-5");
    const cuerpo = (enviarAlerta.mock.calls[0] as unknown as [Env, string, string])[2];
    expect(cuerpo.startsWith("LECTURA\n- La búsqueda")).toBe(true);
    expect(Number(await env.METRICS.get(`spend:day:${new Date().toISOString().slice(0, 10)}`))).toBeGreaterThan(0);
  });

  it("sin presupuesto no llama al modelo", async () => {
    for (let i = 0; i < 12; i++) await registrarConversacion(env, sesion(ADS, { equipo: "manómetro" }));
    await env.METRICS.put(`spend:day:${new Date().toISOString().slice(0, 10)}`, "5");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await informeSemanal(env, new Date("2026-10-19T13:00:00.000Z"));
    expect(fetch).not.toHaveBeenCalled();
    expect((enviarAlerta.mock.calls[0] as unknown as [Env, string, string])[2]).toContain("presupuesto");
  });

  it("el cuerpo no se rompe sin datos", () => {
    const cero = { conversaciones: 0, conMensajes: 0, califica: 0, fueraDeAlcance: 0, noEsLead: 0, sinFicha: 0, whatsapp: 0, costoUsd: 0 };
    const t = cuerpoDelInforme(
      { desde: "", hasta: "", totales: cero, semanaAnterior: cero, porOrigen: [], porTermino: [], porLinea: [], magnitudesQueCalifican: [], equiposFueraDeAlcance: [], ciudades: [], tiposCliente: [], entrega: { leads: 0, encolados: 0, mail: 0, planilla: 0 }, cortes: [], consultas: [] },
      "x",
    );
    expect(t).toContain("(sin datos)");
  });
});

describe("crons", () => {
  it("wrangler.jsonc programa el cotejo y el informe en los dos entornos", () => {
    const declarados = [...wrangler.matchAll(/"crons":\s*\[([^\]]*)\]/g)].map((m) => m[1]);
    expect(declarados).toHaveLength(2);
    for (const d of declarados) {
      expect(d).toContain(`"${CRON_COTEJO}"`);
      expect(d).toContain(`"${CRON_INFORME}"`);
    }
  });
});

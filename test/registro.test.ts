import { beforeEach, describe, expect, it, vi } from "vitest";
import { cotejar, entregaHecha, marcarEntrega, registrarConversacion } from "../src/registro";
import { parseOrigen } from "../src/session";
import type { Env, Lead, Session } from "../src/types";
import { d1 } from "./d1";

const enviarAlerta = vi.fn(async () => {});
vi.mock("../src/mail", () => ({ enviarAlerta: (...a: unknown[]) => enviarAlerta(...(a as [])), enviarAvisoLead: vi.fn() }));

const lead: Lead = {
  empresa: "Minera X", nombre: "Juan", contacto: "999 888 777", equipo: "manómetros", magnitud: "Presión", cantidad: "12",
  ciudad: "Lima", plazo: "noviembre", calificacion: "CALIFICA", motivo: "", tipoCliente: "Minería", resumen: "12 manómetros",
};

function sesion(over: Partial<Session> = {}): Session {
  return {
    id: crypto.randomUUID(),
    createdAt: "2026-10-20T15:00:00.000Z",
    origen: parseOrigen({ url: "https://testcontrol.com.pe/?gclid=G1&utm_campaign=search-lima&utm_term=calibracion manometros", referrer: "https://www.google.com/" }),
    messages: [
      { role: "user", content: "Necesito calibrar manómetros" },
      { role: "assistant", content: "¿Cuántos son?" },
    ],
    tokensUsed: 0,
    costUsd: 0.0012,
    ...over,
  };
}

let env: Env;
beforeEach(() => {
  env = { DB: d1(), SHEETS_ENDPOINT_URL: "https://script.google.com/x", MAIL_TO: "a@b.c", ENVIRONMENT: "production" } as unknown as Env;
  enviarAlerta.mockClear();
});

describe("registrarConversacion", () => {
  it("guarda origen, ficha y dónde quedó la conversación", async () => {
    const s = sesion();
    await registrarConversacion(env, s);
    const r = await env.DB.prepare("SELECT * FROM conversaciones WHERE id = ?").bind(s.id).first<Record<string, unknown>>();
    expect(r).toMatchObject({ canal: "campaña", plataforma: "google", campania: "search-lima", termino: "calibracion manometros", gclid: "G1", mensajes: 1, ultimo_tecito: "¿Cuántos son?", calificacion: null });
  });

  it("al actualizar no pisa las marcas de entrega que puso la cola", async () => {
    const s = sesion({ lead, leadEncolado: "2026-10-20T15:05:00.000Z" });
    await marcarEntrega(env, s.id, "mail"); // la cola corrió antes que el registro
    await registrarConversacion(env, s);
    await registrarConversacion(env, { ...s, whatsappClicked: true });
    expect(await entregaHecha(env, s.id)).toEqual({ mail: true, planilla: false });
    const r = await env.DB.prepare("SELECT calificacion, whatsapp, creada FROM conversaciones WHERE id = ?").bind(s.id).first();
    expect(r).toEqual({ calificacion: "CALIFICA", whatsapp: 1, creada: s.createdAt });
  });

  it("no rompe si D1 falla", async () => {
    env.DB = { prepare: () => { throw new Error("D1 caído"); } } as unknown as D1Database;
    await expect(registrarConversacion(env, sesion())).resolves.toBeUndefined();
    expect(await entregaHecha(env, "x")).toEqual({ mail: false, planilla: false });
  });

  it("acepta sesiones creadas antes de que existieran plataforma, término y página", async () => {
    const s = sesion();
    const viejo = { ...s.origen } as Partial<typeof s.origen>;
    delete viejo.plataforma; delete viejo.utm_term; delete viejo.utm_content; delete viejo.pagina;
    await registrarConversacion(env, { ...s, origen: viejo as typeof s.origen });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM conversaciones").bind().first("n")).toBe(1);
  });
});

describe("cotejar", () => {
  const ahora = new Date("2026-10-21T12:30:00.000Z");

  it("avisa los leads que calificaron y no tienen mail o planilla, y los que no llegaron a la cola", async () => {
    const completo = sesion({ lead, leadEncolado: "2026-10-20T15:01:00.000Z" });
    const sinPlanilla = sesion({ lead: { ...lead, empresa: "Agro Y" }, leadEncolado: "2026-10-20T15:01:00.000Z" });
    const sinCola = sesion({ lead: { ...lead, empresa: "Pharma Z" } });
    const noCalifica = sesion({ lead: { ...lead, calificacion: "FUERA DE ALCANCE" } });
    for (const s of [completo, sinPlanilla, sinCola, noCalifica]) await registrarConversacion(env, s);
    await marcarEntrega(env, completo.id, "mail");
    await marcarEntrega(env, completo.id, "planilla");
    await marcarEntrega(env, sinPlanilla.id, "mail");

    const { pendientes } = await cotejar(env, ahora);
    expect(pendientes.map((p) => p.id).sort()).toEqual([sinPlanilla.id, sinCola.id].sort());
    expect(enviarAlerta).toHaveBeenCalledOnce();
    const cuerpo = (enviarAlerta.mock.calls[0] as unknown[])[2] as string;
    expect(cuerpo).toContain("Agro Y");
    expect(cuerpo).toContain("sin fila en la planilla");
    expect(cuerpo).toContain("Pharma Z");
    expect(cuerpo).toContain("no llegó a la cola");
  });

  it("fuera de producción, sin planilla configurada, no reclama la fila", async () => {
    env.SHEETS_ENDPOINT_URL = "";
    const s = sesion({ lead, leadEncolado: "2026-10-20T15:01:00.000Z" });
    await registrarConversacion(env, s);
    await marcarEntrega(env, s.id, "mail");
    expect((await cotejar(env, ahora)).pendientes).toHaveLength(0);
    expect(enviarAlerta).not.toHaveBeenCalled();
  });

  it("borra transcripción, nombre y contacto a los 90 días y deja la ficha", async () => {
    const vieja = sesion({ lead, createdAt: "2026-07-01T10:00:00.000Z" });
    const nueva = sesion({ lead });
    await registrarConversacion(env, vieja);
    await registrarConversacion(env, nueva);
    const { borradas } = await cotejar(env, ahora);
    expect(borradas).toBe(1);
    const r = await env.DB.prepare("SELECT transcripcion, nombre, contacto, equipo, calificacion FROM conversaciones WHERE id = ?").bind(vieja.id).first();
    expect(r).toEqual({ transcripcion: null, nombre: null, contacto: null, equipo: "manómetros", calificacion: "CALIFICA" });
    const n = await env.DB.prepare("SELECT contacto FROM conversaciones WHERE id = ?").bind(nueva.id).first("contacto");
    expect(n).toBe("999 888 777");
  });
});

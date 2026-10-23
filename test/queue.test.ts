import { beforeEach, describe, expect, it, vi } from "vitest";
import { consumirLeads } from "../src/queue";
import { entregaHecha } from "../src/registro";
import type { Env, LeadMessage } from "../src/types";
import { d1 } from "./d1";

const enviarAvisoLead = vi.fn(async () => {});
const enviarAlerta = vi.fn(async () => {});
vi.mock("../src/mail", () => ({
  enviarAvisoLead: (...a: unknown[]) => enviarAvisoLead(...(a as [])),
  enviarAlerta: (...a: unknown[]) => enviarAlerta(...(a as [])),
}));

const body = {
  sessionId: "s-1",
  timestamp: "2026-10-20T15:00:00.000Z",
  lead: { empresa: "Minera X", nombre: "Juan", contacto: "juan@minerax.pe", equipo: "manómetros", magnitud: "Presión", cantidad: "12", ciudad: "Lima", plazo: "", calificacion: "CALIFICA", motivo: "", tipoCliente: "", resumen: "" },
  origen: { url: "", referrer: "", pagina: "", gclid: "", utm_source: "", utm_medium: "", utm_campaign: "", utm_term: "", utm_content: "", linea: "", canal: "directo", plataforma: "" },
  whatsappText: "Hola",
} as LeadMessage;

function mensaje(attempts = 1) {
  return { body, attempts, ack: vi.fn(), retry: vi.fn() };
}
const lote = (m: ReturnType<typeof mensaje>) => ({ messages: [m] }) as unknown as MessageBatch<LeadMessage>;

let env: Env;
let planilla: ReturnType<typeof vi.fn>;
beforeEach(() => {
  env = { DB: d1(), ENVIRONMENT: "production", SHEETS_ENDPOINT_URL: "https://script.google.com/macros/s/x/exec", SHEETS_ENDPOINT_TOKEN: "t" } as unknown as Env;
  enviarAvisoLead.mockReset();
  enviarAlerta.mockReset();
  planilla = vi.fn(async () => new Response(JSON.stringify({ status: 200, ok: true })));
  vi.stubGlobal("fetch", planilla);
});

describe("consumirLeads", () => {
  it("manda el mail antes de escribir la planilla y marca los dos pasos", async () => {
    const orden: string[] = [];
    enviarAvisoLead.mockImplementation(async () => { orden.push("mail"); });
    planilla.mockImplementation(async () => { orden.push("planilla"); return new Response(JSON.stringify({ status: 200 })); });
    const m = mensaje();
    await consumirLeads(lote(m), env);
    expect(orden).toEqual(["mail", "planilla"]);
    expect(m.ack).toHaveBeenCalled();
    expect(await entregaHecha(env, "s-1")).toEqual({ mail: true, planilla: true });
  });

  it("si la planilla está caída, el mail sale igual y el reintento no lo duplica", async () => {
    planilla.mockResolvedValueOnce(new Response(JSON.stringify({ status: 500, error: "Apps Script caído" })));
    const m1 = mensaje(1);
    await consumirLeads(lote(m1), env);
    expect(enviarAvisoLead).toHaveBeenCalledTimes(1);
    expect(m1.retry).toHaveBeenCalled();

    const m2 = mensaje(2);
    await consumirLeads(lote(m2), env);
    expect(enviarAvisoLead).toHaveBeenCalledTimes(1);
    expect(planilla).toHaveBeenCalledTimes(2);
    expect(m2.ack).toHaveBeenCalled();
  });

  it("si falla el mail, el reintento no duplica la fila", async () => {
    enviarAvisoLead.mockRejectedValueOnce(new Error("remitente no verificado"));
    const m1 = mensaje(1);
    await consumirLeads(lote(m1), env);
    expect(planilla).toHaveBeenCalledTimes(1);
    expect(m1.retry).toHaveBeenCalled();

    const m2 = mensaje(2);
    await consumirLeads(lote(m2), env);
    expect(planilla).toHaveBeenCalledTimes(1);
    expect(enviarAvisoLead).toHaveBeenCalledTimes(2);
    expect(m2.ack).toHaveBeenCalled();
  });

  it("D1 caído no frena la entrega", async () => {
    env.DB = { prepare: () => { throw new Error("D1 caído"); } } as unknown as D1Database;
    const m = mensaje();
    await consumirLeads(lote(m), env);
    expect(enviarAvisoLead).toHaveBeenCalledOnce();
    expect(planilla).toHaveBeenCalledOnce();
    expect(m.ack).toHaveBeenCalled();
  });

  it("al agotar los reintentos avisa con lo que falló", async () => {
    enviarAvisoLead.mockRejectedValue(new Error("remitente no verificado"));
    const m = mensaje(12);
    await consumirLeads(lote(m), env);
    expect(enviarAlerta).toHaveBeenCalledOnce();
    expect((enviarAlerta.mock.calls[0] as unknown[])[2]).toContain("mail: remitente no verificado");
    expect(m.retry).toHaveBeenCalled();
  });
});

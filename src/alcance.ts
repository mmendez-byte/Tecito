import alcance from "../knowledge/alcance.json";
import type { Calificacion, Lead, MotivoPerdida } from "./types";

interface Entrada {
  equipo: string;
  sinonimos: string[];
  magnitud: string;
  laboratorio: string;
}

const ENTRADAS: Entrada[] = (alcance as { equipos: Entrada[] }).equipos;
const FUERA = (alcance as { fuera_de_alcance: { patron: string; motivo: string; respuesta: string }[] }).fuera_de_alcance;

export function normalizar(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Busca el equipo declarado en la lista del alcance. Devuelve la entrada o null. */
export function buscarEnAlcance(equipo: string): Entrada | null {
  const q = normalizar(equipo);
  if (!q) return null;
  for (const e of ENTRADAS) {
    const nombres = [e.equipo, ...e.sinonimos].map(normalizar);
    if (nombres.some((n) => q.includes(n) || n.includes(q))) return e;
  }
  return null;
}

/** Detecta pedidos que no son calibración (ensayos, certificación, reparación). */
export function detectarFueraDeAlcance(texto: string): { motivo: MotivoPerdida; respuesta: string } | null {
  const t = texto.toLowerCase();
  for (const f of FUERA) {
    if (new RegExp(f.patron, "i").test(t)) {
      return { motivo: f.motivo as MotivoPerdida, respuesta: f.respuesta };
    }
  }
  return null;
}

/**
 * Chequeo determinístico sobre lo que el modelo devolvió en `registrar_lead`.
 * El modelo propone; esta función decide. Si el equipo no está en la lista, FUERA DE ALCANCE
 * aunque el modelo haya dicho CALIFICA.
 */
export function aplicarAlcance(lead: Lead): Lead {
  const fuera = detectarFueraDeAlcance(`${lead.equipo} ${lead.resumen}`);
  if (fuera) {
    return { ...lead, calificacion: "FUERA DE ALCANCE", motivo: fuera.motivo };
  }

  const entrada = buscarEnAlcance(lead.equipo);
  if (!entrada) {
    if (lead.calificacion === "NO ES LEAD" || lead.calificacion === "SIN RESPUESTA") return lead;
    return { ...lead, calificacion: "FUERA DE ALCANCE", motivo: "EQUIPO FUERA DE ALCANCE" };
  }

  // Equipo dentro del alcance: completar magnitud si el modelo la dejó vacía.
  const calificacion: Calificacion = lead.calificacion === "FUERA DE ALCANCE" ? "CALIFICA" : lead.calificacion;
  return {
    ...lead,
    magnitud: lead.magnitud || entrada.magnitud,
    calificacion,
    motivo: calificacion === "CALIFICA" ? "" : lead.motivo,
  };
}

/** Texto plano del alcance para el system prompt. */
export function alcanceComoTexto(): string {
  const porLab = new Map<string, string[]>();
  for (const e of ENTRADAS) {
    const arr = porLab.get(e.laboratorio) ?? [];
    arr.push(`${e.equipo} (${e.magnitud})`);
    porLab.set(e.laboratorio, arr);
  }
  return [...porLab.entries()].map(([lab, eq]) => `- Laboratorio de ${lab}: ${eq.join(", ")}`).join("\n");
}

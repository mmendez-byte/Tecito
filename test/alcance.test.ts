import { describe, expect, it } from "vitest";
import { aplicarAlcance, buscarEnAlcance, detectarFueraDeAlcance } from "../src/alcance";
import type { Lead } from "../src/types";

const base: Lead = {
  empresa: "Minera X",
  nombre: "Juan",
  contacto: "juan@minerax.pe",
  equipo: "",
  magnitud: "",
  cantidad: "12",
  ciudad: "Lima",
  plazo: "primera semana de noviembre",
  calificacion: "CALIFICA",
  motivo: "",
  tipoCliente: "Minería",
  resumen: "",
};

describe("buscarEnAlcance", () => {
  it("encuentra por nombre, sinónimo y sin tildes", () => {
    expect(buscarEnAlcance("manómetro")?.laboratorio).toBe("Presión");
    expect(buscarEnAlcance("Manometros de 0 a 10 bar")?.laboratorio).toBe("Presión");
    expect(buscarEnAlcance("pinza amperimetrica")?.laboratorio).toBe("Electricidad");
    expect(buscarEnAlcance("data logger")?.laboratorio).toBe("Temperatura");
  });
  it("devuelve null para equipos desconocidos", () => {
    expect(buscarEnAlcance("espectrofotómetro")).toBeNull();
    expect(buscarEnAlcance("")).toBeNull();
  });
});

describe("detectarFueraDeAlcance", () => {
  it("detecta ensayos y reparaciones", () => {
    expect(detectarFueraDeAlcance("necesito un análisis de agua")?.motivo).toBe("NO ES CALIBRACIÓN");
    expect(detectarFueraDeAlcance("mi balanza está rota, la pueden arreglar")?.motivo).toBe("EQUIPO INOPERATIVO");
    expect(detectarFueraDeAlcance("calibrar 3 manómetros")).toBeNull();
  });
});

describe("aplicarAlcance", () => {
  it("un lead dentro de alcance califica y completa magnitud", () => {
    const l = aplicarAlcance({ ...base, equipo: "manómetros", resumen: "12 manómetros en Lima" });
    expect(l.calificacion).toBe("CALIFICA");
    expect(l.magnitud).toBe("Presión");
    expect(l.motivo).toBe("");
  });
  it("fuerza FUERA DE ALCANCE aunque el modelo haya dicho CALIFICA", () => {
    const l = aplicarAlcance({ ...base, equipo: "espectrofotómetro", resumen: "calibrar espectrofotómetro" });
    expect(l.calificacion).toBe("FUERA DE ALCANCE");
    expect(l.motivo).toBe("EQUIPO FUERA DE ALCANCE");
  });
  it("un ensayo no es calibración", () => {
    const l = aplicarAlcance({ ...base, equipo: "agua", resumen: "análisis microbiológico de agua" });
    expect(l.calificacion).toBe("FUERA DE ALCANCE");
    expect(l.motivo).toBe("NO ES CALIBRACIÓN");
  });
  it("respeta NO ES LEAD aunque el equipo no esté en la lista", () => {
    const l = aplicarAlcance({ ...base, equipo: "ninguno", calificacion: "NO ES LEAD", resumen: "busca trabajo" });
    expect(l.calificacion).toBe("NO ES LEAD");
  });
  it("corrige un FUERA DE ALCANCE equivocado del modelo si el equipo sí está", () => {
    const l = aplicarAlcance({ ...base, equipo: "termohigrómetro", calificacion: "FUERA DE ALCANCE", motivo: "EQUIPO FUERA DE ALCANCE", resumen: "" });
    expect(l.calificacion).toBe("CALIFICA");
  });
});

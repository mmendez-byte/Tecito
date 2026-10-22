import { describe, expect, it } from "vitest";
import { estimateCost } from "../src/guard";
import { textoWhatsapp } from "../src/lead";
import { parseOrigen } from "../src/session";

describe("parseOrigen", () => {
  it("detecta campaña por gclid y lee linea y utm", () => {
    const o = parseOrigen({ url: "https://www.testcontrol.com.pe/calibracion?linea=electrica&gclid=ABC&utm_campaign=search-lima", referrer: "https://www.google.com/" });
    expect(o.canal).toBe("campaña");
    expect(o.gclid).toBe("ABC");
    expect(o.linea).toBe("electrica");
    expect(o.utm_campaign).toBe("search-lima");
  });
  it("detecta orgánico, blog y directo", () => {
    expect(parseOrigen({ url: "https://www.testcontrol.com.pe/", referrer: "https://www.google.com/" }).canal).toBe("orgánico");
    expect(parseOrigen({ url: "https://www.testcontrol.com.pe/blog/medidores-volumetricos/", referrer: "" }).canal).toBe("blog");
    expect(parseOrigen({ url: "https://www.testcontrol.com.pe/", referrer: "" }).canal).toBe("directo");
  });
  it("no rompe con URL inválida", () => {
    expect(parseOrigen({ url: "no es url", referrer: "" }).canal).toBe("directo");
  });
});

describe("textoWhatsapp", () => {
  it("arma el mensaje con los datos disponibles", () => {
    const t = textoWhatsapp({
      empresa: "Minera X", nombre: "Juan", contacto: "", equipo: "manómetros", magnitud: "Presión", cantidad: "12",
      ciudad: "Lima", plazo: "la primera semana de noviembre", calificacion: "CALIFICA", motivo: "", tipoCliente: "", resumen: "",
    });
    expect(t).toContain("soy Juan de Minera X");
    expect(t).toContain("12 manómetros en Lima para la primera semana de noviembre");
  });
});

describe("estimateCost", () => {
  it("una conversación típica con Haiku y caché cuesta centavos", () => {
    // 5 turnos: 8k tokens de system cacheados (1 write + 4 reads), ~300 de entrada y ~200 de salida por turno
    const write = estimateCost("claude-haiku-5-5", { input_tokens: 300, output_tokens: 200, cache_creation_input_tokens: 8000 });
    const read = estimateCost("claude-haiku-5-5", { input_tokens: 300, output_tokens: 200, cache_read_input_tokens: 8000 });
    const total = write + 4 * read;
    expect(total).toBeLessThan(0.003);
  });
});

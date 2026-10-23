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
  it("conserva la entrada del anuncio aunque el chat se abra en otra página", () => {
    const o = parseOrigen({
      url: "https://testcontrol.com.pe/?gclid=ABC&utm_campaign=search-lima",
      referrer: "https://www.google.com/",
      pagina: "https://testcontrol.com.pe/laboratorio-de-presion/?linea=presion",
    });
    expect(o.canal).toBe("campaña");
    expect(o.gclid).toBe("ABC");
    expect(o.linea).toBe("presion");
    expect(o.pagina).toContain("laboratorio-de-presion");
  });
  it("la línea de la página donde se abre el chat gana sobre la de la entrada", () => {
    const o = parseOrigen({ url: "https://testcontrol.com.pe/?linea=electrica", pagina: "https://testcontrol.com.pe/?linea=masa" });
    expect(o.linea).toBe("masa");
    expect(parseOrigen({ url: "https://testcontrol.com.pe/?linea=electrica", pagina: "https://testcontrol.com.pe/contacto/" }).linea).toBe("electrica");
  });
  it("reconoce clics de anuncio de iOS, Microsoft y medios pagos, y guarda la búsqueda", () => {
    expect(parseOrigen({ url: "https://testcontrol.com.pe/?gbraid=X" })).toMatchObject({ canal: "campaña", plataforma: "google" });
    expect(parseOrigen({ url: "https://testcontrol.com.pe/?wbraid=X" })).toMatchObject({ canal: "campaña", plataforma: "google" });
    expect(parseOrigen({ url: "https://testcontrol.com.pe/?msclkid=X" })).toMatchObject({ canal: "campaña", plataforma: "microsoft" });
    expect(parseOrigen({ url: "https://testcontrol.com.pe/?utm_source=facebook&utm_medium=paid_social" })).toMatchObject({ canal: "campaña", plataforma: "meta" });
    const o = parseOrigen({ url: "https://testcontrol.com.pe/?gclid=X&utm_term=calibracion%20de%20balanzas&utm_content=rsa-1" });
    expect(o.utm_term).toBe("calibracion de balanzas");
    expect(o.utm_content).toBe("rsa-1");
  });
  it("un link de Facebook sin medio pago o el perfil de Google con utm orgánico no son campaña", () => {
    expect(parseOrigen({ url: "https://testcontrol.com.pe/?fbclid=X", referrer: "https://l.facebook.com/" })).toMatchObject({ canal: "otro", plataforma: "meta" });
    expect(parseOrigen({ url: "https://testcontrol.com.pe/?utm_source=google&utm_medium=organic", referrer: "https://www.google.com/" }).canal).toBe("orgánico");
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

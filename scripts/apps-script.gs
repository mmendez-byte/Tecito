/**
 * Apps Script de referencia para TES-58.
 * Se pega en Extensiones > Apps Script de la planilla "Seguimiento de Leads Ads" y se publica
 * como aplicación web (ejecutar como: yo; acceso: cualquiera con el enlace).
 *
 * Antes de publicar: Configuración del proyecto > Propiedades del script > agregar TECITO_TOKEN
 * con un valor largo y aleatorio. Ese mismo valor va como secreto SHEETS_ENDPOINT_TOKEN en el Worker.
 */

const COLUMNAS = [
  "Fecha", "Nombre", "Empresa", "Contacto", "Equipo", "Magnitud", "Cantidad", "Ciudad", "Plazo",
  "Calificación", "Motivo de Pérdida", "Tipo de Cliente", "Origen", "GCLID", "URL de entrada", "Fuente", "Notas",
];
const MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

function doPost(e) {
  const token = (e && e.parameter && e.parameter.token) || headerToken_(e);
  const esperado = PropertiesService.getScriptProperties().getProperty("TECITO_TOKEN");
  if (!esperado || token !== esperado) {
    return respuesta_(401, { error: "unauthorized" });
  }

  let lead;
  try {
    lead = JSON.parse(e.postData.contents);
  } catch (err) {
    return respuesta_(400, { error: "json inválido" });
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = hojaDelMes_(ss, new Date(lead.fecha || Date.now()));
  hoja.appendRow([
    new Date(lead.fecha || Date.now()),
    lead.nombre || "", lead.empresa || "", lead.contacto || "", lead.equipo || "", lead.magnitud || "",
    lead.cantidad || "", lead.ciudad || "", lead.plazo || "", lead.calificacion || "", lead.motivoPerdida || "",
    lead.tipoCliente || "", lead.origen || "", lead.gclid || "", lead.urlEntrada || "", lead.fuente || "Tecito", lead.notas || "",
  ]);

  // Conversión para Google Ads (importación programada desde la pestaña "Conversiones Ads")
  if (lead.gclid && lead.calificacion === "CALIFICA") {
    const conv = ss.getSheetByName("Conversiones Ads") || crearHojaConversiones_(ss);
    conv.appendRow([
      lead.gclid,
      "Lead calificado (Tecito)",
      Utilities.formatDate(new Date(lead.fecha || Date.now()), "America/Lima", "yyyy-MM-dd HH:mm:ss"),
      1,
      "PEN",
    ]);
  }

  return respuesta_(200, { ok: true, hoja: hoja.getName() });
}

// Apps Script no expone headers HTTP en doPost; el Worker manda el token también como ?token=.
// Esta función queda por si en el futuro Google lo habilita.
function headerToken_(e) {
  return "";
}

function hojaDelMes_(ss, fecha) {
  const nombre = MESES[fecha.getMonth()] + " " + fecha.getFullYear();
  let hoja = ss.getSheetByName(nombre);
  if (!hoja) {
    hoja = ss.insertSheet(nombre);
    hoja.appendRow(COLUMNAS);
    hoja.setFrozenRows(1);
  } else {
    asegurarColumnas_(hoja);
  }
  return hoja;
}

/** Si la pestaña ya existe con las columnas de Jackeline, agrega al final las que falten. */
function asegurarColumnas_(hoja) {
  const actuales = hoja.getRange(1, 1, 1, Math.max(hoja.getLastColumn(), 1)).getValues()[0].map(String);
  const faltan = ["Origen", "GCLID", "URL de entrada", "Fuente"].filter((c) => actuales.indexOf(c) === -1);
  if (faltan.length) {
    hoja.getRange(1, actuales.length + 1, 1, faltan.length).setValues([faltan]);
  }
}

function crearHojaConversiones_(ss) {
  const h = ss.insertSheet("Conversiones Ads");
  h.appendRow(["Google Click ID", "Conversion Name", "Conversion Time", "Conversion Value", "Conversion Currency"]);
  h.setFrozenRows(1);
  return h;
}

function respuesta_(status, obj) {
  // Apps Script siempre devuelve 200 en la web app; el status real viaja en el cuerpo.
  return ContentService.createTextOutput(JSON.stringify(Object.assign({ status: status }, obj))).setMimeType(ContentService.MimeType.JSON);
}

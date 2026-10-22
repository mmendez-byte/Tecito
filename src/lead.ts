import type { Env, Lead, LeadMessage, Origen, Session } from "./types";

/** Arma el texto que el visitante va a mandar por WhatsApp a Jackeline. */
export function textoWhatsapp(lead: Lead): string {
  const partes: string[] = [];
  partes.push(`Hola${lead.nombre ? `, soy ${lead.nombre}` : ""}${lead.empresa ? ` de ${lead.empresa}` : ""}.`);
  const equipo = [lead.cantidad, lead.equipo].filter(Boolean).join(" ");
  if (equipo) partes.push(`Necesito calibrar ${equipo}${lead.ciudad ? ` en ${lead.ciudad}` : ""}${lead.plazo ? ` para ${lead.plazo}` : ""}.`);
  partes.push("Vengo del asistente del sitio web.");
  return partes.join(" ");
}

export function linkWhatsapp(env: Env, lead: Lead): string {
  return `https://wa.me/${env.WHATSAPP_NUMBER}?text=${encodeURIComponent(textoWhatsapp(lead))}`;
}

/** Encola el lead para que el consumidor escriba planilla, mail y conversión. */
export async function encolarLead(env: Env, session: Session, lead: Lead, origen: Origen): Promise<void> {
  const msg: LeadMessage = {
    sessionId: session.id,
    timestamp: new Date().toISOString(),
    lead,
    origen,
    whatsappText: textoWhatsapp(lead),
  };
  await env.LEADS.send(msg);
}

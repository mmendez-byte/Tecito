import { EmailMessage } from "cloudflare:email";
import type { Env, LeadMessage } from "./types";

/**
 * Aviso por mail cuando un lead califica (y a Matías cuando algo falla).
 * Usa el binding send_email de Cloudflare; el remitente tiene que estar
 * verificado en la cuenta (ver README, "Correo").
 */
export async function enviarAvisoLead(env: Env, msg: LeadMessage): Promise<void> {
  const l = msg.lead;
  const asunto = `Nuevo lead desde el sitio | ${l.empresa || "sin empresa"} | ${l.equipo}`;
  const cuerpo = [
    `Lead calificado por Tecito (${env.ENVIRONMENT})`,
    ``,
    `Fecha: ${msg.timestamp}`,
    `Nombre: ${l.nombre}`,
    `Empresa: ${l.empresa}`,
    `Contacto: ${l.contacto}`,
    `Equipo: ${l.equipo}`,
    `Magnitud: ${l.magnitud}`,
    `Cantidad: ${l.cantidad}`,
    `Ciudad: ${l.ciudad}`,
    `Plazo: ${l.plazo}`,
    `Tipo de cliente: ${l.tipoCliente}`,
    `Calificación: ${l.calificacion}${l.motivo ? ` (${l.motivo})` : ""}`,
    ``,
    `Resumen: ${l.resumen}`,
    ``,
    `Origen: ${msg.origen.canal}${msg.origen.utm_campaign ? ` · campaña ${msg.origen.utm_campaign}` : ""}${msg.origen.linea ? ` · línea ${msg.origen.linea}` : ""}`,
    `Página de entrada: ${msg.origen.url}`,
    `GCLID: ${msg.origen.gclid || "—"}`,
    ``,
    `Mensaje de WhatsApp que se le armó al visitante:`,
    `"${msg.whatsappText}"`,
  ].join("\n");

  await enviar(env, asunto, cuerpo);
}

export async function enviarAlerta(env: Env, asunto: string, cuerpo: string): Promise<void> {
  const to = env.MAIL_TO.split(",").map((s) => s.trim());
  // Las alertas van solo al primero (Matías) para no hacer ruido al cliente.
  await enviar({ ...env, MAIL_TO: to[0] }, `[Tecito ${env.ENVIRONMENT}] ${asunto}`, cuerpo);
}

async function enviar(env: Env, asunto: string, cuerpo: string): Promise<void> {
  const destinatarios = env.MAIL_TO.split(",").map((s) => s.trim()).filter(Boolean);
  const raw = [
    `From: Tecito <${env.MAIL_FROM}>`,
    `To: ${destinatarios.join(", ")}`,
    `Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(asunto)))}?=`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: 8bit`,
    `Message-ID: <${crypto.randomUUID()}@digitalcompi.com>`,
    `Date: ${new Date().toUTCString()}`,
    ``,
    cuerpo,
  ].join("\r\n");

  for (const to of destinatarios) {
    await env.MAIL.send(new EmailMessage(env.MAIL_FROM, to, raw));
  }
}

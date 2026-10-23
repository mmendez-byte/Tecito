// Tienen que coincidir con triggers.crons de cada entorno en wrangler.jsonc (hora de Lima = UTC − 5).
// Viven acá y no en index.ts porque el runtime trata cada export del módulo principal como un handler.
export const CRON_COTEJO = "30 12 * * *"; // todos los días, 7:30 en Lima
export const CRON_INFORME = "0 13 * * 1"; // lunes, 8:00 en Lima

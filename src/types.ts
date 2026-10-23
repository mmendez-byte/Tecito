export interface Env {
  // Bindings
  SESSIONS: KVNamespace;
  METRICS: KVNamespace;
  LEADS: Queue<LeadMessage>;
  MAIL: SendEmail;
  DB: D1Database;

  // Vars (wrangler.jsonc)
  ENVIRONMENT: "dev" | "staging" | "production";
  ALLOWED_ORIGIN: string;
  WHATSAPP_NUMBER: string;
  MODEL_CHAT: string;
  MODEL_VALIDATE: string;
  MONTHLY_BUDGET_USD: string;
  DAILY_BUDGET_USD: string;
  MAX_TOKENS_PER_SESSION: string;
  MAIL_FROM: string;
  MAIL_TO: string;
  TURNSTILE_SITEKEY: string;

  // Secretos (wrangler secret put / GitHub Actions)
  ANTHROPIC_API_KEY: string;
  TURNSTILE_SECRET: string;
  SESSION_SIGNING_KEY: string;
  SHEETS_ENDPOINT_URL: string;
  SHEETS_ENDPOINT_TOKEN: string;
}

export type Calificacion = "CALIFICA" | "FUERA DE ALCANCE" | "SIN RESPUESTA" | "NO ES LEAD";

export type MotivoPerdida =
  | "PRECIO"
  | "ACREDITACIÓN"
  | "COBERTURA GEOGRÁFICA"
  | "EQUIPO FUERA DE ALCANCE"
  | "EQUIPO INOPERATIVO"
  | "PLAZO"
  | "PATRÓN"
  | "NO ES CALIBRACIÓN"
  | "";

export interface Origen {
  /** URL por la que entró al sitio (con gclid y utm), aunque haya abierto el chat en otra página. */
  url: string;
  referrer: string;
  /** Página donde abrió el chat. */
  pagina: string;
  gclid: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_term: string;
  utm_content: string;
  linea: string;
  canal: "campaña" | "orgánico" | "directo" | "blog" | "otro";
  plataforma: "google" | "meta" | "microsoft" | "linkedin" | "";
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface Session {
  id: string;
  createdAt: string;
  origen: Origen;
  messages: ChatMessage[];
  tokensUsed: number;
  costUsd: number;
  lead?: Lead;
  /** Cuándo se encoló el lead para mail y planilla; el cotejo diario lo busca. */
  leadEncolado?: string;
  whatsappClicked?: boolean;
}

export interface Lead {
  empresa: string;
  nombre: string;
  contacto: string;
  equipo: string;
  magnitud: string;
  cantidad: string;
  ciudad: string;
  plazo: string;
  calificacion: Calificacion;
  motivo: MotivoPerdida;
  tipoCliente: string;
  resumen: string;
}

export interface LeadMessage {
  sessionId: string;
  timestamp: string;
  lead: Lead;
  origen: Origen;
  whatsappText: string;
}

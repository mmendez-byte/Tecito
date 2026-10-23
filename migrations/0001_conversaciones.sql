-- Registro durable de cada conversación de Tecito. KV guarda la sesión viva (24 h);
-- esto queda para cotejar que ningún lead se haya perdido y para el informe semanal.
CREATE TABLE conversaciones (
  id TEXT PRIMARY KEY,
  creada TEXT NOT NULL,
  actualizada TEXT NOT NULL,

  -- origen
  canal TEXT,
  plataforma TEXT,
  campania TEXT,
  termino TEXT,
  contenido TEXT,
  linea TEXT,
  url_entrada TEXT,
  pagina TEXT,
  referrer TEXT,
  gclid TEXT,

  -- conversación
  mensajes INTEGER NOT NULL DEFAULT 0,
  ultimo_tecito TEXT,          -- último mensaje de Tecito: si no hay lead, es donde se cortó
  transcripcion TEXT,          -- JSON [{role, content}]; se borra a los 90 días
  whatsapp INTEGER NOT NULL DEFAULT 0,
  costo_usd REAL NOT NULL DEFAULT 0,

  -- ficha (lo que devolvió registrar_lead después de aplicarAlcance)
  calificacion TEXT,
  motivo TEXT,
  equipo TEXT,
  magnitud TEXT,
  cantidad TEXT,
  ciudad TEXT,
  plazo TEXT,
  tipo_cliente TEXT,
  resumen TEXT,
  empresa TEXT,
  nombre TEXT,                 -- se borra a los 90 días
  contacto TEXT,               -- se borra a los 90 días

  -- entrega del lead (lo escribe el consumidor de la cola)
  lead_encolado TEXT,
  mail_ok TEXT,
  planilla_ok TEXT
);

CREATE INDEX conversaciones_creada ON conversaciones (creada);
CREATE INDEX conversaciones_encolado ON conversaciones (lead_encolado) WHERE lead_encolado IS NOT NULL;

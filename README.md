# Tecito

Asistente de chat flotante para el sitio de Test & Control (www.testcontrol.com.pe). Responde con la base de conocimiento del laboratorio, califica la consulta contra el alcance acreditado, deriva a la asesora comercial por WhatsApp con el mensaje armado, y registra el lead en la planilla de seguimiento con su origen.

Corre como un Worker de Cloudflare. WordPress solo carga un `<script>`. El proyecto y las decisiones de diseño están en Linear: proyecto **Tecito — asistente calificador del sitio** (equipo TES) y su documento **Decisiones de diseño**.

## Cómo está armado

```
src/index.ts      router: /session, /message (SSE), /whatsapp-click, /widget.js, /widget.css, /demo, /health
src/session.ts    sesiones en KV (24 h), token HMAC, origen del visitante (gclid, utm, linea, referrer)
src/turnstile.ts  verificación del token de Turnstile al abrir sesión
src/guard.ts      filtro previo al modelo, tope por sesión, presupuesto diario/mensual, kill switch, costos
src/claude.ts     Haiku con prompt cacheado + herramienta registrar_lead; Sonnet valida los que califican
src/alcance.ts    chequeo determinístico contra knowledge/alcance.json
src/lead.ts       texto y link de WhatsApp; encola el lead
src/queue.ts      consumidor: Apps Script (planilla) → mail; reintentos; dead letter
src/mail.ts       aviso por correo (binding send_email de Cloudflare)
knowledge/        tecito-conocimiento.md (system prompt) y alcance.json (lista de equipos)
widget/           widget.js, widget.css, demo.html
scripts/          apps-script.gs (referencia para la planilla), setup-env.sh (KV y colas)
```

Flujo de un mensaje: el widget abre sesión (`/session`, con Turnstile) → recibe un token → manda cada mensaje a `/message` → el Worker pasa el guard, llama a Haiku en streaming y reenvía el texto por SSE → si el modelo llama a `registrar_lead`, el Worker aplica el alcance, valida con Sonnet si califica, encola el lead y manda el evento `handoff` con el link de WhatsApp → el consumidor de la cola escribe la planilla y manda el mail.

## Entornos

| | staging | production |
|---|---|---|
| Worker | `tecito-staging` | `tecito` |
| Despliega con | push a `main` | tag `v*` (`git tag v1.0.0 && git push --tags`) |
| URL | `*.workers.dev` | `tecito.digitalcompi.com` (custom domain) |
| Presupuesto Worker | USD 5/mes, 1/día | USD 15/mes, 2/día |
| Origen permitido | cualquiera | `https://www.testcontrol.com.pe` |

Todo se despliega desde GitHub Actions; no hace falta Wrangler en ninguna máquina. El workflow corre typecheck y tests antes de desplegar, y sube los secretos del Worker desde los secretos del repo en cada deploy.

## Puesta en marcha (una sola vez)

1. **Token de Cloudflare.** En el panel: My Profile → API Tokens → Create Token, con permisos *Workers Scripts: Edit*, *Workers KV Storage: Edit*, *Queues: Edit*, *Account Settings: Read*. Guardarlo en GitHub como `CLOUDFLARE_API_TOKEN`, y el Account ID como `CLOUDFLARE_ACCOUNT_ID`.
2. **Recursos.** Actions → *Setup Cloudflare resources* → Run workflow → `staging`. Copiar los dos IDs de KV que imprime y pegarlos en `wrangler.jsonc` (reemplazan `REEMPLAZAR_KV_*_STAGING`). Repetir con `production` cuando toque.
3. **Turnstile.** En Cloudflare → Turnstile → Add widget, dominios `testcontrol.com.pe` y `digitalcompi.com`, modo *Managed*. El site key va en `wrangler.jsonc` (`TURNSTILE_SITEKEY`); el secret key va a GitHub como `TURNSTILE_SECRET_STAGING` / `_PRODUCTION`.
4. **Secretos del Worker** en GitHub (Settings → Secrets → Actions), uno por entorno:
   - `ANTHROPIC_API_KEY_*`: key del workspace "Test & Control" de la Console (TES-61).
   - `SESSION_SIGNING_KEY_*`: cadena aleatoria larga (`openssl rand -hex 32`).
   - `SHEETS_ENDPOINT_URL_*` y `SHEETS_ENDPOINT_TOKEN_*`: los que entrega Gómez al publicar el Apps Script (TES-58). Pueden faltar en staging; el Worker lo avisa en logs y sigue.
5. **Correo.** En Cloudflare → Email → Email Sending, verificar el dominio `digitalcompi.com` y crear la dirección `tecito@digitalcompi.com` (registros SPF y DKIM que indica el panel). Sin esto el binding `MAIL` falla y los leads quedan reintentando en la cola.
6. **Dominio de producción.** `tecito.digitalcompi.com` tiene que estar en una zona de Cloudflare de la cuenta; el deploy crea el registro solo (`custom_domain: true`).
7. **Rate limiting.** En Cloudflare → Security → WAF → Rate limiting rules, sobre la zona de `digitalcompi.com`: ruta `/message`, 10 requests por minuto por IP, acción *Block* 1 minuto; y una segunda regla de 40 por hora. Son parte de las capas contra bots; el Worker por sí solo no las impone.
8. Push a `main`. El workflow despliega staging y hace un smoke test a `/health` y `/widget.js`.

## Instalación en el sitio (TES-60)

Un widget HTML de Elementor en el footer global con:

```html
<script src="https://tecito.digitalcompi.com/widget.js" defer></script>
```

Para staging, la URL del Worker `*.workers.dev`. Nada más va en WordPress. La página de demostración está en `/demo`.

## Operación

- **Apagar el chat ya**: `npm run killswitch:on` (o crear la clave `killswitch` = `1` en el KV `METRICS` desde el panel). El widget pasa a mostrar solo el botón de WhatsApp. `killswitch:off` lo vuelve a prender.
- **Gasto**: claves `spend:day:AAAA-MM-DD` y `spend:month:AAAA-MM` en `METRICS`, en USD. Al superar el tope, el chat se apaga solo hasta el día o mes siguiente.
- **Sesiones**: resúmenes en `METRICS` bajo `summary:AAAA-MM-DD:<id>` (canal, línea, mensajes, calificación, si tocó WhatsApp, costo). Viven 90 días. Sirven para ver dónde se cae la gente.
- **Leads que no entraron a la planilla**: cola `tecito-leads-dlq` en el panel de Queues; el consumidor avisa por mail al agotar los 12 reintentos.
- **Rotar una key**: cambiar el secreto en GitHub y volver a correr el workflow *Deploy* (workflow_dispatch) para ese entorno. `wrangler secret bulk` la reemplaza.
- **Actualizar la base de conocimiento**: editar `knowledge/tecito-conocimiento.md` y `knowledge/alcance.json`, push. Los tests de `alcance` validan que los equipos sigan resolviendo.

## Desarrollo local (opcional)

```
cp .dev.vars.example .dev.vars   # completar la key de Anthropic
npm install
npm run dev                      # http://localhost:8787/demo
npm test
```

No es necesario para operar: todo lo importante corre en Actions.

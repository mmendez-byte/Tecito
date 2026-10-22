# Tecito — reglas para agentes

Tecito es el asistente de chat del sitio de Test & Control (Perú), cliente de COMPi. Es un Worker de Cloudflare que llama a la API de Claude. El contexto de negocio, el reparto de trabajo y las decisiones ya tomadas están en Linear, equipo TES, proyecto "Tecito — asistente calificador del sitio" y su documento "Decisiones de diseño". Leerlos antes de proponer cambios de arquitectura; no reabrir lo que ya está decidido ahí (Worker en lugar de WordPress, n8n o Make; Haiku + Sonnet; Apps Script para la planilla; aviso por mail en la primera etapa).

## Lo que no se toca sin aprobación de Matías Méndez

- `knowledge/tecito-conocimiento.md` y `knowledge/alcance.json` en producción: son lo que Tecito afirma en nombre del laboratorio y los valida Carmen con los metrólogos. Se puede editar en una rama; no se mergea a `main` sin que Matías lo apruebe.
- Los topes de presupuesto en `wrangler.jsonc` (`MONTHLY_BUDGET_USD`, `DAILY_BUDGET_USD`) y el precio por token en `src/guard.ts`.
- Los valores de `calificacion` y `motivo`: son los de la planilla de Jackeline (convención de agosto 2026) y no se cambian desde acá.
- El número de WhatsApp y los destinatarios de mail de producción.
- Nada que relaje las capas contra bots (Turnstile, guard, presupuesto).

## Reglas de código

- Sin dependencias de runtime: el Worker usa `fetch` contra la API de Anthropic directamente para no depender de que un SDK soporte streaming con herramientas en Workers. Si se agrega una dependencia, justificar en el PR.
- El system prompt grande va siempre con `cache_control`; el contexto por sesión va en un bloque aparte después. Romper eso multiplica el costo por diez.
- Toda llamada a un servicio externo (Anthropic, Apps Script, mail) está detrás del guard o de la cola. No agregar llamadas directas desde `/message` que no pasen por `guardMessage`.
- El modelo propone; `aplicarAlcance` decide. Nunca aceptar la calificación del modelo sin pasar por ahí.
- Secretos solo por `wrangler secret` / GitHub Actions. Nada en código, en `wrangler.jsonc` ni en Linear.
- Textos del widget y del asistente en español neutro de Perú, trato de usted. Nada de voseo en lo que ve el visitante.
- Antes de un PR: `npm run typecheck && npm test`. El workflow los corre igual, pero no gastar un deploy en algo que no compila.

## Cómo se despliega

Push a `main` → staging. Tag `v*` → producción. Nunca desplegar producción a mano desde una máquina; si hace falta, workflow_dispatch del workflow *Deploy*. Ver README.

## Cuando algo falla

- Chat caído o gastando de más: `npm run killswitch:on` (o la clave `killswitch` en KV `METRICS`). Avisar a Matías.
- Leads sin registrar: mirar la DLQ `tecito-leads(-staging)-dlq` y los logs del consumidor; lo más probable es el Apps Script (token o URL) o el remitente de mail no verificado.
- No hay staging local con datos reales ni acceso a la planilla de Jackeline desde este repo; para probar la planilla se usa la de prueba que publica Gómez.

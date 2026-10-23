/* Tecito — widget flotante para testcontrol.com.pe
 * Se instala con un solo <script src="https://tecito.digitalcompi.com/widget.js" defer></script>
 * (en Elementor: widget HTML en el footer global). No depende de WordPress ni de jQuery.
 */
(function () {
  "use strict";

  const BASE = "__TECITO_BASE__";
  const TURNSTILE_SITEKEY = "__TECITO_TURNSTILE_SITEKEY__";
  const STORAGE_KEY = "tecito.session";
  const ENTRADA_KEY = "tecito.entrada";
  const ENTRADA_TTL = 30 * 24 * 3600e3; // 30 días: un clic de anuncio cuenta si vuelve dentro de ese plazo
  const PARAMS_CAMPANIA = ["gclid", "gbraid", "wbraid", "msclkid", "fbclid", "li_fat_id", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
  const MAX_HISTORIAL = 60;
  const AVATAR = BASE + "/avatar.svg"; // reemplazar por el personaje Tecito cuando esté el SVG

  const SHORTCUTS = [
    { label: "Quiero cotizar una calibración", text: "Quiero cotizar una calibración." },
    { label: "¿Calibran mi equipo?", text: "Quiero saber si calibran un equipo que tengo." },
    { label: "Consulta sobre certificados", text: "Tengo una consulta sobre los certificados de calibración." },
    { label: "Hablar con Jackeline", text: "Quiero hablar con una asesora comercial." },
  ];

  const LINEAS = {
    electrica: "equipos eléctricos (multímetros, pinzas amperimétricas, medidores de aislamiento)",
    presion: "equipos de presión (manómetros, transmisores)",
    temperatura: "equipos de temperatura (termómetros, dataloggers, hornos)",
    masa: "balanzas y pesas",
    longitud: "instrumentos de longitud (pie de rey, micrómetros)",
  };

  // ---------- Estado ----------
  let state = { token: null, sessionId: null, enabled: true, whatsapp: null, linea: "" };
  let sessionExp = 0;
  let historial = []; // lo que se ve en la ventana, para seguir la conversación en otra página del sitio
  let busy = false;
  let started = false;

  // ---------- Entrada al sitio ----------
  // Se guarda al cargar cualquier página, antes de abrir el chat: el gclid y los utm vienen solo en la
  // primera URL, y el visitante puede navegar varias páginas antes de escribir. Gana la última entrada
  // que no fue directa (anuncio, buscador u otro sitio); la navegación interna no la pisa.
  const entrada = guardarEntrada();

  function guardarEntrada() {
    const actual = { url: location.href, referrer: document.referrer, ts: Date.now() };
    try {
      const params = new URLSearchParams(location.search);
      const conCampania = PARAMS_CAMPANIA.some((k) => params.has(k));
      let externo = false;
      try { externo = !!document.referrer && sinWww(new URL(document.referrer).hostname) !== sinWww(location.hostname); } catch (_) {}
      const previa = safeJson(localStorage.getItem(ENTRADA_KEY));
      const vigente = previa && previa.ts > Date.now() - ENTRADA_TTL;
      if (conCampania || externo || !vigente) {
        const nueva = { url: location.href, referrer: externo ? document.referrer : "", ts: Date.now() };
        localStorage.setItem(ENTRADA_KEY, JSON.stringify(nueva));
        return nueva;
      }
      return previa;
    } catch (_) {
      return actual;
    }
  }
  function sinWww(h) { return h.replace(/^www\./, ""); }

  // ---------- CSS ----------
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = BASE + "/widget.css";
  document.head.appendChild(link);

  // ---------- DOM ----------
  const root = document.createElement("div");
  root.id = "tecito-root";
  root.innerHTML = `
    <button class="tc-bubble" type="button" aria-label="Abrir el asistente de Test & Control">
      ${avatar()}
      <span class="tc-bubble-label">¿Te ayudo a calibrar?</span>
    </button>
    <div class="tc-window" role="dialog" aria-label="Tecito, asistente de Test & Control" aria-modal="true">
      <div class="tc-header">
        ${avatar()}
        <div>
          <div class="tc-title">Tecito</div>
          <div class="tc-subtitle">Asistente de Test &amp; Control</div>
        </div>
        <button class="tc-close" type="button" aria-label="Cerrar">×</button>
      </div>
      <div class="tc-body"></div>
      <div class="tc-turnstile" hidden></div>
      <form class="tc-input">
        <textarea rows="1" placeholder="Escribe tu consulta…" aria-label="Tu mensaje" maxlength="2000"></textarea>
        <button class="tc-send" type="submit">Enviar</button>
      </form>
      <div class="tc-footer">Calibración acreditada · Lima, Perú</div>
    </div>`;
  document.body.appendChild(root);

  const bubble = root.querySelector(".tc-bubble");
  const win = root.querySelector(".tc-window");
  const body = root.querySelector(".tc-body");
  const form = root.querySelector(".tc-input");
  const textarea = form.querySelector("textarea");
  const sendBtn = form.querySelector(".tc-send");
  const tsBox = root.querySelector(".tc-turnstile");

  bubble.addEventListener("click", open);
  root.querySelector(".tc-close").addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && root.classList.contains("tc-open")) close(); });
  form.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  textarea.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } });
  textarea.addEventListener("input", () => { textarea.style.height = "auto"; textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px"; });

  // ---------- Apertura / sesión ----------
  async function open() {
    root.classList.add("tc-open");
    if (!started) {
      started = true;
      await ensureSession();
      if (historial.length) renderHistorial(); else renderIntro();
    }
    textarea.focus();
  }
  function close() { root.classList.remove("tc-open"); }

  async function ensureSession() {
    const saved = safeJson(localStorage.getItem(STORAGE_KEY));
    if (saved && saved.token && saved.exp > Date.now()) {
      state = saved.state; sessionExp = saved.exp; historial = Array.isArray(saved.historial) ? saved.historial : [];
      return;
    }

    const turnstile = await getTurnstileToken();
    const res = await fetch(BASE + "/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: entrada.url, referrer: entrada.referrer, pagina: location.href, turnstile }),
    });
    if (!res.ok) { state.enabled = false; return; }
    const data = await res.json();
    state = { token: data.token, sessionId: data.sessionId, enabled: data.enabled, whatsapp: data.whatsapp, linea: data.linea || "" };
    sessionExp = Date.now() + 5 * 3600e3;
    historial = [];
    guardarSesion();
  }

  function guardarSesion() {
    if (historial.length > MAX_HISTORIAL) historial = historial.slice(-MAX_HISTORIAL);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: state.token, exp: sessionExp, state, historial })); } catch (_) {}
  }
  function recordar(item) { historial.push(item); guardarSesion(); }

  function getTurnstileToken() {
    if (!TURNSTILE_SITEKEY || TURNSTILE_SITEKEY.startsWith("__")) return Promise.resolve("");
    return new Promise((resolve) => {
      const done = (t) => { tsBox.hidden = true; resolve(t); };
      const render = () => {
        tsBox.hidden = false;
        window.turnstile.render(tsBox, { sitekey: TURNSTILE_SITEKEY, size: "flexible", callback: done, "error-callback": () => done("") });
      };
      if (window.turnstile) return render();
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.onload = render; s.onerror = () => done("");
      document.head.appendChild(s);
    });
  }

  // ---------- Render ----------
  function renderIntro() {
    const intro = document.createElement("div");
    intro.className = "tc-intro";
    const lineaTxt = LINEAS[state.linea] ? ` Veo que llegaste por ${LINEAS[state.linea]}.` : "";
    intro.innerHTML = `<p>Hola, soy Tecito.${lineaTxt} Puedo ayudarte a saber si calibramos tu equipo y pasarte con nuestra asesora comercial. ¿Qué necesitas?</p>`;
    if (!state.enabled) {
      intro.innerHTML = `<p>En este momento el asistente no está disponible. Puedes escribirle directo a nuestra asesora comercial.</p>`;
      intro.appendChild(waButton(state.whatsapp, ""));
      form.hidden = true;
    } else {
      SHORTCUTS.forEach((s) => {
        const b = document.createElement("button");
        b.type = "button"; b.className = "tc-shortcut"; b.textContent = s.label;
        b.addEventListener("click", () => { intro.remove(); send(s.text); });
        intro.appendChild(b);
      });
    }
    body.appendChild(intro);
  }

  function renderHistorial() {
    historial.forEach((h) => {
      if (h.handoff) renderHandoff(h.handoff, true);
      else addMsg(h.role, h.text);
    });
  }

  function addMsg(role, text) {
    const d = document.createElement("div");
    d.className = "tc-msg " + (role === "user" ? "tc-user" : "tc-bot");
    d.textContent = text;
    body.appendChild(d); scroll();
    return d;
  }

  function waButton(href, text) {
    const a = document.createElement("a");
    a.className = "tc-wa"; a.href = href; a.target = "_blank"; a.rel = "noopener";
    a.textContent = "Continuar por WhatsApp";
    a.addEventListener("click", () => {
      if (state.token) fetch(BASE + "/whatsapp-click", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: state.token }), keepalive: true }).catch(() => {});
      if (window.gtag) window.gtag("event", "tecito_whatsapp_click");
    });
    return a;
  }

  function renderHandoff(data, restaurado) {
    const box = document.createElement("div");
    box.className = "tc-handoff";
    box.innerHTML = `<div class="tc-handoff-title">Te paso con Jackeline</div>`;
    if (data.text) {
      const t = document.createElement("div"); t.className = "tc-handoff-text"; t.textContent = data.text; box.appendChild(t);
    }
    box.appendChild(waButton(data.whatsapp, data.text));
    body.appendChild(box); scroll();
    if (!restaurado && window.gtag && data.lead) window.gtag("event", "tecito_lead_calificado");
  }

  function scroll() { body.scrollTop = body.scrollHeight; }

  // ---------- Envío ----------
  function submit() {
    const t = textarea.value.trim();
    if (!t || busy) return;
    textarea.value = ""; textarea.style.height = "auto";
    const intro = body.querySelector(".tc-intro"); if (intro) intro.remove();
    send(t);
  }

  async function send(text) {
    if (busy || !state.token) return;
    busy = true; sendBtn.disabled = true;
    addMsg("user", text);
    recordar({ role: "user", text });
    const typing = document.createElement("div"); typing.className = "tc-typing"; typing.textContent = "Tecito está escribiendo…"; body.appendChild(typing); scroll();

    let bot = null;
    // Guarda el texto de Tecito antes de lo que venga después (el handoff), para restaurarlo en el mismo orden.
    const cerrarBot = () => { if (bot && bot.textContent) recordar({ role: "bot", text: bot.textContent }); bot = null; };
    try {
      const res = await fetch(BASE + "/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: state.token, text }),
      });
      if (res.status === 401 || res.status === 410) { localStorage.removeItem(STORAGE_KEY); historial = []; started = false; typing.remove(); addMsg("bot", "La sesión venció. Vuelve a abrir el asistente."); return; }
      if (!res.ok || !res.body) throw new Error("http " + res.status);

      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = (chunk.match(/^event: (.*)$/m) || [])[1];
          const data = safeJson((chunk.match(/^data: (.*)$/m) || [])[1]);
          if (!ev || !data) continue;
          if (ev === "text") { typing.remove(); if (!bot) bot = addMsg("bot", ""); bot.textContent += data.delta; scroll(); }
          else if (ev === "handoff") { typing.remove(); cerrarBot(); renderHandoff(data); recordar({ handoff: data }); }
          else if (ev === "error") { typing.remove(); addMsg("bot", data.message); if (data.whatsapp) body.appendChild(waButton(data.whatsapp, "")); }
        }
      }
    } catch (e) {
      typing.remove();
      addMsg("bot", "No pude responder en este momento. Puedes escribirle directo a nuestra asesora comercial.");
      if (state.whatsapp) body.appendChild(waButton(state.whatsapp, ""));
    } finally {
      cerrarBot();
      busy = false; sendBtn.disabled = false; textarea.focus();
    }
  }

  // ---------- util ----------
  function safeJson(s) { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } }
  function avatar() {
    // Placeholder hasta tener el SVG de Tecito: una gota con una "T".
    return `<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="20" fill="#fff"/><text x="20" y="26" text-anchor="middle" font-size="18" font-weight="700" fill="#0b3c6e" font-family="system-ui">T</text></svg>`;
  }
})();

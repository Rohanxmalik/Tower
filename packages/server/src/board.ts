/**
 * The live radar board — a single self-contained HTML page served at /board.
 * No external assets (fonts/CDNs); polls GET /api/board with the bearer token.
 * All claim data is rendered via textContent (never innerHTML) so agent-supplied
 * strings cannot inject markup.
 */
export const BOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>TOWER — live board</title>
<style>
  :root {
    --bg: #070b0f; --panel: #0e141b; --line: #1c2733;
    --green: #38e08a; --amber: #f0b429; --red: #ff4d4d; --cyan: #4cc9f0;
    --ink: #c9d6df; --muted: #6b7b88;
    --mono: "IBM Plex Mono", "Cascadia Code", Consolas, Menlo, monospace;
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    background: var(--bg); color: var(--ink); font-family: var(--mono);
    min-height: 100vh; padding: 1.2rem; position: relative; overflow-x: hidden;
  }
  .sweep {
    position: fixed; inset: -40vmax; pointer-events: none; opacity: 0.5;
    background: conic-gradient(from 0deg, transparent 0deg, rgba(56,224,138,0.05) 40deg, transparent 60deg);
    animation: sweep 6s linear infinite;
  }
  @keyframes sweep { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .sweep { animation: none; } }
  header {
    display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;
    border-bottom: 1px solid var(--line); padding-bottom: 0.8rem; margin-bottom: 1rem;
  }
  .brand { color: #fff; letter-spacing: 0.25em; font-weight: 700; }
  .brand small { color: var(--muted); letter-spacing: 0.1em; font-weight: 400; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); }
  .dot.ok { background: var(--green); box-shadow: 0 0 8px var(--green); }
  .dot.err { background: var(--red); box-shadow: 0 0 8px var(--red); }
  #status { color: var(--muted); font-size: 0.75rem; letter-spacing: 0.1em; }
  #tokenwrap { margin-left: auto; display: flex; gap: 0.4rem; }
  input {
    background: var(--panel); border: 1px solid var(--line); color: var(--ink);
    font-family: var(--mono); font-size: 0.75rem; padding: 0.35rem 0.6rem; border-radius: 4px;
  }
  input:focus { outline: 1px solid var(--cyan); }
  #alerts { display: grid; gap: 0.5rem; margin-bottom: 1rem; }
  .alert {
    border: 1px solid var(--red); background: rgba(255,77,77,0.07); border-radius: 6px;
    padding: 0.6rem 0.9rem; font-size: 0.8rem; animation: flash 1.2s ease-in-out infinite alternate;
  }
  .alert.soft { border-color: var(--amber); background: rgba(240,180,41,0.06); animation: none; }
  @keyframes flash { from { box-shadow: 0 0 0 rgba(255,77,77,0); } to { box-shadow: 0 0 14px rgba(255,77,77,0.35); } }
  @media (prefers-reduced-motion: reduce) { .alert { animation: none; } }
  .alert b { color: #fff; }
  .alert .why { color: var(--muted); display: block; margin-top: 0.2rem; }
  #strips { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 0.8rem; }
  .strip {
    background: var(--panel); border: 1px solid var(--line); border-left: 4px solid var(--green);
    border-radius: 6px; padding: 0.7rem 0.9rem; font-size: 0.78rem;
  }
  .strip.hard { border-left-color: var(--red); }
  .strip.soft { border-left-color: var(--amber); }
  .strip .call { color: #fff; font-weight: 700; letter-spacing: 0.06em; }
  .strip .scope { color: var(--cyan); font-size: 0.7rem; }
  .strip .purpose { color: var(--ink); margin: 0.35rem 0; }
  .chips { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-bottom: 0.45rem; }
  .chip {
    background: var(--bg); border: 1px solid var(--line); border-radius: 3px;
    padding: 0.05rem 0.4rem; font-size: 0.68rem; color: var(--muted);
  }
  .meta { display: flex; justify-content: space-between; color: var(--muted); font-size: 0.68rem; }
  .ttl { height: 3px; background: var(--line); border-radius: 2px; margin-top: 0.45rem; overflow: hidden; }
  .ttl i { display: block; height: 100%; background: var(--green); }
  .strip.hard .ttl i { background: var(--red); }
  .strip.soft .ttl i { background: var(--amber); }
  #empty { color: var(--muted); text-align: center; padding: 4rem 1rem; letter-spacing: 0.2em; }
  #empty .big { color: var(--green); font-size: 1.1rem; margin-bottom: 0.5rem; }
</style>
</head>
<body>
<div class="sweep" aria-hidden="true"></div>
<header>
  <span class="brand">TOWER <small>/ LIVE BOARD</small></span>
  <span class="dot" id="dot"></span><span id="status">CONNECTING…</span>
  <span id="tokenwrap"><input id="token" type="password" placeholder="TOWER_TOKEN (if required)" autocomplete="off" /></span>
</header>
<div id="alerts"></div>
<div id="strips"></div>
<div id="empty" hidden><div class="big">ALL CLEAR</div>no active claims — agents are safe to proceed</div>
<script>
(function () {
  "use strict";
  var tokenInput = document.getElementById("token");
  var dot = document.getElementById("dot");
  var statusEl = document.getElementById("status");
  var alertsEl = document.getElementById("alerts");
  var stripsEl = document.getElementById("strips");
  var emptyEl = document.getElementById("empty");
  tokenInput.value = localStorage.getItem("tower-token") || "";
  tokenInput.addEventListener("change", function () {
    localStorage.setItem("tower-token", tokenInput.value.trim());
    poll();
  });

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text; // textContent only — XSS-safe
    return n;
  }

  function setStatus(kind, text) {
    dot.className = "dot" + (kind ? " " + kind : "");
    statusEl.textContent = text;
  }

  function fmtAge(ms) {
    var m = Math.floor(ms / 60000);
    return m < 1 ? "<1m" : m < 60 ? m + "m" : Math.floor(m / 60) + "h" + (m % 60) + "m";
  }

  function severityOf(claimId, conflicts) {
    var sev = "";
    conflicts.forEach(function (c) {
      if (c.aClaimId !== claimId && c.bClaimId !== claimId) return;
      if (c.severity === "hard") sev = "hard";
      else if (c.severity === "soft" && sev !== "hard") sev = "soft";
    });
    return sev;
  }

  function render(data) {
    alertsEl.replaceChildren();
    data.conflicts.forEach(function (c) {
      var a = el("div", "alert" + (c.severity === "soft" ? " soft" : ""));
      var head = el("div");
      head.appendChild(el("b", "", c.severity === "hard" ? "⛔ COLLISION " : "△ OVERLAP "));
      head.appendChild(
        el("span", "", c.aAgentId + " × " + c.bAgentId +
          (c.overlap && c.overlap.length && c.overlap[0].symbol ? " — " + c.overlap[0].symbol : "")),
      );
      a.appendChild(head);
      a.appendChild(el("span", "why", c.reason));
      alertsEl.appendChild(a);
    });

    stripsEl.replaceChildren();
    data.claims.forEach(function (cl) {
      var sev = severityOf(cl.id, data.conflicts);
      var s = el("div", "strip" + (sev ? " " + sev : ""));
      var top = el("div");
      top.appendChild(el("span", "call", cl.agentId.toUpperCase()));
      top.appendChild(el("span", "scope", "  " + cl.repo + " @ " + cl.branch));
      s.appendChild(top);
      s.appendChild(el("div", "purpose", cl.purpose || "(no purpose given)"));
      var chips = el("div", "chips");
      var names = [];
      (cl.symbols || []).forEach(function (sym) { if (sym.symbol) names.push(sym.symbol); });
      if (!names.length) (cl.files || []).forEach(function (f) { names.push(f); });
      names.slice(0, 6).forEach(function (n) { chips.appendChild(el("span", "chip", n)); });
      if (names.length > 6) chips.appendChild(el("span", "chip", "+" + (names.length - 6)));
      s.appendChild(chips);
      var meta = el("div", "meta");
      meta.appendChild(el("span", "", "age " + fmtAge(data.now - cl.createdAt)));
      meta.appendChild(el("span", "", cl.etaMinutes ? "ETA ~" + cl.etaMinutes + "m" : ""));
      meta.appendChild(el("span", "", "expires " + fmtAge(Math.max(0, cl.expiresAt - data.now))));
      s.appendChild(meta);
      var ttl = el("div", "ttl");
      var bar = el("i");
      var frac = Math.max(0, Math.min(1, (cl.expiresAt - data.now) / (15 * 60000)));
      bar.style.width = Math.round(frac * 100) + "%";
      ttl.appendChild(bar);
      s.appendChild(ttl);
      stripsEl.appendChild(s);
    });
    emptyEl.hidden = data.claims.length > 0;
  }

  function poll() {
    var headers = {};
    var tok = localStorage.getItem("tower-token") || "";
    if (tok) headers.authorization = "Bearer " + tok;
    fetch("api/board", { headers: headers, cache: "no-store" })
      .then(function (res) {
        if (res.status === 401) { setStatus("err", "TOKEN REQUIRED — enter it top right"); return null; }
        if (res.status === 429) { setStatus("err", "LOCKED OUT — too many bad tokens, wait 1m"); return null; }
        if (!res.ok) { setStatus("err", "ERROR " + res.status); return null; }
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        setStatus("ok", "CONNECTED — " + data.claims.length + " active claim(s)");
        render(data);
      })
      .catch(function () { setStatus("err", "OFFLINE — is the server up?"); });
  }

  poll();
  setInterval(poll, 2000);
})();
</script>
</body>
</html>
`;

/**
 * The live board — a single self-contained HTML page served at /board.
 * No external assets (fonts/CDNs). Polls GET /api/board; can POST /api/task (delegate
 * a task) and /api/approve (approve/reject) with the same bearer token, so a phone is a
 * remote control for your agents. All agent-supplied strings render via textContent
 * (never innerHTML) so they cannot inject markup.
 */
export const BOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>TOWER — team board</title>
<style>
  :root {
    --bg: #0a0f14; --panel: #111922; --panel2: #0d141b; --line: #22303c;
    --green: #38e08a; --amber: #f0b429; --red: #ff5c5c; --cyan: #52ccf0;
    --ink: #d6e2ea; --muted: #7c8b98;
    --ui: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: "IBM Plex Mono", "Cascadia Code", Consolas, Menlo, monospace;
  }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--ink); font-family: var(--ui); line-height: 1.5;
    padding: 1rem; max-width: 1100px; margin: 0 auto; -webkit-font-smoothing: antialiased; }
  h1 { font-size: 1rem; letter-spacing: 0.28em; color: #fff; font-weight: 700; }
  h1 small { color: var(--muted); letter-spacing: 0.1em; font-weight: 400; font-size: 0.72rem; }
  h2 { font-size: 0.72rem; letter-spacing: 0.18em; text-transform: uppercase; color: var(--muted);
    margin: 1.4rem 0 0.6rem; font-weight: 600; }
  header { display: flex; align-items: center; gap: 0.7rem; flex-wrap: wrap;
    border-bottom: 1px solid var(--line); padding-bottom: 0.8rem; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); flex: none; }
  .dot.ok { background: var(--green); box-shadow: 0 0 8px var(--green); }
  .dot.err { background: var(--red); box-shadow: 0 0 8px var(--red); }
  #status { color: var(--muted); font-size: 0.75rem; }
  #tok { margin-left: auto; }
  #forget { background: none; border: 1px solid var(--muted); color: var(--muted); border-radius: 6px; padding: 0.25rem 0.5rem; font-size: 0.72rem; cursor: pointer; }
  #forget:hover { color: var(--ink); border-color: var(--ink); }
  input, textarea, select, button { font-family: var(--ui); font-size: 0.85rem; }
  input, textarea, select { background: var(--panel2); border: 1px solid var(--line); color: var(--ink);
    padding: 0.5rem 0.6rem; border-radius: 6px; }
  input:focus, textarea:focus { outline: 1px solid var(--cyan); }
  button { cursor: pointer; border: 1px solid var(--line); background: var(--panel); color: var(--ink);
    padding: 0.5rem 0.9rem; border-radius: 6px; font-weight: 600; }
  button:hover { border-color: var(--cyan); }
  .btn-go { background: var(--cyan); color: #05121a; border-color: var(--cyan); }
  .btn-ok { background: var(--green); color: #04150c; border-color: var(--green); }
  .btn-no { background: transparent; color: var(--red); border-color: var(--red); }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 0.9rem; }
  .muted { color: var(--muted); }
  .cols { display: grid; grid-template-columns: 1fr 300px; gap: 1.2rem; align-items: start; }
  @media (max-width: 820px) { .cols { grid-template-columns: 1fr; } }

  /* Send box — the mobile remote */
  #send { display: grid; gap: 0.5rem; margin-top: 1rem; }
  #send .row { display: flex; gap: 0.5rem; }
  #send textarea { flex: 1; resize: vertical; min-height: 2.6rem; }
  #send input.to { width: 8rem; }
  #send .hint { font-size: 0.72rem; }
  @media (max-width: 520px) { #send .row { flex-direction: column; } #send input.to { width: 100%; } }

  /* Approvals — needs your OK */
  .approve { border-color: var(--amber); background: rgba(240,180,41,0.07); display: grid; gap: 0.5rem;
    margin-bottom: 0.6rem; }
  .approve .q { color: #fff; }
  .approve .cmd { color: var(--amber); font-family: var(--mono); font-size: 0.82rem; }
  .approve .btns { display: flex; gap: 0.5rem; }

  /* Collision banner */
  .collision { border-color: var(--red); background: rgba(255,92,92,0.08); color: #fff;
    margin-bottom: 0.5rem; }
  .collision .why { color: var(--muted); font-size: 0.82rem; margin-top: 0.2rem; }

  /* Delegation tree */
  .task { border-top: 1px solid var(--line); padding: 0.7rem 0; }
  .task:first-child { border-top: 0; }
  .task .line1 { color: var(--ink); }
  .task .who { color: #fff; font-weight: 600; }
  .task .arrow { color: var(--muted); }
  .task .cmd { color: var(--ink); font-family: var(--mono); font-size: 0.85rem;
    background: var(--panel2); border-left: 2px solid var(--line); padding: 0.35rem 0.6rem;
    border-radius: 0 4px 4px 0; margin: 0.35rem 0 0.2rem; white-space: pre-wrap; word-break: break-word; }
  .reply { margin: 0.3rem 0 0 1rem; padding-left: 0.7rem; border-left: 2px solid var(--green);
    color: var(--ink); font-size: 0.85rem; }
  .reply.fail { border-left-color: var(--red); }
  .reply .r-who { color: var(--green); font-weight: 600; }
  .reply.fail .r-who { color: var(--red); }
  .refs { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.3rem; align-items: center; }
  .refs a, .refs .sha { font-family: var(--mono); font-size: 0.72rem; color: var(--cyan);
    border: 1px solid var(--line); border-radius: 3px; padding: 0.05rem 0.4rem; }
  .refs .sha { color: var(--muted); }
  .st { display: inline-block; border-radius: 4px; padding: 0.05rem 0.45rem; font-size: 0.66rem;
    font-weight: 700; letter-spacing: 0.05em; border: 1px solid; margin-left: 0.4rem; vertical-align: 1px; }
  .st.waiting { color: var(--amber); border-color: var(--amber); }
  .st.needsok { color: var(--amber); border-color: var(--amber); background: rgba(240,180,41,0.12); }
  .st.running { color: var(--cyan); border-color: var(--cyan); }
  .st.done { color: var(--green); border-color: var(--green); }
  .st.failed { color: var(--red); border-color: var(--red); }
  .when { color: var(--muted); font-size: 0.72rem; }

  /* Roster + editing + activity */
  .agent { display: flex; align-items: baseline; gap: 0.5rem; padding: 0.4rem 0; border-top: 1px solid var(--line); }
  .agent:first-child { border-top: 0; }
  .agent .name { color: #fff; font-weight: 600; font-size: 0.85rem; }
  .agent .doing { color: var(--muted); font-size: 0.78rem; }
  .agent .busy { color: var(--amber); }
  .edit { padding: 0.45rem 0; border-top: 1px solid var(--line); font-size: 0.85rem; }
  .edit:first-child { border-top: 0; }
  .edit b { color: #fff; } .edit .file { color: var(--cyan); font-family: var(--mono); font-size: 0.8rem; }
  .edit .clash { color: var(--red); }
  .ev { padding: 0.35rem 0; border-top: 1px solid var(--line); font-size: 0.8rem; color: var(--ink); }
  .ev:first-child { border-top: 0; }
  .ev .t { color: var(--muted); font-size: 0.72rem; }
  #comms { max-height: 40vh; overflow-y: auto; }
  .empty { color: var(--muted); font-size: 0.85rem; }
  /* Tabs (Board | Map) */
  .tabs { display: flex; gap: 0.4rem; margin: 1rem 0 0.2rem; }
  .tabs button { background: var(--panel2); font-size: 0.85rem; padding: 0.45rem 1rem; }
  .tabs button.active { background: var(--cyan); color: #05121a; border-color: var(--cyan); }
  select.to { width: 11rem; }
  @media (max-width: 520px) { select.to { width: 100%; } }
  /* Command map — hierarchy of who directs whom */
  .tree { font-family: var(--mono); font-size: 0.84rem; }
  .root { color: #fff; font-weight: 700; letter-spacing: 0.04em; }
  .root .sub { color: var(--muted); font-weight: 400; font-size: 0.72rem; }
  .cmdr { margin-top: 0.9rem; padding-left: 0.7rem; border-left: 3px solid var(--cyan); }
  .cmdr.you { border-left-color: var(--green); }
  .kid { margin: 0.35rem 0 0 1.1rem; padding-left: 0.8rem; border-left: 1px solid var(--line); }
  .agent-node { cursor: pointer; display: inline-flex; align-items: center; gap: 0.4rem;
    border: 1px solid var(--line); border-radius: 6px; padding: 0.2rem 0.55rem; margin: 0.15rem 0; }
  .agent-node:hover { border-color: var(--cyan); background: var(--panel2); }
  .agent-node .nm { color: #fff; font-weight: 600; }
  .agent-node .rn { color: var(--muted); font-size: 0.72rem; }
  .pdot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .pdot.on { background: var(--green); box-shadow: 0 0 6px var(--green); }
  .pdot.off { background: var(--muted); }
  .edge { color: var(--muted); }
  .tline { color: var(--ink); margin: 0.15rem 0; }
  .tline .st { margin-left: 0.4rem; }
  .avail { margin-top: 0.9rem; color: var(--muted); }
  .cmdhint { color: var(--cyan); font-size: 0.78rem; margin-left: 0.5rem; }
</style>
</head>
<body>
<header>
  <h1>TOWER <small>/ TEAM BOARD</small></h1>
  <span class="dot" id="dot"></span><span id="status">connecting…</span>
  <input id="tok" type="password" placeholder="token (if required)" autocomplete="off" />
  <button id="forget" type="button" title="Forget the saved token on this device" hidden>sign out</button>
</header>

<div class="tabs">
  <button data-view="board" class="active" type="button">Board</button>
  <button data-view="map" type="button">Map</button>
</div>

<!-- SEND — delegate a task (works from your phone) -->
<form id="send">
  <div class="row">
    <textarea id="body" placeholder="Tell an agent what to do — e.g. add a health endpoint to the API"></textarea>
    <select class="to" id="to" aria-label="recipient agent">
      <option value="*">★ everyone</option>
    </select>
  </div>
  <div class="row">
    <button class="btn-go" type="submit">Delegate task</button>
    <span class="hint muted" id="sendhint">Pick a worker (or ★ everyone); one that's online runs it now.</span>
  </div>
</form>

<div id="approvals"></div>
<div id="collisions"></div>

<div id="view-board">
  <div class="cols">
    <div>
      <h2>Delegated tasks — who asked whom &amp; what came back</h2>
      <div class="card"><div id="tasks"><span class="empty">No tasks yet. Delegate one above, or run <b>tower send --task</b>.</span></div></div>

      <h2>Editing right now</h2>
      <div class="card"><div id="edits"><span class="empty">No active edits — all agents idle.</span></div></div>
    </div>

    <div>
      <h2>Who's connected</h2>
      <div class="card"><div id="roster"><span class="empty">No agents seen yet.</span></div></div>

      <h2>COMMS — activity log</h2>
      <div class="card" id="comms"><div id="feed"><span class="empty">Nothing has happened yet.</span></div></div>
    </div>
  </div>
</div>

<div id="view-map" hidden>
  <h2>Command map — who directs whom (tap a name to command it)</h2>
  <div class="card"><div id="map"><span class="empty">No agents yet.</span></div></div>
</div>

<script>
(function () {
  "use strict";
  var tokInput = document.getElementById("tok");
  var dot = document.getElementById("dot");
  var statusEl = document.getElementById("status");
  // One-tap auth: open /board#token=YOURTOKEN and it's stored, no mobile typing.
  // The hash is stripped immediately so it never lands in history or a screenshot.
  (function () {
    var m = /[#&]token=([^&]+)/.exec(location.hash);
    if (m) {
      localStorage.setItem("tower-token", decodeURIComponent(m[1]).trim());
      history.replaceState(null, "", location.pathname + location.search);
    }
  })();
  tokInput.value = localStorage.getItem("tower-token") || "";
  // Save on change (blur/Enter) only — polling per keystroke would send each PARTIAL
  // token as a failed auth and trip the server's brute-force lockout mid-typing.
  tokInput.addEventListener("change", saveToken);
  tokInput.addEventListener("keydown", function (e) { if (e.key === "Enter") saveToken(); });
  var forgetBtn = document.getElementById("forget");
  forgetBtn.addEventListener("click", function () {
    localStorage.removeItem("tower-token");
    tokInput.value = "";
    forgetBtn.hidden = true;
    poll();
  });
  function saveToken() {
    localStorage.setItem("tower-token", tokInput.value.trim());
    forgetBtn.hidden = !tokInput.value.trim();
    poll();
  }
  forgetBtn.hidden = !token();
  function token() { return localStorage.getItem("tower-token") || ""; }
  function authHeaders(extra) {
    var h = extra || {};
    var t = token();
    if (t) h.authorization = "Bearer " + t;
    return h;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text; // textContent only — XSS-safe
    return n;
  }
  function setStatus(kind, text) { dot.className = "dot" + (kind ? " " + kind : ""); statusEl.textContent = text; }
  function fmtAge(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    return m < 60 ? m + "m" : Math.floor(m / 60) + "h" + (m % 60) + "m";
  }
  function isUrl(u) { return typeof u === "string" && /^https?:\\/\\//i.test(u); }

  // --- tabs: Board | Map -------------------------------------------------
  var view = /[#&]map/.test(location.hash) ? "map" : "board";
  function setView(v) {
    view = v;
    document.getElementById("view-board").hidden = v !== "board";
    document.getElementById("view-map").hidden = v !== "map";
    var btns = document.querySelectorAll(".tabs button");
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle("active", btns[i].dataset.view === v);
  }
  (function () {
    var btns = document.querySelectorAll(".tabs button");
    for (var i = 0; i < btns.length; i++) btns[i].addEventListener("click", function () { setView(this.dataset.view); });
    setView(view);
  })();

  // Prefill the recipient and jump to the send box (used by map click-to-command).
  function commandAgent(id) {
    var sel = document.getElementById("to");
    var found = false;
    for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === id) { found = true; break; }
    if (!found) { var o = document.createElement("option"); o.value = id; o.textContent = id; sel.appendChild(o); }
    sel.value = id;
    setView("board");
    var b = document.getElementById("body");
    b.focus();
    document.getElementById("sendhint").textContent = "commanding " + id + " — type the task and Delegate.";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // --- SEND a task -------------------------------------------------------
  document.getElementById("send").addEventListener("submit", function (e) {
    e.preventDefault();
    var body = document.getElementById("body").value.trim();
    if (!body) return;
    var to = document.getElementById("to").value.trim() || "*";
    var repo = (window.__repo) || "team/app";
    fetch("api/task", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ repo: repo, body: body, toAgentId: to, fromAgentId: "board" }),
    })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function () {
        document.getElementById("body").value = "";
        document.getElementById("sendhint").textContent = "Sent ✓ — waiting for a worker to pick it up.";
        poll();
      })
      .catch(function (s) {
        document.getElementById("sendhint").textContent =
          s === 401 ? "Token required — enter it top right." : "Could not send (error " + s + ").";
      });
  });

  function decide(taskId, approved) {
    fetch("api/approve", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ taskId: taskId, approved: approved }),
    })
      .then(function (r) {
        if (!r.ok) {
          setStatus("err", r.status === 401 ? "token needed — enter it top right" : "approval failed (error " + r.status + ")");
          return null;
        }
        return r.json().then(function (j) {
          if (j && j.ok === false) setStatus("err", "task is no longer pending (already decided?)");
        });
      })
      .then(poll)
      .catch(function () { setStatus("err", "offline — approval not sent, try again"); });
  }

  // --- render ------------------------------------------------------------
  function repoOf(data) {
    // A live worker's repo is ground truth (it read it from git); tasks/claims can
    // carry a stale or placeholder repo that would send new tasks nowhere.
    var w = ((data.workers || [])[0] || {}).repo;
    var t = w || (data.tasks[0] || {}).repo || (data.claims[0] || {}).repo || (data.messages[0] || {}).repo;
    return t || "team/app";
  }

  function render(data) {
    window.__repo = repoOf(data);

    // replies: task_update messages keyed by the task id they reply to
    var replies = {};
    data.messages.forEach(function (m) { if (m.kind === "task_update" && m.replyTo) replies[m.replyTo] = m; });

    // APPROVALS — needs your OK (pending tasks)
    var ap = document.getElementById("approvals");
    ap.replaceChildren();
    data.tasks.filter(function (t) { return t.approval === "pending"; }).forEach(function (t) {
      var c = el("div", "card approve");
      var who = (t.assigneeAgentId || "an agent");
      c.appendChild(el("div", "q", "🔔 " + who + " wants to run a task" + (t.fromAgentId ? " from " + t.fromAgentId : "") + ":"));
      c.appendChild(el("div", "cmd", t.body));
      var btns = el("div", "btns");
      var yes = el("button", "btn-ok", "Approve"); yes.onclick = function () { decide(t.id, true); };
      var no = el("button", "btn-no", "Reject"); no.onclick = function () { decide(t.id, false); };
      btns.appendChild(yes); btns.appendChild(no);
      c.appendChild(btns);
      ap.appendChild(c);
    });

    // COLLISIONS
    var col = document.getElementById("collisions");
    col.replaceChildren();
    data.conflicts.forEach(function (c) {
      var box = el("div", "card collision");
      var sym = (c.overlap && c.overlap.length && c.overlap[0].symbol) ? c.overlap[0].symbol : "the same file";
      box.appendChild(el("div", "", (c.severity === "hard" ? "⛔ " : "△ ") + c.aAgentId + " and " + c.bAgentId + " both want " + sym));
      box.appendChild(el("div", "why", c.reason));
      col.appendChild(box);
    });

    // DELEGATION TREE
    var statusLabel = { open: ["waiting", "waiting for an agent"], accepted: ["running", "in progress"],
      done: ["done", "done"], failed: ["failed", "failed"] };
    var tasksEl = document.getElementById("tasks");
    tasksEl.replaceChildren();
    if (!data.tasks.length) {
      tasksEl.appendChild(el("span", "empty", "No tasks yet. Delegate one above, or run tower send --task."));
    } else {
      data.tasks.forEach(function (t) {
        var node = el("div", "task");
        var l1 = el("div", "line1");
        var from = t.fromAgentId === "board" ? "You (from the board)" : t.fromAgentId;
        l1.appendChild(el("span", "who", from));
        l1.appendChild(el("span", "arrow", " asked "));
        l1.appendChild(el("span", "who", t.assigneeAgentId || t.toAgentId));
        l1.appendChild(el("span", "arrow", " to:"));
        var sl = statusLabel[t.status] || [t.status, t.status];
        var cls = t.status === "open" ? "waiting" : t.status === "accepted" ? "running" : t.status;
        if (t.status === "open" && t.approval === "approved") { cls = "running"; sl = ["approved — queued", ""]; }
        if (t.status === "open" && t.approval === "rejected") { cls = "failed"; sl = ["you rejected this", ""]; }
        if (t.approval === "pending") { cls = "needsok"; sl = ["needs your OK", ""]; }
        l1.appendChild(el("span", "st " + cls, sl[0]));
        l1.appendChild(el("span", "when", "  " + fmtAge(data.now - t.createdAt) + " ago"));
        node.appendChild(l1);
        node.appendChild(el("div", "cmd", t.body));

        var reply = replies[t.id];
        if (reply) {
          var fail = /^\\[failed\\]/i.test(reply.body);
          // Strip the "[done]" tag and the trailing "(sha · pr)" — both are shown as chips.
          var refsSuffix = [t.commitSha, t.prUrl].filter(Boolean).join(" · ");
          var text = reply.body.replace(/^\\[(done|failed)\\]\\s*/i, "");
          if (refsSuffix && text.endsWith(" (" + refsSuffix + ")")) {
            text = text.slice(0, text.length - refsSuffix.length - 3);
          }
          var r = el("div", "reply" + (fail ? " fail" : ""));
          r.appendChild(el("span", "r-who", reply.fromAgentId + ": "));
          r.appendChild(el("span", "", text));
          node.appendChild(r);
        }
        if (t.commitSha || t.prUrl) {
          var refs = el("div", "refs");
          if (t.commitSha) refs.appendChild(el("span", "sha", t.commitSha.slice(0, 8)));
          if (isUrl(t.prUrl)) {
            var a = el("a", "", "open PR"); a.href = t.prUrl; a.target = "_blank"; a.rel = "noopener";
            refs.appendChild(a);
          }
          node.appendChild(refs);
        }
        tasksEl.appendChild(node);
      });
    }

    // EDITING NOW
    var conflictAgents = {};
    data.conflicts.forEach(function (c) { conflictAgents[c.aAgentId] = c; conflictAgents[c.bAgentId] = c; });
    var editsEl = document.getElementById("edits");
    editsEl.replaceChildren();
    if (!data.claims.length) {
      editsEl.appendChild(el("span", "empty", "No active edits — all agents idle."));
    } else {
      data.claims.forEach(function (cl) {
        var e = el("div", "edit");
        e.appendChild(el("b", "", cl.agentId));
        e.appendChild(el("span", "", " is editing "));
        var target = "";
        (cl.symbols || []).forEach(function (s) { if (s.symbol && !target) target = s.symbol; });
        if (!target) target = (cl.files || [])[0] || cl.repo;
        e.appendChild(el("span", "file", target));
        if (cl.purpose) e.appendChild(el("span", "muted", " — " + cl.purpose));
        if (conflictAgents[cl.agentId]) e.appendChild(el("span", "clash", "  ⛔ conflict"));
        editsEl.appendChild(e);
      });
    }

    // ROSTER — who's connected
    var seen = {};
    function note(id, doing) {
      if (!id || id === "*" || id === "board") return;
      if (!seen[id] || (doing && !seen[id].doing)) seen[id] = { id: id, doing: doing || (seen[id] && seen[id].doing) || "" };
    }
    data.claims.forEach(function (cl) {
      var target = "";
      (cl.symbols || []).forEach(function (s) { if (s.symbol && !target) target = s.symbol; });
      note(cl.agentId, "editing " + (target || (cl.files || [])[0] || cl.repo));
    });
    data.tasks.forEach(function (t) { note(t.fromAgentId, ""); note(t.assigneeAgentId, ""); if (t.toAgentId !== "*") note(t.toAgentId, ""); });
    data.messages.forEach(function (m) { note(m.fromAgentId, ""); if (m.toAgentId !== "*") note(m.toAgentId, ""); });
    // PRESENCE — which agents have a live worker (heartbeated recently).
    var online = {}, runnerOf = {};
    (data.workers || []).forEach(function (w) {
      online[w.agentId] = true; runnerOf[w.agentId] = w.runner || "";
      note(w.agentId, (seen[w.agentId] && seen[w.agentId].doing) || "worker online" + (w.runner ? " · " + w.runner : ""));
    });
    var rosterEl = document.getElementById("roster");
    rosterEl.replaceChildren();
    var ids = Object.keys(seen);
    if (!ids.length) rosterEl.appendChild(el("span", "empty", "No agents seen yet."));
    ids.forEach(function (id) {
      var a = el("div", "agent");
      a.appendChild(el("span", "pdot " + (online[id] ? "on" : "off")));
      a.appendChild(el("span", "name", id));
      a.appendChild(el("span", "doing" + (seen[id].doing ? " busy" : ""), seen[id].doing || (online[id] ? "online" : "seen earlier")));
      rosterEl.appendChild(a);
    });

    // ACTIVITY LOG — plain-English, newest first
    var events = [];
    data.tasks.forEach(function (t) {
      var from = t.fromAgentId === "board" ? "You" : t.fromAgentId;
      events.push({ at: t.createdAt, text: from + " asked " + (t.assigneeAgentId || t.toAgentId) + " to: " + t.body });
    });
    data.messages.forEach(function (m) {
      if (m.kind === "task_update") {
        var clean = m.body.replace(/^\\[(done|failed)\\]\\s*/i, "");
        var verb = /^\\[failed\\]/i.test(m.body) ? " failed: " : " finished: ";
        events.push({ at: m.createdAt, text: m.fromAgentId + verb + clean });
      } else if (m.kind === "message") {
        events.push({ at: m.createdAt, text: m.fromAgentId + " → " + m.toAgentId + ": " + m.body });
      }
    });
    data.conflicts.forEach(function (c) {
      events.push({ at: data.now, live: true, text: "⛔ " + c.aAgentId + " and " + c.bAgentId + " both want the same code" });
    });
    events.sort(function (a, b) { return b.at - a.at; });
    var feed = document.getElementById("feed");
    feed.replaceChildren();
    if (!events.length) feed.appendChild(el("span", "empty", "Nothing has happened yet."));
    events.slice(0, 40).forEach(function (ev) {
      var row = el("div", "ev");
      row.appendChild(el("span", "t", (ev.live ? "now" : fmtAge(data.now - ev.at) + " ago") + "  "));
      row.appendChild(el("span", "", ev.text));
      feed.appendChild(row);
    });

    // RECIPIENT DROPDOWN — ★ everyone, then online workers, then agents seen earlier.
    var sel = document.getElementById("to");
    var prev = sel.value || "*";
    sel.replaceChildren();
    var optEveryone = el("option", "", "★ everyone"); optEveryone.value = "*"; sel.appendChild(optEveryone);
    var onlineIds = Object.keys(online);
    onlineIds.forEach(function (id) {
      var o = el("option", "", id + " — online" + (runnerOf[id] ? " · " + runnerOf[id] : ""));
      o.value = id; sel.appendChild(o);
    });
    ids.filter(function (id) { return !online[id]; }).forEach(function (id) {
      var o = el("option", "", id + " — offline (will queue)"); o.value = id; sel.appendChild(o);
    });
    // keep the user's current choice if still present
    var keep = false;
    for (var si = 0; si < sel.options.length; si++) if (sel.options[si].value === prev) { keep = true; break; }
    sel.value = keep ? prev : "*";

    renderMap(data, online, runnerOf, seen, repliesFor(data));

    var n = data.claims.length, tq = data.tasks.filter(function (t) { return t.status === "open" || t.status === "accepted"; }).length;
    setStatus("ok", "connected — " + onlineIds.length + " worker(s) online, " + tq + " task(s) in flight");
  }

  function repliesFor(data) {
    var r = {};
    data.messages.forEach(function (m) { if (m.kind === "task_update" && m.replyTo) r[m.replyTo] = m; });
    return r;
  }

  var TASK_LABEL = { open: "waiting", accepted: "running", done: "done", failed: "failed" };

  // MAP — command hierarchy: repo root → commanders → the agents they've tasked → replies.
  function renderMap(data, online, runnerOf, seen, replies) {
    var mapEl = document.getElementById("map");
    mapEl.replaceChildren();
    var repo = (data.tasks[0] || data.claims[0] || data.messages[0] || {}).repo || "this repo";

    var tree = el("div", "tree");
    var root = el("div", "root");
    root.appendChild(el("span", "", "◈ " + repo));
    root.appendChild(el("span", "sub", "  — shared Tower · " + (Object.keys(online).length) + " worker(s) online"));
    tree.appendChild(root);

    // group tasks by commander (fromAgentId)
    var byCommander = {};
    data.tasks.forEach(function (t) {
      (byCommander[t.fromAgentId] = byCommander[t.fromAgentId] || []).push(t);
    });
    var commanders = Object.keys(byCommander).sort(function (a, b) { return byCommander[b].length - byCommander[a].length; });

    function agentNode(id) {
      var node = el("span", "agent-node");
      node.appendChild(el("span", "pdot " + (online[id] ? "on" : "off")));
      node.appendChild(el("span", "nm", id));
      if (runnerOf[id]) node.appendChild(el("span", "rn", runnerOf[id]));
      node.title = "Tap to command " + id;
      node.addEventListener("click", function () { commandAgent(id); });
      return node;
    }

    commanders.forEach(function (cmdr) {
      var isYou = cmdr === "board";
      var block = el("div", "cmdr" + (isYou ? " you" : ""));
      var head = el("div");
      head.appendChild(el("span", "root", isYou ? "📱 You (board)" : cmdr));
      head.appendChild(el("span", "edge", "  directs " + byCommander[cmdr].length + " task(s) ↓"));
      block.appendChild(head);
      byCommander[cmdr].forEach(function (t) {
        var kid = el("div", "kid");
        var line = el("div", "tline");
        line.appendChild(el("span", "edge", "└▶ "));
        line.appendChild(agentNode(t.assigneeAgentId || t.toAgentId));
        line.appendChild(el("span", "st st " + (t.approval === "rejected" ? "failed" : t.status === "open" ? "waiting" : t.status === "accepted" ? "running" : t.status), (t.approval === "pending" ? "needs your OK" : t.approval === "rejected" ? "rejected" : TASK_LABEL[t.status] || t.status)));
        kid.appendChild(line);
        kid.appendChild(el("div", "cmd", t.body.length > 90 ? t.body.slice(0, 90) + "…" : t.body));
        var rep = replies[t.id];
        if (rep) {
          var fail = /^\\[failed\\]/i.test(rep.body);
          var rl = el("div", "reply" + (fail ? " fail" : ""));
          rl.appendChild(el("span", "r-who", rep.fromAgentId + ": "));
          rl.appendChild(el("span", "", rep.body.replace(/^\\[(done|failed)\\]\\s*/i, "").slice(0, 90)));
          kid.appendChild(rl);
        }
        block.appendChild(kid);
      });
      tree.appendChild(block);
    });

    // idle online workers with no task yet — available capacity to command
    var tasked = {};
    data.tasks.forEach(function (t) { tasked[t.assigneeAgentId || t.toAgentId] = true; });
    var idle = Object.keys(online).filter(function (id) { return !tasked[id]; });
    if (idle.length) {
      var av = el("div", "avail");
      av.appendChild(el("div", "", "● online & available — tap to command:"));
      idle.forEach(function (id) { av.appendChild(agentNode(id)); });
      tree.appendChild(av);
    }
    if (!commanders.length && !idle.length) {
      mapEl.appendChild(el("span", "empty", "No agents yet. Start a worker (tower work) and delegate a task."));
      return;
    }
    mapEl.appendChild(tree);
  }

  // Re-rendering on every poll would detach buttons mid-tap (Approve/Reject become
  // unclickable). Only rebuild the DOM when the data actually changed, or every 15s so
  // the relative ages stay honest.
  var lastSig = "";
  var lastRenderAt = 0;
  var pollTimer = null;
  // Poll fast (2s) when connected; back off (6s) while unauthed/offline so the board's
  // own polling never floods the server.
  function schedule(ms) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, ms);
  }
  function poll() {
    fetch("api/board", { headers: authHeaders({}), cache: "no-store" })
      .then(function (res) {
        if (res.status === 401) { setStatus("err", "token needed — open the /board#token link or paste it top right"); schedule(6000); return null; }
        if (res.status === 429) { setStatus("err", "locked out — wait ~1 min, then it clears"); schedule(6000); return null; }
        if (!res.ok) { setStatus("err", "error " + res.status); schedule(6000); return null; }
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        var now = data.now;
        // Include worker presence in the change signature, but not lastSeen — every
        // heartbeat bumps it, and re-rendering per poll detaches buttons mid-tap.
        var wsig = (data.workers || []).map(function (w) { return w.agentId + "|" + w.repo + "|" + w.runner; }).sort();
        var sig = JSON.stringify([data.claims, data.conflicts, data.messages, data.tasks, wsig]);
        if (sig !== lastSig || now - lastRenderAt >= 15000) {
          lastSig = sig;
          lastRenderAt = now;
          render(data);
        }
        schedule(2000);
      })
      .catch(function () { setStatus("err", "offline — is the server up?"); schedule(6000); });
  }

  poll();
})();
</script>
</body>
</html>
`;

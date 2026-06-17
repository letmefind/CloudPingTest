/* ==============================================================
   CloudPing — app logic (vanilla JS, no build step)
   ============================================================== */

(function () {
  "use strict";

  const LS_KEY = "cloudping.config.v1";
  const PING_TIMEOUT = 5000;
  const SPARK_POINTS = 24;

  /* ---------------- state ---------------- */

  const state = {
    selected: new Set(),
    rows: [],            // active test rows
    running: false,
    stopRequested: false,
    round: 0,
    pingsSent: 0,
    sortKey: "median",
    sortAsc: true,
    filter: ""
  };

  const $ = sel => document.querySelector(sel);
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  };

  /* ---------------- config persistence ---------------- */

  function saveConfig() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        selected: [...state.selected],
        theme: document.documentElement.dataset.theme,
        sortKey: state.sortKey,
        sortAsc: state.sortAsc
      }));
    } catch (e) { /* storage unavailable */ }
  }

  function loadConfig() {
    try {
      const cfg = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
      if (Array.isArray(cfg.selected)) cfg.selected.forEach(id => state.selected.add(id));
      if (cfg.theme) document.documentElement.dataset.theme = cfg.theme;
      else if (window.matchMedia("(prefers-color-scheme: dark)").matches)
        document.documentElement.dataset.theme = "dark";
      if (cfg.sortKey) { state.sortKey = cfg.sortKey; state.sortAsc = cfg.sortAsc !== false; }
    } catch (e) { /* corrupt config -> defaults */ }
    if (state.selected.size === 0) state.selected.add("aws");
  }

  /* ---------------- stats helpers ---------------- */

  const stats = {
    mean: v => v.reduce((a, b) => a + b, 0) / v.length,
    median: v => {
      const s = [...v].sort((a, b) => a - b);
      const h = Math.floor(s.length / 2);
      return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
    },
    min: v => Math.min(...v),
    max: v => Math.max(...v),
    jitter: v => {
      if (v.length < 2) return 0;
      let sum = 0;
      for (let i = 1; i < v.length; i++) sum += Math.abs(v[i] - v[i - 1]);
      return sum / (v.length - 1);
    }
  };

  /* ---------------- ping engine ---------------- */

  function pingOnce(url) {
    return new Promise(resolve => {
      const start = performance.now();
      const img = new Image();
      let done = false;
      const finish = ok => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        img.onload = img.onerror = null;
        resolve(ok ? Math.max(1, Math.round(performance.now() - start)) : -1);
      };
      const timer = setTimeout(() => { img.src = ""; finish(false); }, PING_TIMEOUT);
      // any response (incl. HTTP errors) fires onerror — that's still a valid RTT
      img.onload = () => finish(true);
      img.onerror = () => finish(true);
      img.src = url + (url.includes("?") ? "&" : "?") + "cache_buster=" + Date.now();
    });
  }

  async function runLoop() {
    state.running = true;
    state.stopRequested = false;
    state.round = 0;
    buildRows();
    renderRows();
    updateRunButton();

    const rows = state.rows;
    if (!rows.length) { state.running = false; updateRunButton(); return; }

    // warm-up round: establishes DNS/TLS, results discarded
    setRoundLabel("warm-up");
    for (let i = 0; i < rows.length; i++) {
      if (state.stopRequested) break;
      markTesting(rows[i], i, rows.length);
      await pingOnce(rows[i].url);
      bumpPings();
    }

    while (!state.stopRequested) {
      state.round++;
      setRoundLabel(String(state.round));
      for (let i = 0; i < rows.length; i++) {
        if (state.stopRequested) break;
        const row = rows[i];
        markTesting(row, i, rows.length);
        const ms = await pingOnce(row.url);
        bumpPings();
        if (ms > 0) {
          row.samples.push(ms);
          if (row.samples.length > 500) row.samples.shift();
          row.fails = 0;
        } else {
          row.fails = (row.fails || 0) + 1;
        }
        updateRowStats(row);
        updateRowCells(row);
      }
      resortAndPaint();
    }

    clearTesting();
    state.running = false;
    setRoundLabel("done (" + state.round + ")");
    $("#nowTesting").textContent = "–";
    $("#progressBar").style.width = "0%";
    updateRunButton();
    saveConfig();
    toast("Test stopped — results are sortable & exportable");
  }

  function buildRows() {
    state.rows = [];
    let idx = 0;
    for (const p of PROVIDERS) {
      if (!state.selected.has(p.id)) continue;
      for (const r of p.regions) {
        state.rows.push({
          id: "row_" + idx++,
          provider: p,
          region: r,
          url: p.url(r),
          flag: regionFlag(r),
          samples: [],
          fails: 0,
          stats: null,
          tr: null
        });
      }
    }
  }

  function updateRowStats(row) {
    if (!row.samples.length) { row.stats = null; return; }
    const v = row.samples;
    row.stats = {
      last: v[v.length - 1],
      mean: stats.mean(v),
      median: stats.median(v),
      min: stats.min(v),
      max: stats.max(v),
      jitter: stats.jitter(v)
    };
  }

  /* ---------------- rendering ---------------- */

  function providerCard(p) {
    const card = el("div", "provider-card");
    card.dataset.id = p.id;
    card.setAttribute("role", "checkbox");
    card.setAttribute("tabindex", "0");
    const isOn = state.selected.has(p.id);
    card.setAttribute("aria-checked", String(isOn));
    card.setAttribute("aria-label", `${p.name} — ${p.regions.length} regions`);
    if (isOn) card.classList.add("on");
    const initials = p.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase();
    // SVG checkmark — no emoji per skill pre-delivery checklist
    const checkSVG = `<svg width="11" height="9" viewBox="0 0 11 9" fill="none" aria-hidden="true">
      <path d="M1 4L4 7.5L10 1" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
    card.append(
      Object.assign(el("div", "logo", initials), { style: `background:${p.color}` }),
      el("div", "meta",
        `<div class="name">${p.name}</div>
         <div class="count">${p.regions.length} regions</div>`),
      el("div", "tick", checkSVG)
    );
    const toggle = () => {
      if (state.running) { toast("Stop the test before changing providers"); return; }
      card.classList.toggle("on");
      const on = card.classList.contains("on");
      card.setAttribute("aria-checked", String(on));
      on ? state.selected.add(p.id) : state.selected.delete(p.id);
      updateCounters();
      saveConfig();
    };
    card.addEventListener("click", toggle);
    card.addEventListener("keydown", e => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(); } });
    return card;
  }

  function renderProviders() {
    const grid = $("#providerGrid");
    grid.innerHTML = "";
    PROVIDERS.forEach(p => grid.append(providerCard(p)));
  }

  function latencyColor(ms, best, worst) {
    if (worst <= best) return "var(--good)";
    const t = Math.min(1, Math.max(0, (ms - best) / (worst - best)));
    return `hsl(${Math.round(115 - t * 115)}, 62%, 46%)`;
  }

  function sparkSVG(samples) {
    const pts = samples.slice(-SPARK_POINTS);
    const w = 110, h = 26, pad = 2;
    if (pts.length < 2)
      return `<svg class="spark" width="${w}" height="${h}"><circle cx="${pad + 2}" cy="${h / 2}" r="2"/></svg>`;
    const min = Math.min(...pts), max = Math.max(...pts);
    const span = max - min || 1;
    const step = (w - pad * 2) / (pts.length - 1);
    const coords = pts.map((v, i) =>
      `${(pad + i * step).toFixed(1)},${(h - pad - ((v - min) / span) * (h - pad * 2)).toFixed(1)}`);
    const [lx, ly] = coords[coords.length - 1].split(",");
    return `<svg class="spark" width="${w}" height="${h}">
      <polyline points="${coords.join(" ")}"/><circle cx="${lx}" cy="${ly}" r="2.4"/></svg>`;
  }

  function rowTR(row) {
    const tr = el("tr");
    tr.id = row.id;
    tr.innerHTML = `
      <td class="rank">–</td>
      <td><span class="prov-chip"><i style="background:${row.provider.color}"></i>${row.provider.name}</span></td>
      <td class="region"><span class="flag">${row.flag}</span><span class="city">${row.region.text2}</span><span class="area">${row.region.text1}</span></td>
      <td class="code">${row.region.code}</td>
      <td class="ms cell-last na">–</td>
      <td class="ms cell-median na"><div class="lat-cell"><span class="lat-num">–</span><span class="lat-bar"><i></i></span></div></td>
      <td class="ms cell-mean na">–</td>
      <td class="ms cell-min na">–</td>
      <td class="ms cell-max na">–</td>
      <td class="ms cell-jitter na">–</td>
      <td class="cell-spark">${sparkSVG([])}</td>`;
    row.tr = tr;
    return tr;
  }

  function renderRows() {
    const body = $("#resultsBody");
    body.innerHTML = "";
    state.rows.forEach(r => body.append(rowTR(r)));
    $("#emptyNote").style.display = state.rows.length ? "none" : "";
    applyFilter();
    updateCounters();
  }

  function fmt(ms) { return Math.round(ms) + '<small style="color:var(--ink-3)"> ms</small>'; }

  function updateRowCells(row) {
    const tr = row.tr;
    if (!tr) return;
    if (!row.stats) {
      if (row.fails > 0) tr.querySelector(".cell-last").innerHTML = `<span class="fail">FAILED</span>`;
      return;
    }
    const s = row.stats;
    const set = (cls, val) => {
      const td = tr.querySelector(cls);
      td.classList.remove("na");
      td.innerHTML = val;
    };
    set(".cell-last", row.fails > 0 ? `<span class="fail">FAILED</span>` : fmt(s.last));
    set(".cell-mean", fmt(s.mean));
    set(".cell-min", fmt(s.min));
    set(".cell-max", fmt(s.max));
    set(".cell-jitter", fmt(s.jitter));

    const medTd = tr.querySelector(".cell-median");
    medTd.classList.remove("na");
    medTd.querySelector(".lat-num").textContent = Math.round(s.median) + " ms";
    tr.querySelector(".cell-spark").innerHTML = sparkSVG(row.samples);
    paintBars();
  }

  let paintQueued = false;
  function paintBars() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      const withData = state.rows.filter(r => r.stats);
      if (!withData.length) return;
      const meds = withData.map(r => r.stats.median);
      const best = Math.min(...meds), worst = Math.max(...meds);
      const cap = Math.max(worst, 1);
      for (const r of withData) {
        const bar = r.tr.querySelector(".lat-bar > i");
        bar.style.width = Math.max(4, (r.stats.median / cap) * 100) + "%";
        bar.style.backgroundColor = latencyColor(r.stats.median, best, worst);
      }
    });
  }

  /* ---------------- sorting / ranking ---------------- */

  function sortValue(row, key) {
    switch (key) {
      case "provider": return row.provider.name.toLowerCase();
      case "region": return (row.region.text2 + row.region.text1).toLowerCase();
      case "code": return row.region.code;
      case "spark": case "rank":
        return row.stats ? row.stats.median : Infinity;
      default:
        return row.stats ? row.stats[key] : Infinity;
    }
  }

  function resortAndPaint() {
    const key = state.sortKey, asc = state.sortAsc;
    state.rows.sort((a, b) => {
      const va = sortValue(a, key), vb = sortValue(b, key);
      if (va < vb) return asc ? -1 : 1;
      if (va > vb) return asc ? 1 : -1;
      return 0;
    });
    const body = $("#resultsBody");
    state.rows.forEach((r, i) => {
      if (r.tr) {
        r.tr.querySelector(".rank").textContent = i + 1;
        body.append(r.tr);
      }
    });
    renderPodium();
    paintBars();
  }

  /* SVG rank badges — no emoji per UI/UX Pro Max skill */
  const RANK_BADGES = [
    /* gold  */ `<svg class="rank-badge rank-1" width="28" height="28" viewBox="0 0 28 28" aria-label="1st place">
      <circle cx="14" cy="14" r="13" fill="#F59E0B" fill-opacity="0.15" stroke="#F59E0B" stroke-width="1.5"/>
      <text x="14" y="19" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" font-weight="700" fill="#D97706">1</text>
    </svg>`,
    /* silver*/ `<svg class="rank-badge rank-2" width="28" height="28" viewBox="0 0 28 28" aria-label="2nd place">
      <circle cx="14" cy="14" r="13" fill="#94A3B8" fill-opacity="0.15" stroke="#94A3B8" stroke-width="1.5"/>
      <text x="14" y="19" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" font-weight="700" fill="#64748B">2</text>
    </svg>`,
    /* bronze*/ `<svg class="rank-badge rank-3" width="28" height="28" viewBox="0 0 28 28" aria-label="3rd place">
      <circle cx="14" cy="14" r="13" fill="#CD7F32" fill-opacity="0.15" stroke="#CD7F32" stroke-width="1.5"/>
      <text x="14" y="19" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" font-weight="700" fill="#A05A2C">3</text>
    </svg>`
  ];
  const RANK_PLACES = ["Fastest region", "Runner-up", "Third place"];

  function renderPodium() {
    const pod = $("#podium");
    const ranked = state.rows.filter(r => r.stats).sort((a, b) => a.stats.median - b.stats.median).slice(0, 3);
    if (ranked.length < 1) { pod.hidden = true; return; }
    pod.hidden = false;
    pod.innerHTML = ranked.map((r, i) => `
      <div class="podium-card">
        <span class="medal" aria-hidden="true">${RANK_BADGES[i]}</span>
        <div class="place">${RANK_PLACES[i]}</div>
        <div class="where">${r.flag} ${r.region.text2}</div>
        <div class="prov">${r.provider.name} · ${r.region.code}</div>
        <div class="ms">${Math.round(r.stats.median)}<small> ms median</small></div>
      </div>`).join("");
  }

  /* ---------------- run UI helpers ---------------- */

  function markTesting(row, i, total) {
    clearTesting();
    if (row.tr) row.tr.classList.add("testing");
    $("#nowTesting").textContent = `${row.provider.name} · ${row.region.text2}`;
    $("#progressBar").style.width = ((i + 1) / total * 100).toFixed(1) + "%";
  }

  function clearTesting() {
    document.querySelectorAll("tr.testing").forEach(t => t.classList.remove("testing"));
  }

  function setRoundLabel(txt) { $("#roundNum").textContent = txt; }

  function bumpPings() {
    state.pingsSent++;
    $("#statPings").textContent = state.pingsSent.toLocaleString();
  }

  function updateRunButton() {
    const btn = $("#runBtn");
    if (state.running) {
      btn.classList.add("running");
      btn.innerHTML = "■ &nbsp;Stop test";
    } else {
      btn.classList.remove("running");
      btn.innerHTML = "▶ &nbsp;Start test";
    }
  }

  function updateCounters() {
    const provs = PROVIDERS.filter(p => state.selected.has(p.id));
    const regions = provs.reduce((n, p) => n + p.regions.length, 0);
    $("#regionCount").textContent = regions;
    $("#statProviders").textContent = PROVIDERS.length;
    $("#statRegions").textContent = PROVIDERS.reduce((n, p) => n + p.regions.length, 0);
  }

  /* ---------------- filter / export / toast ---------------- */

  function applyFilter() {
    const q = state.filter.trim().toLowerCase();
    for (const r of state.rows) {
      if (!r.tr) continue;
      const hay = `${r.provider.name} ${r.region.text1} ${r.region.text2} ${r.region.code}`.toLowerCase();
      r.tr.style.display = !q || hay.includes(q) ? "" : "none";
    }
  }

  function exportCSV() {
    const rows = state.rows.filter(r => r.stats);
    if (!rows.length) { toast("No results to export yet"); return; }
    const head = "provider,region,location,code,median_ms,mean_ms,min_ms,max_ms,jitter_ms,samples";
    const lines = rows.map(r => [
      r.provider.name, `"${r.region.text2}"`, `"${r.region.text1}"`, r.region.code,
      Math.round(r.stats.median), Math.round(r.stats.mean),
      Math.round(r.stats.min), Math.round(r.stats.max),
      Math.round(r.stats.jitter), r.samples.length
    ].join(","));
    const blob = new Blob([head + "\n" + lines.join("\n")], { type: "text/csv" });
    const a = el("a");
    a.href = URL.createObjectURL(blob);
    a.download = "cloudping-results.csv";
    a.click();
    URL.revokeObjectURL(a.href);
    toast("CSV downloaded");
  }

  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  /* ---------------- wiring ---------------- */

  function init() {
    loadConfig();
    renderProviders();
    updateCounters();
    $("#year").textContent = new Date().getFullYear();

    $("#runBtn").addEventListener("click", () => {
      if (state.running) {
        state.stopRequested = true;
      } else {
        if (!state.selected.size) { toast("Pick at least one provider first"); return; }
        runLoop();
      }
      updateRunButton();
    });

    $("#selAll").addEventListener("click", () => {
      if (state.running) { toast("Stop the test first"); return; }
      PROVIDERS.forEach(p => state.selected.add(p.id));
      renderProviders(); updateCounters(); saveConfig();
    });
    $("#selNone").addEventListener("click", () => {
      if (state.running) { toast("Stop the test first"); return; }
      state.selected.clear();
      renderProviders(); updateCounters(); saveConfig();
    });

    $("#themeToggle").addEventListener("click", () => {
      const html = document.documentElement;
      html.dataset.theme = html.dataset.theme === "dark" ? "light" : "dark";
      saveConfig();
    });

    $("#searchInput").addEventListener("input", e => {
      state.filter = e.target.value;
      applyFilter();
    });

    $("#exportBtn").addEventListener("click", exportCSV);

    $("#headRow").addEventListener("click", e => {
      const th = e.target.closest("th");
      if (!th) return;
      const key = th.dataset.key;
      if (key === "rank") return;
      if (state.sortKey === key) state.sortAsc = !state.sortAsc;
      else { state.sortKey = key; state.sortAsc = true; }
      document.querySelectorAll("#headRow th").forEach(h => {
        h.classList.toggle("sorted", h.dataset.key === state.sortKey);
        const arrow = h.querySelector(".arrow");
        if (arrow) arrow.remove();
      });
      th.insertAdjacentHTML("beforeend", `<span class="arrow">${state.sortAsc ? "▲" : "▼"}</span>`);
      resortAndPaint();
      saveConfig();
    });
  }

  document.addEventListener("DOMContentLoaded", init);

  /* ==============================================================
     Claude 3.5 Sonnet — AI analysis integration
     Direct browser→Anthropic API call. Key stored in localStorage.
     ============================================================== */

  const CLAUDE_MODEL  = "claude-3-5-sonnet-20241022";
  const CLAUDE_API    = "https://api.anthropic.com/v1/messages";
  const AI_LS_KEY     = "cloudping.ai.key.v1";

  let _aiKey = "";

  function aiGetKey() {
    if (!_aiKey) _aiKey = localStorage.getItem(AI_LS_KEY) || "";
    return _aiKey;
  }

  function aiSetKey(raw) {
    _aiKey = raw.trim();
    if (_aiKey) localStorage.setItem(AI_LS_KEY, _aiKey);
    else localStorage.removeItem(AI_LS_KEY);
    aiUpdateKeyUI();
  }

  function aiUpdateKeyUI() {
    const k = aiGetKey();
    const disp = $("#aiKeyDisplay");
    if (disp) {
      disp.textContent = k ? `sk-ant-…${k.slice(-4)}` : "No key set";
      disp.dataset.set = k ? "1" : "";
    }
    // enable/disable send button based on key presence
    const btn = $("#aiSubmitBtn");
    if (btn) btn.disabled = !k;
  }

  /* Build a compact text summary of current results for the system prompt */
  function aiBuildContext() {
    const rows = state.rows.filter(r => r.stats);
    if (!rows.length) return null;

    const sorted = [...rows].sort((a, b) => a.stats.median - b.stats.median);
    const top = sorted.slice(0, 20);
    const providers = [...state.selected]
      .map(id => PROVIDERS.find(p => p.id === id)?.name)
      .filter(Boolean)
      .join(", ");

    const lines = top.map((r, i) =>
      `${i + 1}. ${r.provider.name} · ${r.region.text2} (${r.region.text1}) [${r.region.code}]` +
      ` — median ${Math.round(r.stats.median)}ms, min ${Math.round(r.stats.min)}ms,` +
      ` max ${Math.round(r.stats.max)}ms, jitter ${Math.round(r.stats.jitter)}ms`
    );

    const last = sorted[sorted.length - 1];
    return (
      `CloudPing test — ${state.round} round(s) completed\n` +
      `Providers tested: ${providers}\n` +
      `Total regions measured: ${rows.length}\n\n` +
      `Top 20 fastest regions (by median):\n${lines.join("\n")}\n\n` +
      `Slowest region: ${last.provider.name} · ${last.region.text2} — ${Math.round(last.stats.median)}ms`
    );
  }

  /* Minimal markdown → HTML (safe: entities escaped first) */
  function aiRenderMarkdown(text) {
    const esc = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    return esc
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/^### (.+)$/gm, "<h4>$1</h4>")
      .replace(/^## (.+)$/gm, "<h3>$1</h3>")
      .split(/\n\n+/)
      .map(block => {
        if (/^<h[234]/.test(block.trim())) return block;
        return `<p>${block.replace(/\n/g, "<br>")}</p>`;
      })
      .join("\n");
  }

  async function aiCallClaude(question) {
    const key = aiGetKey();
    const box = $("#aiResponse");

    if (!key) {
      box.innerHTML = `<span class="ai-error">Enter your Anthropic API key below to enable AI analysis.</span>`;
      box.classList.add("has-content");
      box.classList.remove("streaming");
      // reveal key row
      const row = $("#aiKeyRow");
      if (row) { row.hidden = false; $("#aiKeyInput")?.focus(); }
      return;
    }

    const context = aiBuildContext();
    if (!context) {
      box.innerHTML = `<span class="ai-error">Run a latency test first — Claude needs data to analyze.</span>`;
      box.classList.add("has-content");
      return;
    }

    const system = `You are a network infrastructure expert interpreting real latency measurements from CloudPing, a browser-based tool that pings cloud endpoints using the image-beacon technique. Results reflect the user's actual network path and conditions.

Give precise, actionable advice. Reference specific millisecond values from the data. Use markdown (bold, headers, bullet points) for clarity when the answer has multiple parts. Be concise — 150–300 words unless a detailed comparison is needed.`;

    const userMsg = `My latency test results:\n\n${context}\n\n---\n\n${question}`;

    // setup streaming UI
    box.innerHTML = "";
    box.classList.add("streaming");
    box.classList.remove("has-content");
    const cursor = document.createElement("span");
    cursor.className = "ai-cursor";
    box.appendChild(cursor);

    const btn = $("#aiSubmitBtn");
    if (btn) btn.disabled = true;

    let fullText = "";

    try {
      const res = await fetch(CLAUDE_API, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 1024,
          stream: true,
          system,
          messages: [{ role: "user", content: userMsg }]
        })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msg = err.error?.message || `HTTP ${res.status}`;
        throw new Error(
          res.status === 401 ? "Invalid API key — check your Anthropic key." : msg
        );
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const parts = buf.split("\n");
        buf = parts.pop() || "";

        for (const line of parts) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (raw === "[DONE]") continue;
          try {
            const evt = JSON.parse(raw);
            if (
              evt.type === "content_block_delta" &&
              evt.delta?.type === "text_delta" &&
              evt.delta.text
            ) {
              fullText += evt.delta.text;
              // re-render with cursor
              box.innerHTML = aiRenderMarkdown(fullText);
              box.appendChild(cursor);
            }
          } catch (_) { /* malformed SSE chunk — skip */ }
        }
      }

      // finalise
      box.innerHTML = aiRenderMarkdown(fullText);
      box.classList.remove("streaming");
      box.classList.add("has-content");

    } catch (err) {
      box.innerHTML = `<span class="ai-error">⚠ ${err.message}</span>`;
      box.classList.remove("streaming");
      box.classList.add("has-content");
    } finally {
      if (btn) btn.disabled = !aiGetKey();
    }
  }

  function initAI() {
    aiUpdateKeyUI();

    const promptEl   = $("#aiPromptInput");
    const submitBtn  = $("#aiSubmitBtn");
    const keyInput   = $("#aiKeyInput");
    const keySave    = $("#aiKeySave");
    const keyToggle  = $("#aiKeyToggle");
    const keyRow     = $("#aiKeyRow");

    if (!promptEl) return;

    /* quick chips → fill textarea */
    document.querySelectorAll(".ai-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        promptEl.value = chip.dataset.q;
        promptEl.focus();
      });
    });

    /* submit: click or Ctrl/Cmd+Enter */
    const doSend = () => {
      const q = promptEl.value.trim();
      if (!q) return;
      aiCallClaude(q);
    };

    submitBtn?.addEventListener("click", doSend);
    promptEl.addEventListener("keydown", e => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSend(); }
    });

    /* key management */
    keyToggle?.addEventListener("click", () => {
      if (keyRow) {
        keyRow.hidden = !keyRow.hidden;
        if (!keyRow.hidden) keyInput?.focus();
      }
    });

    const saveKey = () => {
      const v = keyInput?.value || "";
      if (v.trim()) {
        aiSetKey(v);
        if (keyRow) keyRow.hidden = true;
        toast("API key saved");
      }
    };

    keySave?.addEventListener("click", saveKey);
    keyInput?.addEventListener("keydown", e => {
      if (e.key === "Enter") saveKey();
      if (e.key === "Escape" && keyRow) keyRow.hidden = true;
    });

    // If a key is already stored, reveal the send button immediately
    aiUpdateKeyUI();
  }

  document.addEventListener("DOMContentLoaded", initAI);

  /* ================================================================
     CINEMATIC 3D ENGINE
     UI/UX Pro Max Skill: Style #5 3D & Hyperrealism
                          Style #43 Interactive Cursor Design
                          Style #31 Parallax Storytelling
     Skill §7: All animations respect prefers-reduced-motion,
               are interruptible, and never block user input.
     ================================================================ */

  function initCinematic3D() {
    // Skill §7: Always respect user motion preference
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    /* ── Smooth mouse tracking with lerp ── */
    let targetMX = 0, targetMY = 0;
    let currentMX = 0, currentMY = 0;

    document.addEventListener("mousemove", e => {
      targetMX = (e.clientX / window.innerWidth  - 0.5) * 2;
      targetMY = (e.clientY / window.innerHeight - 0.5) * 2;
    });

    // Zero out on mouse leave (prevents stuck tilt when cursor leaves window)
    document.addEventListener("mouseleave", () => { targetMX = 0; targetMY = 0; });

    /* ── Hero parallax targets ── */
    const heroContent = document.getElementById("heroContent");
    const heroRadar   = document.getElementById("heroRadar");
    const heroOrbs    = document.querySelector(".hero-orbs");
    const heroFloats  = document.querySelector(".hero-floats");

    /* ── RAF loop: lerp + apply transforms ── */
    function rafLoop() {
      const ease = 0.055;
      currentMX += (targetMX - currentMX) * ease;
      currentMY += (targetMY - currentMY) * ease;

      // Hero text — slowest (depth 1)
      if (heroContent) {
        heroContent.style.transform =
          `translate3d(${currentMX * -9}px, ${currentMY * -6}px, 0)`;
      }

      // Radar — medium depth + 3D tilt (depth 3)
      if (heroRadar) {
        heroRadar.style.transform =
          `translateY(-50%) translate3d(${currentMX * 26}px, ${currentMY * 16}px, 0)` +
          ` perspective(900px) rotateX(${currentMY * -5}deg) rotateY(${currentMX * 6}deg)`;
      }

      // Orbs — barely move (depth 0.5)
      if (heroOrbs) {
        heroOrbs.style.transform =
          `translate3d(${currentMX * -5}px, ${currentMY * -3.5}px, 0)`;
      }

      // Float chips container — fast (depth 2.5)
      if (heroFloats) {
        heroFloats.style.transform =
          `translate3d(${currentMX * 20}px, ${currentMY * 13}px, 0)`;
      }

      requestAnimationFrame(rafLoop);
    }
    rafLoop();

    /* ── 3D card tilt (holographic) ── */
    function attachCardTilt(card) {
      card.addEventListener("mouseenter", () => {
        // Remove transform from transition so mouse follows instantly
        card.style.transition = "box-shadow 0.3s ease, border-color 0.2s ease";
      });

      card.addEventListener("mousemove", e => {
        const rect = card.getBoundingClientRect();
        const cx = ((e.clientX - rect.left) / rect.width) * 100;
        const cy = ((e.clientY - rect.top)  / rect.height) * 100;
        // Normalised -0.5 … +0.5
        const rx = (e.clientY - rect.top  - rect.height / 2) / rect.height;
        const ry = (e.clientX - rect.left - rect.width  / 2) / rect.width;

        // Perspective tilt + Z lift + slight scale
        card.style.transform =
          `perspective(700px) rotateX(${-rx * 13}deg) rotateY(${ry * 15}deg) translateZ(14px) scale(1.025)`;

        // Holographic sheen follows cursor
        card.style.setProperty("--cx", cx + "%");
        card.style.setProperty("--cy", cy + "%");

        // Dynamic shadow shifts with tilt direction (simulates light source)
        const sx = ry * -14;
        const sy = rx * 10;
        card.style.boxShadow =
          `${sx}px ${sy}px 28px rgba(31,30,29,0.14), 0 18px 50px rgba(31,30,29,0.1)`;
      });

      card.addEventListener("mouseleave", () => {
        // Spring back — add transition back for smooth return
        card.style.transition =
          "transform 0.55s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.45s ease, border-color 0.2s ease";
        card.style.transform = "";
        card.style.boxShadow = "";
        card.style.removeProperty("--cx");
        card.style.removeProperty("--cy");
      });
    }

    // Apply tilt to all current provider cards
    document.querySelectorAll(".provider-card").forEach(attachCardTilt);

    // Also apply after selAll/selNone re-render (MutationObserver)
    const providerGrid = document.getElementById("providerGrid");
    if (providerGrid) {
      new MutationObserver(() => {
        providerGrid.querySelectorAll(".provider-card").forEach(card => {
          if (!card.dataset.tiltInit) {
            card.dataset.tiltInit = "1";
            attachCardTilt(card);
          }
        });
      }).observe(providerGrid, { childList: true });
    }

    // Apply tilt to podium cards when they appear
    const podiumEl = document.getElementById("podium");
    if (podiumEl) {
      new MutationObserver(() => {
        podiumEl.querySelectorAll(".podium-card").forEach(card => {
          if (!card.dataset.tiltInit) {
            card.dataset.tiltInit = "1";
            attachCardTilt(card);
          }
        });
      }).observe(podiumEl, { childList: true, subtree: true });
    }
  }

  /* ── Scroll-driven 3D reveals ── */
  function initScrollReveal() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // Show all immediately without animation
      document.querySelectorAll(".reveal-3d").forEach(el => el.classList.add("in-view"));
      return;
    }
    const obs = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add("in-view");
          obs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.07, rootMargin: "0px 0px -40px 0px" });

    document.querySelectorAll(".reveal-3d").forEach(el => obs.observe(el));
  }

  document.addEventListener("DOMContentLoaded", () => {
    initScrollReveal();
    initCinematic3D();
  });

})();

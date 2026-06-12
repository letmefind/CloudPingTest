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
    if (state.selected.has(p.id)) card.classList.add("on");
    const initials = p.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase();
    card.append(
      Object.assign(el("div", "logo", initials), { style: `background:${p.color}` }),
      el("div", "meta",
        `<div class="name">${p.name}</div>
         <div class="count">${p.regions.length} regions</div>`),
      el("div", "tick", "✓")
    );
    card.addEventListener("click", () => {
      if (state.running) { toast("Stop the test before changing providers"); return; }
      card.classList.toggle("on");
      card.classList.contains("on") ? state.selected.add(p.id) : state.selected.delete(p.id);
      updateCounters();
      saveConfig();
    });
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

  function renderPodium() {
    const pod = $("#podium");
    const ranked = state.rows.filter(r => r.stats).sort((a, b) => a.stats.median - b.stats.median).slice(0, 3);
    if (ranked.length < 1) { pod.hidden = true; return; }
    pod.hidden = false;
    const medals = ["🥇", "🥈", "🥉"];
    const places = ["Fastest region", "Runner-up", "Third place"];
    pod.innerHTML = ranked.map((r, i) => `
      <div class="podium-card">
        <span class="medal">${medals[i]}</span>
        <div class="place">${places[i]}</div>
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
})();

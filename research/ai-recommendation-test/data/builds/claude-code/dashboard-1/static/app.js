"use strict";

// ---------------------------------------------------------------- state & utils

const $ = (sel) => document.querySelector(sel);
const PAGE_SIZE = 15;

const state = {
  start: "", end: "", region: "", category: "",
  granularity: "month", page: 0,
  minDate: "", maxDate: "",
};

const money0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const money2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const moneyCompact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const num = new Intl.NumberFormat("en-US");

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

// Dates are handled as UTC to avoid timezone off-by-one errors.
const fromISO = (s) => new Date(s + "T00:00:00Z");
const toISO = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = fromISO(s); d.setUTCDate(d.getUTCDate() + n); return toISO(d); };
const daysBetween = (a, b) => Math.round((fromISO(b) - fromISO(a)) / 86400000) + 1;
const isISODate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(fromISO(s));

const fmtDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const fmtDayShort = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const fmtMonth = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

function fmtPeriod(period, granularity, short = false) {
  if (granularity === "month") return fmtMonth.format(fromISO(period + "-01"));
  const d = fromISO(period);
  const label = short ? fmtDayShort.format(d) : fmtDay.format(d);
  return granularity === "week" && !short ? `Week of ${label}` : label;
}

async function api(path, extra = {}) {
  const params = new URLSearchParams();
  for (const k of ["start", "end", "region", "category"]) if (state[k]) params.set(k, state[k]);
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  const res = await fetch(`/api/${path}?${params}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function showError(msg) {
  const el = $("#error");
  el.hidden = !msg;
  el.textContent = msg || "";
}

// ---------------------------------------------------------------- filters

function applyPreset(preset) {
  const end = state.maxDate;
  let start;
  switch (preset) {
    case "30d": start = addDays(end, -29); break;
    case "90d": start = addDays(end, -89); break;
    case "ytd": start = end.slice(0, 4) + "-01-01"; break;
    case "12m": start = addDays(end, -364); break;
    default:    start = state.minDate;
  }
  if (start < state.minDate) start = state.minDate;
  state.start = start;
  state.end = end;
  $("#start").value = start;
  $("#end").value = end;
  markPreset(preset);
  autoGranularity();
}

function markPreset(preset) {
  document.querySelectorAll("#presets button").forEach((b) => {
    b.classList.toggle("active", b.dataset.preset === preset);
  });
}

// Choose a sensible chart resolution for the selected range.
function autoGranularity() {
  const days = daysBetween(state.start, state.end);
  state.granularity = days <= 45 ? "day" : days <= 180 ? "week" : "month";
  $("#granularity").value = state.granularity;
}

function fillSelect(sel, values) {
  for (const v of values) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    sel.appendChild(opt);
  }
}

// ---------------------------------------------------------------- loading

let loadSeq = 0; // ignore responses from superseded requests

async function refresh() {
  const seq = ++loadSeq;
  state.page = 0;
  showError(null);
  document.body.classList.add("loading");
  $("#range-label").textContent = `${fmtDay.format(fromISO(state.start))} – ${fmtDay.format(fromISO(state.end))}`;
  try {
    const [summary, ts, regions, categories, top, orders] = await Promise.all([
      api("summary"),
      api("timeseries", { granularity: state.granularity }),
      api("breakdown", { by: "region" }),
      api("breakdown", { by: "category" }),
      api("top-products", { limit: 10 }),
      api("orders", { limit: PAGE_SIZE, offset: 0 }),
    ]);
    if (seq !== loadSeq) return;
    renderKpis(summary);
    renderTimeseries(ts);
    renderBars("#chart-region", regions.rows);
    renderBars("#chart-category", categories.rows);
    renderTopProducts(top.rows);
    renderOrders(orders);
  } catch (err) {
    if (seq === loadSeq) showError(err.message);
  } finally {
    if (seq === loadSeq) document.body.classList.remove("loading");
  }
}

async function loadTimeseries() {
  try {
    renderTimeseries(await api("timeseries", { granularity: state.granularity }));
  } catch (err) { showError(err.message); }
}

async function loadOrders() {
  try {
    renderOrders(await api("orders", { limit: PAGE_SIZE, offset: state.page * PAGE_SIZE }));
  } catch (err) { showError(err.message); }
}

// ---------------------------------------------------------------- rendering

const KPI_FORMAT = {
  revenue: (v) => money0.format(v),
  orders: (v) => num.format(v),
  avg_order_value: (v) => money2.format(v),
  units: (v) => num.format(v),
  customers: (v) => num.format(v),
};

function renderKpis(summary) {
  const prevLabel = `${fmtDay.format(fromISO(summary.previous_range.start))} – ${fmtDay.format(fromISO(summary.previous_range.end))}`;
  for (const [key, fmt] of Object.entries(KPI_FORMAT)) {
    const card = document.querySelector(`[data-kpi="${key}"]`);
    const cur = summary.current[key];
    const prev = summary.previous[key];
    card.querySelector(".kpi-value").textContent = fmt(cur);
    const delta = card.querySelector(".kpi-delta");
    delta.title = `Previous period: ${prevLabel} (${fmt(prev)})`;
    if (!prev) {
      delta.textContent = "No prior-period data";
      delta.className = "kpi-delta muted";
      continue;
    }
    const pct = ((cur - prev) / prev) * 100;
    delta.textContent = `${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(1)}% vs prior period`;
    delta.className = "kpi-delta " + (pct >= 0 ? "up" : "down");
  }
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const s of [1, 2, 2.5, 5, 10]) if (s * p >= v) return s * p;
  return 10 * p;
}

let lastSeries = null;

function renderTimeseries(ts) {
  lastSeries = ts;
  const el = $("#chart-timeseries");
  const rows = ts.rows;
  if (!rows.length) {
    el.innerHTML = '<p class="empty">No sales in this range.</p>';
    return;
  }
  const W = Math.max(el.clientWidth, 320), H = 280;
  const m = { t: 12, r: 16, b: 28, l: 60 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const top = niceMax(Math.max(...rows.map((r) => r.revenue)));
  const x = (i) => m.l + (rows.length === 1 ? iw / 2 : (i * iw) / (rows.length - 1));
  const y = (v) => m.t + ih - (v / top) * ih;

  const parts = [];
  // Y grid + labels
  for (let i = 0; i <= 4; i++) {
    const v = (top * i) / 4, yy = y(v).toFixed(1);
    parts.push(`<line class="grid-line" x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}"/>`);
    parts.push(`<text class="axis-label" x="${m.l - 8}" y="${yy}" text-anchor="end" dominant-baseline="middle">${esc(moneyCompact.format(v))}</text>`);
  }
  // X labels (at most ~8, evenly spaced)
  const step = Math.max(1, Math.ceil(rows.length / 8));
  rows.forEach((r, i) => {
    if (i % step !== 0 && i !== rows.length - 1) return;
    if (i !== rows.length - 1 && rows.length - 1 - i < step / 2) return; // avoid crowding the last label
    parts.push(`<text class="axis-label" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(fmtPeriod(r.period, ts.granularity, true))}</text>`);
  });
  // Area + line
  const pts = rows.map((r, i) => `${x(i).toFixed(1)},${y(r.revenue).toFixed(1)}`);
  const base = y(0).toFixed(1);
  parts.push(`<path class="area" d="M${x(0).toFixed(1)},${base} L${pts.join(" L")} L${x(rows.length - 1).toFixed(1)},${base} Z"/>`);
  parts.push(`<polyline class="line" points="${pts.join(" ")}"/>`);
  // Points with native tooltips
  const hitR = Math.min(10, Math.max(3, iw / rows.length / 2));
  const dotR = rows.length > 90 ? 0 : 3;
  rows.forEach((r, i) => {
    const cx = x(i).toFixed(1), cy = y(r.revenue).toFixed(1);
    const tip = `${fmtPeriod(r.period, ts.granularity)}\nRevenue: ${money0.format(r.revenue)}\nOrders: ${num.format(r.orders)}`;
    parts.push(`<circle class="hit" cx="${cx}" cy="${cy}" r="${hitR.toFixed(1)}"><title>${esc(tip)}</title></circle>`);
    parts.push(`<circle class="dot" cx="${cx}" cy="${cy}" r="${dotR}"/>`);
  });

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Revenue over time">${parts.join("")}</svg>`;
}

function renderBars(selector, rows) {
  const el = $(selector);
  if (!rows.length) {
    el.innerHTML = '<p class="empty">No sales in this range.</p>';
    return;
  }
  const total = rows.reduce((a, r) => a + r.revenue, 0) || 1;
  const max = Math.max(...rows.map((r) => r.revenue)) || 1;
  el.innerHTML = rows.map((r) => `
    <div class="bar-row" title="${esc(`${r.name}: ${money0.format(r.revenue)} from ${num.format(r.orders)} orders`)}">
      <div class="bar-label">${esc(r.name)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${((r.revenue / max) * 100).toFixed(1)}%"></div></div>
      <div class="bar-value">${money0.format(r.revenue)} <span class="muted">${((r.revenue / total) * 100).toFixed(0)}%</span></div>
    </div>`).join("");
}

function renderTopProducts(rows) {
  const tbody = $("#top-products");
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No sales in this range.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((r, i) => `
    <tr>
      <td class="muted">${i + 1}</td>
      <td>${esc(r.name)}</td>
      <td>${esc(r.category)}</td>
      <td class="num">${num.format(r.orders)}</td>
      <td class="num">${num.format(r.units)}</td>
      <td class="num">${money0.format(r.revenue)}</td>
    </tr>`).join("");
}

function renderOrders(data) {
  const tbody = $("#orders");
  if (!data.rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">No orders in this range.</td></tr>';
  } else {
    tbody.innerHTML = data.rows.map((o) => `
      <tr>
        <td class="muted">#${esc(o.id)}</td>
        <td>${esc(fmtDay.format(fromISO(o.date)))}</td>
        <td>${esc(o.customer)}</td>
        <td>${esc(o.region)}</td>
        <td>${esc(o.product)}</td>
        <td class="num">${num.format(o.quantity)}</td>
        <td class="num">${money2.format(o.unit_price)}</td>
        <td class="num">${money2.format(o.total)}</td>
      </tr>`).join("");
  }
  const from = data.total ? data.offset + 1 : 0;
  const to = Math.min(data.offset + data.rows.length, data.total);
  $("#page-info").textContent = `${num.format(from)}–${num.format(to)} of ${num.format(data.total)}`;
  $("#prev").disabled = data.offset === 0;
  $("#next").disabled = data.offset + data.limit >= data.total;
}

// ---------------------------------------------------------------- wiring

function onDateInput() {
  const start = $("#start").value, end = $("#end").value;
  if (!isISODate(start) || !isISODate(end)) return; // wait until both are complete
  if (start > end) {
    showError("The start date must be on or before the end date.");
    return;
  }
  state.start = start;
  state.end = end;
  markPreset(null);
  autoGranularity();
  refresh();
}

function wireEvents() {
  $("#presets").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-preset]");
    if (!btn) return;
    applyPreset(btn.dataset.preset);
    refresh();
  });
  $("#start").addEventListener("change", onDateInput);
  $("#end").addEventListener("change", onDateInput);
  $("#region").addEventListener("change", (e) => { state.region = e.target.value; refresh(); });
  $("#category").addEventListener("change", (e) => { state.category = e.target.value; refresh(); });
  $("#granularity").addEventListener("change", (e) => { state.granularity = e.target.value; loadTimeseries(); });
  $("#prev").addEventListener("click", () => { if (state.page > 0) { state.page--; loadOrders(); } });
  $("#next").addEventListener("click", () => { state.page++; loadOrders(); });

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (lastSeries) renderTimeseries(lastSeries); }, 150);
  });
}

async function init() {
  try {
    const f = await api("filters");
    if (!f.min_date) {
      showError("The database has no orders yet.");
      return;
    }
    state.minDate = f.min_date;
    state.maxDate = f.max_date;
    fillSelect($("#region"), f.regions);
    fillSelect($("#category"), f.categories);
    for (const id of ["#start", "#end"]) {
      $(id).min = f.min_date;
      $(id).max = f.max_date;
    }
    wireEvents();
    applyPreset("12m");
    await refresh();
  } catch (err) {
    showError(`Could not load dashboard: ${err.message}`);
  }
}

init();

"use strict";

// ---------------------------------------------------------------- helpers

const $ = (sel) => document.querySelector(sel);
const SVG_NS = "http://www.w3.org/2000/svg";

const fmtMoney = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmtMoney2 = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtCompact = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const fmtInt = new Intl.NumberFormat();
const fmtDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const fmtDayLong = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
const fmtMonth = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" });

const KNOWN_STATUSES = new Set(["completed", "pending", "refunded"]);

function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Parse "YYYY-MM-DD" or "YYYY-MM" as a *local* date (new Date("YYYY-MM-DD") is UTC).
function parseIso(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function addDays(s, n) {
  const d = parseIso(s);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

function svg(name, attrs = {}, parent = null) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.append(node);
  return node;
}

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "className") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c instanceof Node ? c : String(c));
  return node;
}

function niceMax(v) {
  if (!(v > 0)) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  const f = v / exp;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * exp;
}

async function api(path) {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function showError(msg) {
  const box = $("#error");
  box.textContent = msg;
  box.hidden = false;
}

function hideError() {
  $("#error").hidden = true;
}

// ---------------------------------------------------------------- state

let meta = { min_date: null, max_date: null, regions: [] };
let lastData = null;
let loadSeq = 0;

function applyPreset(preset) {
  const days = { "7": 7, "30": 30, "90": 90, "365": 365 }[preset];
  if (!days) return;
  // Anchor presets to the latest data in the DB, so a stale DB still shows something useful.
  const end = meta.max_date || isoDate(new Date());
  $("#end").value = end;
  $("#start").value = addDays(end, -(days - 1));
}

function syncUrl() {
  const params = new URLSearchParams();
  params.set("preset", $("#preset").value);
  if ($("#preset").value === "custom") {
    params.set("start", $("#start").value);
    params.set("end", $("#end").value);
  }
  if ($("#region").value) params.set("region", $("#region").value);
  history.replaceState(null, "", `?${params}`);
}

function restoreFromUrl() {
  const params = new URLSearchParams(location.search);
  const preset = params.get("preset") || "30";
  const region = params.get("region") || "";
  if ([...$("#region").options].some((o) => o.value === region)) $("#region").value = region;

  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
  if (preset === "custom" && isDate(params.get("start")) && isDate(params.get("end"))) {
    $("#preset").value = "custom";
    $("#start").value = params.get("start");
    $("#end").value = params.get("end");
  } else {
    $("#preset").value = ["7", "30", "90", "365"].includes(preset) ? preset : "30";
    applyPreset($("#preset").value);
  }
}

// ---------------------------------------------------------------- loading

async function load() {
  const start = $("#start").value;
  const end = $("#end").value;
  const region = $("#region").value;
  if (!start || !end) return;
  if (start > end) {
    showError("The start date must be on or before the end date.");
    return;
  }
  syncUrl();

  const params = new URLSearchParams({ start, end });
  if (region) params.set("region", region);

  const seq = ++loadSeq; // ignore responses from superseded requests
  document.body.classList.add("loading");
  try {
    const data = await api(`/api/dashboard?${params}`);
    if (seq !== loadSeq) return;
    hideError();
    lastData = data;
    render(data);
  } catch (err) {
    if (seq === loadSeq) showError(`Couldn't load dashboard data: ${err.message}`);
  } finally {
    if (seq === loadSeq) document.body.classList.remove("loading");
  }
}

// ---------------------------------------------------------------- rendering

function render(data) {
  const s = data.summary;
  const p = data.previous_summary;
  renderKpi("kpi-revenue", s.revenue, p.revenue, (v) => fmtMoney.format(v));
  renderKpi("kpi-orders", s.orders, p.orders, (v) => fmtInt.format(v));
  renderKpi("kpi-aov", s.avg_order_value, p.avg_order_value, (v) => fmtMoney2.format(v));
  renderKpi("kpi-units", s.units, p.units, (v) => fmtInt.format(v));

  const ts = data.timeseries;
  $("#granularity").textContent = ts.granularity === "day" ? "daily" : "monthly (first and last months may be partial)";
  renderLineChart($("#chart-timeseries"), ts.points, ts.granularity);

  const selectedRegion = data.filters.region;
  renderBars($("#chart-region"), data.by_region, (r) => ({
    label: r.name,
    value: r.revenue,
    title: `${r.name}: ${fmtMoney.format(r.revenue)} from ${fmtInt.format(r.orders)} orders`,
    selected: selectedRegion !== null && r.id === selectedRegion,
    dim: selectedRegion !== null && r.id !== selectedRegion,
  }));
  renderBars($("#chart-category"), data.by_category, (c) => ({
    label: c.name,
    value: c.revenue,
    title: `${c.name}: ${fmtMoney.format(c.revenue)} from ${fmtInt.format(c.units)} units`,
  }));

  renderProducts(data.top_products);
  renderOrders(data.recent_orders);

  const ref = data.refunds;
  $("#footer-note").textContent =
    `Revenue counts completed orders only. Refunded in period: ${fmtMoney.format(ref.amount)} ` +
    `(${fmtInt.format(ref.orders)} orders). Compared with ${data.previous_period.start} to ${data.previous_period.end}.`;
  $("#footer-updated").textContent = `Updated ${new Date(data.generated_at).toLocaleTimeString()}`;
}

function renderKpi(id, value, prev, fmt) {
  const card = document.getElementById(id);
  card.querySelector(".kpi-value").textContent = fmt(value);
  const delta = card.querySelector(".kpi-delta");
  delta.classList.remove("up", "down");
  if (!prev) {
    delta.textContent = "No data for the previous period";
    return;
  }
  const pct = ((value - prev) / prev) * 100;
  if (Math.abs(pct) < 0.05) {
    delta.textContent = "No change from the previous period";
    return;
  }
  delta.classList.add(pct > 0 ? "up" : "down");
  delta.textContent = `${pct > 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(1)}% vs previous period (${fmt(prev)})`;
}

function periodLabel(period, granularity, long = false) {
  const d = parseIso(period);
  if (granularity === "month") return fmtMonth.format(d);
  return long ? fmtDayLong.format(d) : fmtDay.format(d);
}

function renderLineChart(container, points, granularity) {
  container.replaceChildren();
  if (!points.length || points.every((p) => p.revenue === 0)) {
    container.append(h("div", { className: "empty" }, "No revenue in this period."));
    return;
  }

  const W = Math.max(container.clientWidth, 320);
  const H = 280;
  const m = { t: 16, r: 16, b: 30, l: 64 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const maxY = niceMax(Math.max(...points.map((p) => p.revenue)));
  const x = (i) => m.l + (points.length === 1 ? iw / 2 : (i * iw) / (points.length - 1));
  const y = (v) => m.t + ih - (v / maxY) * ih;

  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": "Revenue over time" }, container);

  // Y grid + labels
  for (let i = 0; i <= 4; i++) {
    const v = (maxY * i) / 4;
    const yy = y(v);
    svg("line", { x1: m.l, x2: W - m.r, y1: yy, y2: yy, class: "grid" }, root);
    svg("text", { x: m.l - 8, y: yy + 4, "text-anchor": "end", class: "axis" }, root).textContent = fmtCompact.format(v);
  }

  // X labels (about 7 of them)
  const step = Math.max(1, Math.ceil(points.length / 7));
  points.forEach((p, i) => {
    if (i % step !== 0) return;
    svg("text", { x: x(i), y: H - 8, "text-anchor": "middle", class: "axis" }, root).textContent = periodLabel(p.period, granularity);
  });

  // Area + line
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.revenue).toFixed(1)}`).join(" ");
  const base = (m.t + ih).toFixed(1);
  svg("path", { d: `${line} L${x(points.length - 1).toFixed(1)},${base} L${x(0).toFixed(1)},${base} Z`, class: "area" }, root);
  svg("path", { d: line, class: "line" }, root);
  if (points.length <= 45) {
    points.forEach((p, i) => svg("circle", { cx: x(i), cy: y(p.revenue), r: 3, class: "dot" }, root));
  }

  // Hover tooltip
  const focus = svg("line", { y1: m.t, y2: m.t + ih, class: "focus", visibility: "hidden" }, root);
  const marker = svg("circle", { r: 5, class: "dot", visibility: "hidden" }, root);
  const overlay = svg("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" }, root);
  const tip = h("div", { className: "tooltip", hidden: "" });
  container.append(tip);

  overlay.addEventListener("mousemove", (ev) => {
    const rect = root.getBoundingClientRect();
    const px = (ev.clientX - rect.left) * (W / rect.width);
    let i = points.length === 1 ? 0 : Math.round(((px - m.l) / iw) * (points.length - 1));
    i = Math.min(points.length - 1, Math.max(0, i));
    const p = points[i];
    const cx = x(i), cy = y(p.revenue);
    focus.setAttribute("x1", cx);
    focus.setAttribute("x2", cx);
    focus.setAttribute("visibility", "visible");
    marker.setAttribute("cx", cx);
    marker.setAttribute("cy", cy);
    marker.setAttribute("visibility", "visible");
    tip.textContent = `${periodLabel(p.period, granularity, true)}: ${fmtMoney.format(p.revenue)} · ${fmtInt.format(p.orders)} orders`;
    tip.style.left = `${(cx * rect.width) / W}px`;
    tip.style.top = `${(cy * rect.height) / H}px`;
    tip.hidden = false;
  });
  overlay.addEventListener("mouseleave", () => {
    focus.setAttribute("visibility", "hidden");
    marker.setAttribute("visibility", "hidden");
    tip.hidden = true;
  });
}

function renderBars(container, items, describe) {
  container.replaceChildren();
  const rows = items.map(describe);
  if (!rows.length || rows.every((r) => r.value === 0)) {
    container.append(h("div", { className: "empty" }, "No revenue in this period."));
    return;
  }
  const max = Math.max(...rows.map((r) => r.value)) || 1;
  for (const r of rows) {
    const fill = h("div", { className: "bar-fill" });
    fill.style.width = `${((r.value / max) * 100).toFixed(1)}%`;
    const cls = ["bar-row", r.selected ? "selected" : "", r.dim ? "dim" : ""].filter(Boolean).join(" ");
    container.append(
      h("div", { className: cls, title: r.title },
        h("span", { className: "bar-label" }, r.label),
        h("div", { className: "bar-track" }, fill),
        h("span", { className: "bar-value" }, fmtMoney.format(r.value)),
      ),
    );
  }
}

function emptyRow(tbody, cols, text) {
  const td = h("td", { colspan: String(cols), className: "empty" }, text);
  tbody.append(h("tr", {}, td));
}

function renderProducts(products) {
  const tbody = $("#table-products");
  tbody.replaceChildren();
  if (!products.length) return emptyRow(tbody, 4, "No sales in this period.");
  for (const p of products) {
    tbody.append(
      h("tr", {},
        h("td", {}, p.name),
        h("td", {}, p.category),
        h("td", { className: "num" }, fmtInt.format(p.units)),
        h("td", { className: "num" }, fmtMoney.format(p.revenue)),
      ),
    );
  }
}

function renderOrders(orders) {
  const tbody = $("#table-orders");
  tbody.replaceChildren();
  if (!orders.length) return emptyRow(tbody, 6, "No orders in this period.");
  for (const o of orders) {
    const status = KNOWN_STATUSES.has(o.status) ? o.status : "";
    tbody.append(
      h("tr", {},
        h("td", {}, o.id),
        h("td", {}, o.order_date.slice(0, 10)),
        h("td", {}, o.customer),
        h("td", {}, o.region),
        h("td", {}, h("span", { className: `badge ${status}` }, o.status)),
        h("td", { className: "num" }, fmtMoney2.format(o.total)),
      ),
    );
  }
}

// ---------------------------------------------------------------- init

async function init() {
  try {
    meta = await api("/api/meta");
  } catch (err) {
    showError(`Couldn't reach the server: ${err.message}`);
    return;
  }

  const regionSelect = $("#region");
  for (const r of meta.regions) regionSelect.append(h("option", { value: String(r.id) }, r.name));
  for (const id of ["#start", "#end"]) {
    if (meta.min_date) $(id).min = meta.min_date;
    if (meta.max_date) $(id).max = meta.max_date;
  }
  if (!meta.max_date) showError("The database has no orders yet.");

  restoreFromUrl();

  $("#preset").addEventListener("change", () => {
    applyPreset($("#preset").value);
    load();
  });
  for (const id of ["#start", "#end"]) {
    $(id).addEventListener("change", () => {
      $("#preset").value = "custom";
      load();
    });
  }
  $("#region").addEventListener("change", load);
  $("#filters").addEventListener("submit", (ev) => {
    ev.preventDefault();
    load();
  });

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (lastData) renderLineChart($("#chart-timeseries"), lastData.timeseries.points, lastData.timeseries.granularity);
    }, 150);
  });

  load();
}

document.addEventListener("DOMContentLoaded", init);

/* EU5 urban rights advisor - page controller. Runs js/rights-worker.js and
   draws what it finds. */
"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (v, d = 2) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(d);
const pct = (v) => (v >= 0 ? "+" : "−") + Math.round(Math.abs(v) * 100) + "%";
const RANKS = { rural_settlement: "Rural", town: "Town", city: "City", megalopolis: "Megalopolis" };
// one colour per right on the map, in a stable order
const CAT = ["#2a7fff", "#e8590c", "#2f9e44", "#ae3ec9", "#f59f00", "#1098ad", "#d6336c", "#5c940d", "#7048e8", "#868e96", "#c92a2a", "#0b7285"];

let worker = null, loaded = null, current = null, t0 = 0, timer = 0;
let mapMode = "best", selected = null;

// ---------------------------------------------------------------- status box
function logLine(msg) { $("log").textContent += msg + "\n"; }
function busy(on, text) {
  $("status").hidden = false;
  $("spinner").className = "spinner" + (on ? "" : " stop");
  if (text) $("stagetext").textContent = text;
  clearInterval(timer);
  if (on) {
    t0 = performance.now();
    timer = setInterval(() => { $("elapsed").textContent = ((performance.now() - t0) / 1000).toFixed(0) + "s"; }, 500);
  }
}
function fail(msg) {
  busy(false);
  $("spinner").className = "spinner fail";
  $("stagetext").textContent = "Couldn't read that save";
  $("errorbox").hidden = false;
  $("errorbox").textContent = msg;
}

// ---------------------------------------------------------------- worker
function startWorker() {
  if (worker) worker.terminate();
  worker = new Worker("js/rights-worker.js");
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "log") logLine(m.msg);
    else if (m.type === "stage") $("stagetext").textContent = m.msg;
    else if (m.type === "progress") $("buildbar").value = m.value;
    else if (m.type === "loaded") onLoaded(m.data);
    else if (m.type === "analysis") onAnalysis(m.data);
    else if (m.type === "error") fail(m.message);
  };
  worker.onerror = (e) => fail("The page's worker crashed: " + (e.message || "unknown error"));
}

function openSave(file) {
  if (!file) return;
  $("log").textContent = "";
  $("errorbox").hidden = true;
  $("buildbar").value = 0;
  busy(true, "Reading " + file.name + "…");
  startWorker();
  worker.postMessage({ save: file });
}

function onLoaded(data) {
  const keep = loaded ? +$("nation").value : null; // stay on the same nation when a newer save arrives
  loaded = data;
  mapImage = null; mapCrop = null;
  const sel = $("nation");
  const opt = (n) => `<option value="${n.cid}">${esc(n.name)}${n.name !== n.tag ? " (" + esc(n.tag) + ")" : ""}` +
    `${n.player ? " · " + esc(n.player) : ""} — ${n.locations} loc.</option>`;
  const players = data.nations.filter((n) => n.player), rest = data.nations.filter((n) => !n.player);
  sel.innerHTML = (players.length ? `<optgroup label="Players">${players.map(opt).join("")}</optgroup>` : "") +
    `<optgroup label="Everyone else">${rest.map(opt).join("")}</optgroup>`;
  const you = data.nations.find((n) => n.tag === data.you) || players[0] || data.nations[0];
  if (keep !== null && data.nations.some((n) => n.cid === keep)) sel.value = keep;
  else if (you) sel.value = you.cid;
  $("savename").textContent = `${data.save} · ${data.date} · game data ${data.pack.version}`;
  $("result").hidden = false;
  analyze();
}

function analyze() {
  if (!loaded) return;
  busy(true, "Valuing every right…");
  worker.postMessage({ type: "analyze", cid: +$("nation").value, boroughOnly: $("borough").checked, rgoPenalty: $("rgopen").checked });
}

function onAnalysis(d) {
  const sameNation = current && current.cid === d.cid;
  current = d;
  d.byLoc = new Map(d.rows.map((r) => [r.loc, r]));
  d.rname = (k) => (d.allRightNames[k] || k);
  d.gname = (k) => (d.goods[k] || k);
  d.color = new Map(d.rights.map((r, i) => [r.key, CAT[i % CAT.length]]));
  busy(false, `${d.name}: ${d.rows.length} locations valued`);
  $("buildbar").value = 1;
  if (!sameNation || !d.byLoc.has(selected)) {
    const top = d.rows.find((r) => r.slots > 0) || d.rows[0];
    selected = top ? top.loc : null;
  }
  $("rightsel").innerHTML = d.rights.map((r) => `<option value="${r.key}">${esc(r.name)}</option>`).join("");
  renderFuture(d);
  renderTiles(d);
  renderRecs(d);
  renderDetailSelect(d);
  renderDetail();
  drawMap();
}

// ---------------------------------------------------------------- results
function rightGoods(d, r) {
  return Object.entries(r.output).map(([g, v]) => `${esc(d.gname(g))} ${pct(v)}`).join(", ");
}
function slotChip(r) {
  if (!r.slots) return `<span class="status-chip rural">rural</span>`;
  return r.free ? `<span class="status-chip free">${r.free} free</span>` : `<span class="status-chip full">full</span>`;
}
function haveChips(d, r) {
  return r.have.map((h) => `<span class="rights-chip">${esc(d.rname(h))}</span>`).join("");
}
/* "wool from Nowe, Gniew" / "wool from its own RGO": a building's inputs an RGO in the province makes */
function sourceText(d, src) {
  return (src || []).map((s) => `${esc(d.gname(s.good).toLowerCase())} from ` +
    [s.own ? "its own RGO" : null, ...s.locs.map(esc)].filter(Boolean).join(", ")).join("; ");
}
function breakdown(d, v) {
  const parts = v.lines.map((l) => `${esc(l.what === "RGO" ? d.gname(l.good) + " RGO" : l.what)} ${fmt(l.value)}` +
    (l.src && l.src.length ? ` <span class="src">(${sourceText(d, l.src)})</span>` : ""));
  if (v.pen) parts.push(`−5% buildings ${fmt(v.pen)}`);
  return parts.join(" · ");
}

function renderTiles(d) {
  const towns = d.rows.filter((r) => r.slots > 0);
  const free = towns.filter((r) => r.free > 0 && r.picks.length);
  const total = free.reduce((s, r) => s + r.picks.slice(0, r.free).reduce((a, p) => a + p.net, 0), 0);
  const best = towns.filter((r) => r.picks.length).sort((a, b) => b.picks[0].net - a.picks[0].net)[0];
  const fut = d.future.filter((x) => x.r.slots === 0).length;
  const tile = (lab, num, det, up) => `<div class="tile"><div class="lab">${lab}</div>` +
    `<div class="num${up ? " up" : ""}">${num}</div><div class="det">${det}</div></div>`;
  $("tiles").innerHTML =
    tile("Borough Privileges", d.hasBorough === null ? "?" : d.hasBorough ? "Researched" : "Not yet",
      d.hasBorough ? "the production rights are open to you" : "an Age of Discovery advance; values below are what they'd be worth today", d.hasBorough) +
    tile("Best grant", best ? fmt(best.picks[0].net) : "–",
      best ? `${esc(d.rname(best.picks[0].right))} in ${esc(best.name)}` : "no town or city gains from one", !!best) +
    tile("Every free slot filled", fmt(total, 1),
      `${free.length} of ${towns.length} towns and cities have a free slot a right would pay in`, total > 0) +
    tile("Places to urbanise", String(fut), "rural locations whose RGO, or a guild fed by it, a right would boost &mdash; see Future towns", false);
}

// ---------------------------------------------------------------- tables (js/grid.js)
const { grid } = EU5Grid("eu5-rights-grids");
const rankOrder = (k) => ["rural_settlement", "town", "city", "megalopolis"].indexOf(k);
const F_MIN = { type: "min", key: "gold", label: "Min gold/mo" };
const F_Q = { type: "q", key: "name", label: "Location" };
const F_RANK = { type: "select", key: "rank", label: "Rank", text: (k) => RANKS[k] || k, order: rankOrder };
const F_RIGHT = { type: "select", key: "right", label: "Right", text: (k) => current.rname(k) };
const F_FREE = { type: "check", key: "free", label: "Free slot only" };

const nameCell = (x) => `${esc(x.r.name)}${slotChip(x.r)}`;
const goldCls = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");

function renderRecs(d) {
  const recs = [];
  for (const r of d.rows) {
    if (!r.slots) continue;
    r.picks.forEach((p, i) => {
      const v = r.values.find((x) => x.right === p.right);
      if (p.net > 0.005) recs.push({ r, p, v, loc: r.loc, name: r.name, rank: r.rank, right: p.right, gold: p.net, free: i < r.free });
    });
  }
  $("recsub").textContent = recs.length
    ? `The rights that would add the most output, location by location. Rows marked “full” need an existing right revoked first. Click a column to sort.`
    : `No town or city of ${d.name} makes enough of any boosted good for a right to beat its 5% penalty.`;
  grid("rectable", [
    { key: "loc", label: "Location", sort: (x) => x.name, cell: nameCell },
    { key: "rank", label: "Rank", sort: (x) => rankOrder(x.rank), cell: (x) => RANKS[x.rank] },
    { key: "right", label: "Grant", sort: (x) => d.rname(x.right), cell: (x) => `<b>${esc(d.rname(x.right))}</b>` },
    { key: "boosts", label: "Boosts", cell: (x) => `<small>${rightGoods(d, d.rights.find((y) => y.key === x.right))}</small>` },
    { key: "gold", label: "Gold/mo", num: true, sort: (x) => x.gold, cell: (x) => fmt(x.gold), cls: (x) => goldCls(x.gold) },
    { key: "why", label: "Where it comes from", cls: "wrap", cell: (x) => `<small>${breakdown(d, x.v)}</small>` },
    { key: "has", label: "Has", sort: (x) => x.r.have.length, cell: (x) => haveChips(d, x.r) },
  ], recs, { filters: [F_MIN, F_Q, F_RANK, F_RIGHT, F_FREE], sort: "gold", empty: "No grant pays." });

  const towns = d.rows.filter((r) => r.slots > 0).map((r) => {
    const ok = r.values.filter((v) => !v.blocked);
    return { r, a: ok[0], b: ok[1], loc: r.loc, name: r.name, rank: r.rank, right: ok[0] ? ok[0].right : null,
      gold: ok[0] ? ok[0].net : 0, free: r.free > 0 };
  });
  grid("alltable", [
    { key: "loc", label: "Location", sort: (x) => x.name, cell: nameCell },
    { key: "rank", label: "Rank", sort: (x) => rankOrder(x.rank), cell: (x) => RANKS[x.rank] },
    { key: "raw", label: "RGO", sort: (x) => d.gname(x.r.raw), cell: (x) => esc(d.gname(x.r.raw)) },
    { key: "rgo", label: "RGO gold", num: true, sort: (x) => x.r.rgoValue, cell: (x) => x.r.rgoValue.toFixed(1) },
    { key: "bld", label: "Bldg gold", num: true, sort: (x) => x.r.bldValue, cell: (x) => x.r.bldValue.toFixed(1) },
    { key: "right", label: "Best right", sort: (x) => (x.a ? d.rname(x.a.right) : ""), cell: (x) => (x.a ? esc(d.rname(x.a.right)) : "–") },
    { key: "gold", label: "Gold/mo", num: true, sort: (x) => x.gold, cell: (x) => (x.a ? fmt(x.gold) : ""), cls: (x) => goldCls(x.gold) },
    { key: "second", label: "2nd", num: true, sort: (x) => (x.b ? x.b.net : null),
      cell: (x) => (x.b ? `${esc(d.rname(x.b.right))} <small>${fmt(x.b.net)}</small>` : "") },
    { key: "has", label: "Has", sort: (x) => x.r.have.length, cell: (x) => haveChips(d, x.r) },
  ], towns, { filters: [F_MIN, F_Q, F_RANK, F_RIGHT, F_FREE], sort: "gold" });
}

function renderFuture(d) {
  const rows = d.rows.filter((r) => r.rank !== "city" && r.rank !== "megalopolis" && r.raw).map((r) => {
    let best = null;
    for (const [k, v] of Object.entries(r.rgoOnly)) if (v > 0 && (!best || v > best.v)) best = { k, v };
    const chain = r.chain.find((c) => c.gain > 0 && c.margin > 0) || null;
    // the right paying most here: its RGO boost plus, for the same right, the guild
    const pot = new Map();
    for (const [k, v] of Object.entries(r.rgoOnly)) if (v > 0) pot.set(k, v);
    if (chain) pot.set(chain.right, (pot.get(chain.right) || 0) + chain.gain);
    let right = null, gold = 0;
    for (const [k, v] of pot) if (v > gold) { right = k; gold = v; }
    return { r, best, chain, gold, right, loc: r.loc, name: r.name, rank: r.rank, free: false };
  }).filter((x) => x.gold > 0);
  d.future = rows;
  grid("futtable", [
    { key: "loc", label: "Location", sort: (x) => x.name, cell: nameCell },
    { key: "rank", label: "Rank", sort: (x) => rankOrder(x.rank), cell: (x) => RANKS[x.rank] },
    { key: "raw", label: "RGO", sort: (x) => d.gname(x.r.raw), cell: (x) => esc(d.gname(x.r.raw)) },
    { key: "out", label: "Output", num: true, sort: (x) => x.r.rgoAmount, cell: (x) => x.r.rgoAmount.toFixed(2) },
    { key: "wk", label: "Workers", num: true, sort: (x) => x.r.rgoWorkers, cell: (x) => `${x.r.rgoWorkers.toFixed(1)}<small>/${x.r.rgoMax.toFixed(0)}</small>` },
    { key: "gold", label: "Gold/mo", num: true, sort: (x) => x.gold, cell: (x) => fmt(x.gold), cls: "pos" },
    { key: "right", label: "Best right", sort: (x) => (x.right ? d.rname(x.right) : ""), cell: (x) => (x.right ? esc(d.rname(x.right)) : "–") },
    { key: "rgob", label: "RGO boost", num: true, sort: (x) => (x.best ? x.best.v : null), cell: (x) => (x.best ? `${fmt(x.best.v)}<br><small>${esc(d.rname(x.best.k))}</small>` : "") },
    { key: "guild", label: "Guild using all its output", sort: (x) => (x.chain ? d.buildingNames[x.chain.building] : ""),
      cell: (x) => (x.chain ? `${esc(d.buildingNames[x.chain.building] || x.chain.building)} → ${esc(d.gname(x.chain.good))}<br><small>${esc(d.rname(x.chain.right))}</small>` : "<span class=dim>–</span>") },
    { key: "lv", label: "Levels", num: true, sort: (x) => (x.chain ? x.chain.levels : null),
      cell: (x) => (x.chain ? `${x.chain.levels.toFixed(1)}${x.chain.uses < 0.99 ? `<br><small>uses ${Math.round(x.chain.uses * 100)}%</small>` : ""}` : "") },
    { key: "mg", label: "Margin/lvl", num: true, sort: (x) => (x.chain ? x.chain.margin : null), cell: (x) => (x.chain ? fmt(x.chain.margin) : ""), cls: (x) => (x.chain ? goldCls(x.chain.margin) : "") },
    { key: "ga", label: "Right adds", num: true, sort: (x) => (x.chain ? x.chain.gain : null), cell: (x) => (x.chain ? fmt(x.chain.gain) : ""), cls: "pos" },
  ], rows, { filters: [F_MIN, F_Q, F_RANK, F_RIGHT], sort: "gold" });
}

function renderDetailSelect(d) {
  const towns = [...d.rows].sort((a, b) => a.name.localeCompare(b.name));
  $("detsel").innerHTML = ["city", "town", "megalopolis", "rural_settlement"].map((k) => {
    const g = towns.filter((r) => r.rank === k);
    return g.length ? `<optgroup label="${RANKS[k]}">${g.map((r) => `<option value="${r.loc}">${esc(r.name)}</option>`).join("")}</optgroup>` : "";
  }).join("");
  $("detsel").value = selected;
}

function renderDetail() {
  const d = current, r = d && d.byLoc.get(selected);
  if (!r) return;
  $("detsel").value = r.loc;
  $("detname").textContent = r.name;
  $("detsub").innerHTML = `${RANKS[r.rank]}${r.port ? ", port" : ""} · RGO ${esc(d.gname(r.raw))} ${r.rgoAmount.toFixed(2)}/mo ` +
    `(${r.rgoWorkers.toFixed(1)} of ${r.rgoMax.toFixed(0)} thousand workers) · urban rights ${r.have.length} of ${r.slots}` +
    (r.have.length ? `: ${haveChips(d, r)}` : "") + ` · control ${(r.control * 100).toFixed(0)}%`;
  grid("dettable", [
    { key: "right", label: "Right", sort: (v) => d.rname(v.right),
      cell: (v) => `${esc(d.rname(v.right))}<br><small>${rightGoods(d, d.rights.find((x) => x.key === v.right))}</small>` },
    { key: "gold", label: "Gold/mo", num: true, sort: (v) => v.net, cell: (v) => fmt(v.net), cls: (v) => goldCls(v.net) },
    { key: "rgo", label: "RGO", num: true, sort: (v) => v.rgo, cell: (v) => (v.rgo ? fmt(v.rgo) : "") },
    { key: "bld", label: "Bldgs", num: true, sort: (v) => v.bld, cell: (v) => (v.bld ? fmt(v.bld) : "") },
    { key: "pen", label: "−5%", num: true, sort: (v) => v.pen, cell: (v) => (v.pen ? fmt(v.pen) : "") },
    { key: "note", label: "", cell: (v) => `<small>${v.blocked === "rural" ? "once it's a town" : v.blocked ? esc(v.blocked) : ""}</small>` },
  ], r.values.map((v) => ({ ...v, cls: `${r.picks.some((p) => p.right === v.right) ? "pick" : ""} ${v.blocked && v.blocked !== "rural" ? "blocked" : ""}` })),
  { sort: "gold" });
  const makes = [];
  if (r.rgoAmount) makes.push({ what: "RGO", good: r.raw, amount: r.rgoAmount, value: r.rgoValue, src: [] });
  for (const b of r.blds) makes.push({ what: `${esc(d.buildingNames[b.type] || b.type)} <small>L${b.level}</small>`, name: d.buildingNames[b.type] || b.type,
    good: b.good, amount: b.amount, value: b.value, src: b.src || [] });
  grid("maketable", [
    { key: "what", label: "Source", sort: (m) => m.name || "RGO", cell: (m) => m.what },
    { key: "good", label: "Good", sort: (m) => d.gname(m.good), cell: (m) => esc(d.gname(m.good)) },
    { key: "amount", label: "Amount", num: true, sort: (m) => m.amount, cell: (m) => m.amount.toFixed(2) },
    { key: "gold", label: "Gold/mo", num: true, sort: (m) => m.value, cell: (m) => m.value.toFixed(2) },
    { key: "src", label: "Inputs from an RGO in the province", cls: "wrap", sort: (m) => m.src.length, cell: (m) => `<small>${sourceText(d, m.src)}</small>` },
  ], makes, { sort: "gold", empty: "Nothing yet." });
  const bestR = r.best ? d.rname(r.best) : null;
  $("advhead").textContent = bestR ? `Grow these to get more from ${bestR}` : "Grow these";
  $("advtable").innerHTML = "<thead><tr><th>Good</th><th>Building</th><th class=n>Margin/level</th><th class=n>With right</th><th></th></tr></thead><tbody>" +
    (r.advice.length ? r.advice.map((a) => a.rgo
      ? `<tr><td>${esc(d.gname(a.good))}</td><td colspan=4>The RGO makes it: expand the RGO (${r.rgoWorkers.toFixed(1)} of ${r.rgoMax.toFixed(0)} workers now)</td></tr>`
      : `<tr><td>${esc(d.gname(a.good))}</td><td>${esc(a.name)}${a.unlocked ? "" : ' <small>(needs an advance)</small>'}` +
        `${a.local.length ? `<br><small>${sourceText(d, a.local)}</small>` : ""}</td>` +
        `<td class="n ${a.margin > 0 ? "pos" : "neg"}">${fmt(a.margin)}</td><td class="n ${a.marginWith > 0 ? "pos" : "neg"}">${fmt(a.marginWith)}</td>` +
        `<td><small>out ${a.output}/lvl</small></td></tr>`).join("")
      : `<tr><td colspan=5 class=dim>No right pays here yet.</td></tr>`) + "</tbody>";
}

// ---------------------------------------------------------------- map
let mapImage = null, mapCrop = null;
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const rgbOf = (h) => { h = h.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const mix = (a, b, t) => a.map((v, k) => Math.round(v + (b[k] - v) * t));
function ramp(names) {
  const stops = names.map((n) => rgbOf(cssVar(n)));
  return (t) => {
    t = Math.max(0, Math.min(1, t)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(t)), f = t - i;
    return mix(stops[i], stops[i + 1], f);
  };
}

async function loadMapImage() {
  if (mapImage) return mapImage;
  const r = await fetch(loaded.pack.base + "locations_half.png");
  if (!r.ok) throw new Error("map image " + r.status);
  mapImage = await createImageBitmap(await r.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  return mapImage;
}

async function drawMap() {
  const d = current;
  if (!d) return;
  let img;
  try { img = await loadMapImage(); } catch (e) { logLine("map: " + e.message); return; }
  if (current !== d) return;
  const pts = Object.values(d.xy), xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pad = Math.max(40, 0.12 * Math.max(x1 - x0, y1 - y0));
  x0 = Math.max(0, Math.floor(x0 - pad)); y0 = Math.max(0, Math.floor(y0 - pad));
  x1 = Math.min(img.width, Math.ceil(x1 + pad)); y1 = Math.min(img.height, Math.ceil(y1 + pad));
  const w = x1 - x0, h = y1 - y0, key = [d.cid, x0, y0, w, h].join();
  if (!mapCrop || mapCrop.key !== key) {
    const oc = new OffscreenCanvas(w, h), ox = oc.getContext("2d", { willReadFrequently: true });
    ox.drawImage(img, x0, y0, w, h, 0, 0, w, h);
    const px = ox.getImageData(0, 0, w, h).data, lid = new Uint16Array(w * h);
    for (let p = 0; p < w * h; p++) lid[p] = (px[p * 4 + 1] << 8) | px[p * 4 + 2];
    mapCrop = { key, x0, y0, w, h, lid };
  }
  paintMap();
}

/* loc -> {v, right} for the current mode */
function mapValues(d) {
  const out = new Map();
  const one = $("rightsel").value;
  for (const r of d.rows) {
    if (mapMode === "best") {
      const v = r.values.find((x) => !x.blocked || x.blocked === "rural");
      out.set(r.loc, v && v.net > 0 ? { v: v.net, right: v.right } : { v: 0 });
    } else if (mapMode === "rgo") {
      // town potential: the RGO boost plus what the right adds to a guild using all the RGO's output
      const pot = new Map();
      for (const [k, v] of Object.entries(r.rgoOnly)) if (v > 0) pot.set(k, v);
      for (const c of r.chain) if (c.gain > 0 && c.margin > 0) pot.set(c.right, (pot.get(c.right) || 0) + c.gain);
      let best = { v: 0 };
      for (const [k, v] of pot) if (v > best.v) best = { v, right: k };
      out.set(r.loc, best);
    } else {
      const v = r.values.find((x) => x.right === one);
      out.set(r.loc, { v: v ? v.net : 0, right: one });
    }
  }
  return out;
}

function paintMap() {
  const d = current, c = mapCrop;
  if (!d || !c) return;
  const vals = mapValues(d);
  let max = 0;
  for (const x of vals.values()) max = Math.max(max, Math.abs(x.v));
  max = max || 1;
  const foreign = rgbOf(cssVar("--map-foreign")), sea = rgbOf(cssVar("--map-sea")), zero = rgbOf(cssVar("--map-zero"));
  const seq = ramp(["--gain-0", "--gain-1", "--gain-2", "--gain-3", "--gain-4", "--gain-5"]);
  const neg = rgbOf(cssVar("--seq-2"));
  const kind = loaded.kind;
  const lut = new Map();
  const colorOf = (l) => {
    if (lut.has(l)) return lut.get(l);
    const x = vals.get(l);
    let rgb;
    if (!x) rgb = kind[l] === 0 || kind[l] === 3 ? foreign : sea;
    else if (mapMode === "one") rgb = x.v > 0.005 ? seq(Math.sqrt(x.v / max)) : x.v < -0.005 ? mix(zero, neg, Math.min(1, Math.sqrt(-x.v / max) + 0.15)) : zero;
    else if (x.v > 0.005) rgb = mix(zero, rgbOf(d.color.get(x.right)), 0.3 + 0.7 * Math.sqrt(x.v / max));
    else rgb = zero;
    lut.set(l, rgb);
    return rgb;
  };
  const s = Math.max(1, Math.min(6, Math.floor(1100 / c.w)));
  const W = c.w * s, H = c.h * s;
  const cv = $("map");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  const id = ctx.createImageData(W, H), out = id.data;
  for (let y = 0; y < c.h; y++) {
    for (let x = 0; x < c.w; x++) {
      const p = y * c.w + x, l = c.lid[p];
      let rgb = colorOf(l);
      const r = x + 1 < c.w ? c.lid[p + 1] : l, b = y + 1 < c.h ? c.lid[p + c.w] : l;
      const edge = (r !== l && (vals.has(r) || vals.has(l))) || (b !== l && (vals.has(b) || vals.has(l)));
      if (edge) rgb = rgb.map((v) => v * 0.7);
      if (l === selected && edge) rgb = [20, 20, 20];
      for (let yy = 0; yy < s; yy++) {
        let o = ((y * s + yy) * W + x * s) * 4;
        for (let xx = 0; xx < s; xx++, o += 4) { out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2]; out[o + 3] = 255; }
      }
    }
  }
  ctx.putImageData(id, 0, 0);
  drawMarkers(ctx, s);
  drawLegend(d, vals, max, seq, neg, zero);
}

function drawMarkers(ctx, s) {
  const d = current, c = mapCrop;
  const at = (l) => { const p = d.xy[l]; return [(p[0] - c.x0 + 0.5) * s, (p[1] - c.y0 + 0.5) * s]; };
  const r = Math.max(5, Math.min(11, 4 + s * 1.3));
  const ink = cssVar("--ink"), halo = cssVar("--raised"), accent = cssVar("--accent");
  for (const row of d.rows) {
    if (!row.slots && row.loc !== d.capital) continue;
    const [x, y] = at(row.loc);
    ctx.save();
    ctx.lineWidth = 2.2; ctx.strokeStyle = halo; ctx.fillStyle = row.loc === d.capital ? accent : ink;
    ctx.beginPath();
    if (row.loc === d.capital) {
      for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r * 1.1; ctx.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a)); }
      ctx.closePath();
    } else if (row.rank === "town") {
      const q = r * 0.6; ctx.moveTo(x, y - q); ctx.lineTo(x + q * 0.8, y); ctx.lineTo(x, y + q); ctx.lineTo(x - q * 0.8, y); ctx.closePath();
    } else ctx.arc(x, y, r * 0.5, 0, Math.PI * 2);
    ctx.stroke(); ctx.fill();
    if (row.have.length) { ctx.lineWidth = 1.6; ctx.strokeStyle = ink; ctx.strokeRect(x - r * 0.95, y - r * 0.95, r * 1.9, r * 1.9); }
    ctx.restore();
  }
}

function drawLegend(d, vals, max, seq, neg, zero) {
  if (mapMode === "one") {
    const n = 12, cells = Array.from({ length: n }, (_, i) => `<i style="background:rgb(${seq(i / (n - 1)).join(",")})"></i>`).join("");
    $("legend").innerHTML = `<span>${esc(d.rname($("rightsel").value))}: gold a month in each location</span>` +
      `<span class="scale"><span class="bar">${cells}</span><span class="ticks"><span>0</span><span>${fmt(max / 4)}</span><span>${fmt(max)}</span></span></span>` +
      `<span class="cats"><span><i style="background:rgb(${mix(zero, neg, 0.6).join(",")})"></i>loses output</span></span>`;
    return;
  }
  const used = new Set([...vals.values()].filter((x) => x.v > 0.005).map((x) => x.right));
  const label = mapMode === "best" ? "Best right in each location (stronger colour: more gold a month)"
    : "Town potential: the right that would pay most for the RGO and a guild using all its output (as for a new town)";
  $("legend").innerHTML = `<span>${label}</span><span class="cats">` +
    d.rights.filter((r) => used.has(r.key)).map((r) => `<span><i style="background:${d.color.get(r.key)}"></i>${esc(r.name)}</span>`).join("") +
    `<span><i style="background:rgb(${zero.join(",")})"></i>none pays</span></span>`;
}

function locAt(e) {
  const d = current, c = mapCrop, cv = $("map");
  if (!d || !c) return null;
  const rect = cv.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) / rect.width * c.w), y = Math.floor((e.clientY - rect.top) / rect.height * c.h);
  const l = c.lid[y * c.w + x];
  return d.byLoc.has(l) ? l : null;
}

function onHover(e) {
  const d = current, tip = $("tip"), l = locAt(e);
  if (l === null) { tip.hidden = true; return; }
  const r = d.byLoc.get(l);
  const row = (a, b) => `<div class="row"><span>${a}</span><span>${b}</span></div>`;
  const top = r.values.filter((v) => !v.blocked || v.blocked === "rural").slice(0, 3);
  tip.innerHTML = `<b>${esc(r.name)}</b>` + row("Rank", RANKS[r.rank] + (r.slots ? ` · ${r.have.length}/${r.slots} rights` : "")) +
    row("RGO", `${esc(d.gname(r.raw))} ${r.rgoAmount.toFixed(2)}`) + row("Output, gold/mo", `RGO ${r.rgoValue.toFixed(1)} · bldg ${r.bldValue.toFixed(1)}`) +
    (r.have.length ? row("Has", r.have.map((h) => esc(d.rname(h))).join(", ")) : "") +
    top.map((v) => row(esc(d.rname(v.right)), fmt(v.net))).join("");
  tip.hidden = false;
  const bx = $("mapbox").getBoundingClientRect();
  let tx = e.clientX - bx.left + 14, ty = e.clientY - bx.top + 14;
  if (tx + tip.offsetWidth > bx.width) tx = e.clientX - bx.left - tip.offsetWidth - 14;
  if (ty + tip.offsetHeight > bx.height) ty = Math.max(0, e.clientY - bx.top - tip.offsetHeight - 14);
  tip.style.left = tx + "px"; tip.style.top = ty + "px";
}

function select(loc, scroll) {
  if (!current || !current.byLoc.has(loc)) return;
  selected = loc;
  renderDetail();
  paintMap();
  if (scroll) $("detailcard").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------------------------------------------------------------- wiring
const drop = $("drop");
$("saveinput").addEventListener("change", (e) => openSave(e.target.files[0]));
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("saveinput").click(); } });
for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  EU5Saves.fromDrop(e).then((fs) => { if (fs[0]) { openSave(fs[0].file); linked.then((l) => l.note(fs[0].file)); } });
});
// The leaderboard's latest save and the remembered ones; loads it when allowed.
const linked = EU5Saves.mount($("linked"), (file) => openSave(file));
for (const id of ["nation", "borough", "rgopen"]) $(id).addEventListener("change", analyze);
$("detsel").addEventListener("change", () => select(+$("detsel").value, false));
$("rightsel").addEventListener("change", paintMap);
for (const b of $("mapmode").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    mapMode = b.dataset.mode;
    for (const o of $("mapmode").querySelectorAll("button")) o.setAttribute("aria-selected", o === b ? "true" : "false");
    $("oneright").hidden = mapMode !== "one";
    paintMap();
  });
}
document.addEventListener("click", (e) => {
  const tr = e.target.closest("tr.click");
  if (tr) select(+tr.dataset.loc, true);
});
$("map").addEventListener("mousemove", onHover);
$("map").addEventListener("mouseleave", () => { $("tip").hidden = true; });
$("map").addEventListener("click", (e) => { const l = locAt(e); if (l !== null) select(l, false); });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paintMap);

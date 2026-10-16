/* EU5 loan & build advisor - page controller. Runs js/loans-worker.js and
   draws what it finds. */
"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const g2 = (v, d = 2) => (isFinite(v) ? v.toFixed(d) : "–");
const sg = (v, d = 2) => (isFinite(v) ? (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(d) : "–");
const pc = (v, d = 1) => (isFinite(v) ? (v * 100).toFixed(d) + "%" : "–");
const yrs = (m) => (!isFinite(m) || m <= 0 ? "never" : m > 1200 ? "100+ yr" : m >= 24 ? (m / 12).toFixed(0) + " yr" : Math.round(m) + " mo");
const RANKS = { rural_settlement: "Rural", town: "Town", city: "City", megalopolis: "Megalopolis" };
const KINDS = { expand: "Expand", new: "New building", rgo: "RGO" };
const VERDICTS = { self: "Pays for itself", interest: "Covers interest only", loss: "Doesn't cover interest", none: "No return" };

let worker = null, loaded = null, current = null, t0 = 0, timer = 0;
let mode = "loan", mapMode = "cover";
const userRate = { loan: null, bond: null }; // % a year typed by the user, per financing

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
  worker = new Worker("js/loans-worker.js");
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

function num(id) { const v = parseFloat($(id).value); return isFinite(v) ? v : undefined; }
function analyze() {
  if (!loaded) return;
  busy(true, "Pricing every project…");
  const rate = userRate[mode];
  worker.postMessage({ type: "analyze", cid: +$("nation").value, mode, rate: rate == null ? undefined : rate / 100,
    term: num("term"), budget: num("budget") });
}

function onAnalysis(d) {
  if (current && current.cid !== d.cid) { userRate.loan = null; userRate.bond = null; }
  current = d;
  d.byLoc = new Map();
  for (const p of d.projects) if (!p.blocked && p.levels > 0) {
    const o = d.byLoc.get(p.loc);
    if (!o || p.cover > o.cover) d.byLoc.set(p.loc, p);
  }
  busy(false, `${d.name}: ${d.projects.length} projects priced`);
  $("buildbar").value = 1;
  $("rate").value = (d.opts.rate * 100).toFixed(2).replace(/\.?0+$/, "");
  $("termctl").hidden = d.opts.mode === "bond";
  renderTiles(d);
  renderPlan(d);
  renderProjects(d);
  renderOwed(d);
  renderCompare(d);
  drawMap();
}

// ---------------------------------------------------------------- tiles
function renderTiles(d) {
  const E = d.econ, bal = E.income - E.expense;
  const owedI = d.owed.reduce((s, o) => s + o.monthly, 0);
  const tile = (lab, n, det, cls) => `<div class="tile"><div class="lab">${lab}</div><div class="num ${cls || ""}">${n}</div><div class="det">${det}</div></div>`;
  const bcost = d.baseGold.building * d.costFactor.building;
  $("tiles").innerHTML =
    tile("Treasury", g2(E.gold, 0), `${sg(bal, 1)} a month (income ${g2(E.income, 1)}, spending ${g2(E.expense, 1)})`, bal >= 0 ? "up" : "") +
    tile("Debt", g2(E.debt, 0), `${g2(owedI, 2)} a month in interest · ${d.owed.length} loan${d.owed.length === 1 ? "" : "s"} and bonds`) +
    tile("Creditworthiness", g2(E.credit * 100, 0), E.credit >= 0.5 ? "above 50: cheaper loans than the base rate" : "below 50: dearer loans than the base rate", E.credit >= 0.5 ? "up" : "") +
    tile("Treasury's share", pc(d.capture, 0), `of each gold of tax base; tax income ${g2(E.taxIncome, 1)} in the save, ${g2(d.modelTax, 1)} rebuilt`);
  $("fitnote").innerHTML = `A level of an Age of Traditions building costs you about <b>${g2(bcost, 1)} gold</b> ` +
    `(${g2(d.baseGold.building, 0)} &times; ${g2(d.costFactor.building)}, from ${d.costFactor.from.building === "own" ? `${d.costFactor.ownBuilding} of your constructions` : "the world's constructions"}). ` +
    `Each gold of building profit adds <b>${g2(d.wealth.building)}</b> of location wealth and each gold of RGO output <b>${g2(d.wealth.rgo)}</b> (fitted over every location in the save). ` +
    `Rates start at ${d.rates.loanFrom === "own" ? "the lowest you pay now" : "the world's going rate"}: loans ${pc(d.rates.loan, 2)}, bonds ${pc(d.rates.bond, 2)}.`;
}

// ---------------------------------------------------------------- tables (js/grid.js)
const { grid } = EU5Grid("eu5-loans-grids");
const goldCls = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");
function covBar(p) {
  const w = Math.max(0, Math.min(1, (isFinite(p.cover) ? p.cover : 1.5) / 1.5)) * 100;
  const col = p.verdict === "self" ? "var(--verd)" : p.verdict === "interest" ? "var(--accent)" : "var(--alarm)";
  return `<span class="cov"><span class="track"><span class="fill" style="width:${w.toFixed(0)}%;background:${col}"></span><span class="mark"></span></span>` +
    `<b>${isFinite(p.cover) ? Math.round(p.cover * 100) + "%" : "–"}</b></span>`;
}
const chip = (v) => `<span class="verdict-chip ${v}">${VERDICTS[v]}</span>`;
const whatCell = (p) => `<b>${esc(p.what)}</b>${p.kind === "expand" ? ` <small>L${p.level}</small>` : ""}` +
  `<span class="basis">${esc(p.basis)}${p.crowded && !p.blocked ? ` · <span class="warn">${p.crowded} in this market laying off</span>` : ""}</span>`;
const F_MIN = { type: "min", key: "toTreasury", label: "Min to treasury", step: 0.05 };
const F_Q = { type: "q", key: "name", label: "Location" };
const F_KIND = { type: "select", key: "kind", label: "Kind", text: (k) => KINDS[k] || k };
const F_VERD = { type: "select", key: "verdict", label: "Verdict", text: (k) => VERDICTS[k] || k };

function renderPlan(d) {
  const T = d.planTotals, o = d.opts, loan = o.mode === "loan";
  const terms = loan ? `a ${o.term}-month loan at ${pc(o.rate, 2)}` : `a government bond at ${pc(o.rate, 2)}`;
  const ok = d.projects.filter((p) => !p.blocked && p.levels > 0 && p.toTreasury > 0).sort((a, b) => b.toTreasury / b.cost - a.toTreasury / a.cost);
  const crowded = ok.filter((p) => p.crowded && p.verdict === "self");
  const crowdNote = crowded.length
    ? ` ${crowded.map((p) => `<b>${esc(p.what)} in ${esc(p.name)}</b>`).join(", ")} would pay for it, but ${crowded.length === 1 ? "its" : "their"} market already has ` +
      `buildings of the same kind laying off workers, so more of them would likely push prices down; the plan leaves ${crowded.length === 1 ? "it" : "them"} out.`
    : "";
  const top = ok.find((p) => !p.crowded) || ok[0];
  if (!d.plan.length) {
    const repay = !loan ? "" : top && top.rateRepay > 0 ? ` and repays a ${o.term}-month loan only below ${pc(top.rateRepay)}`
      : `, but its returns can't put the principal aside within ${o.term} months at any rate`;
    $("plansub").innerHTML = (top
      ? `Nothing ${esc(d.name)} can build pays for ${terms}.${crowdNote} The best return per gold is <b>${esc(top.what)} in ${esc(top.name)}</b>: ` +
        `${g2(top.toTreasury, 3)} a month to the treasury for ${g2(top.cost, 1)} gold, which covers interest up to <b>${pc(top.rateInterest)}</b>${repay}. ` +
        (loan && top.rateInterest >= d.rates.bond ? "A bond at your bond rate would carry it &mdash; switch to Government bond above." : "If you build, build from the treasury; these are the best uses of cash:")
      : `${esc(d.name)} has nothing it can build right now: see why under the table below.`);
    $("plansum").innerHTML = "";
    grid("plantable", planCols(d, false), ok.slice(0, 8), { sort: "ret", click: false, empty: "Nothing to build." });
    return;
  }
  $("plansub").innerHTML = `Funded with ${terms}, these pay for themselves, best return per gold first, up to ${g2(o.budget, 0)} gold. ` +
    `No market gets more new levels of a building than it already has.${crowdNote}` +
    (loan ? ` A loan is interest only: put <b>${g2(T.principal / o.term, 2)}</b> a month aside to repay it in month ${o.term}, or it is extended (&minus;3 creditworthiness).` :
      ` A bond is never repaid unless you redeem it; its interest runs for as long as it stands.`);
  const s = (lab, v, det, cls) => `<div class="s"><div class="lab">${lab}</div><div class="v ${cls || ""}">${v}</div><div class="d">${det}</div></div>`;
  $("plansum").innerHTML =
    s("Borrow", g2(T.principal, 0), `${d.plan.reduce((a, p) => a + p.take, 0)} levels in ${new Set(d.plan.map((p) => p.loc)).size} locations`) +
    s("Returns", sg(T.monthly, 2), "a month to the treasury", "pos") +
    s("Interest", "−" + g2(T.interest, 2), "a month") +
    s(loan ? "Left after interest" : "Net", sg(T.net, 2), loan ? `needs ${g2(T.principal / o.term, 2)}/mo set aside` : "a month, for as long as the bond stands", T.net >= 0 ? "pos" : "neg") +
    s("Clears its principal", loan ? yrs(T.repayMonths) : "–", loan ? `from returns after interest; term is ${o.term} mo` : "bonds have no term");
  grid("plantable", planCols(d, true), d.plan, { sort: "ret", click: false });
}
function planCols(d, plan) {
  return [
    { key: "name", label: "Location", sort: (p) => p.name, cell: (p) => `${esc(p.name)} <small>${RANKS[p.rank] || ""}</small>` },
    { key: "what", label: "Project", sort: (p) => p.what, cls: "wrap", cell: whatCell },
    { key: "take", label: plan ? "Levels" : "Free", num: true, sort: (p) => (plan ? p.take : p.levels), cell: (p) => String(plan ? p.take : p.levels) },
    { key: "cost", label: plan ? "Cost" : "Cost/lvl", num: true, sort: (p) => p.cost * (plan ? p.take : 1), cell: (p) => g2(p.cost * (plan ? p.take : 1), 1) },
    { key: "tt", label: "To treasury/mo", num: true, sort: (p) => p.toTreasury * (plan ? p.take : 1), cell: (p) => sg(p.toTreasury * (plan ? p.take : 1), 3), cls: "pos" },
    { key: "int", label: "Interest/mo", num: true, sort: (p) => p.interest * (plan ? p.take : 1), cell: (p) => "−" + g2(p.interest * (plan ? p.take : 1), 3) },
    { key: "ret", label: "Covers", num: true, sort: (p) => p.toTreasury / p.cost, cell: covBar },
    { key: "pay", label: "Cash payback", num: true, sort: (p) => -p.payback, cell: (p) => yrs(p.payback) },
  ];
}

function renderProjects(d) {
  const ok = d.projects.filter((p) => !p.blocked && p.levels > 0);
  grid("projtable", [
    { key: "name", label: "Location", sort: (p) => p.name, cell: (p) => `${esc(p.name)} <small>${RANKS[p.rank] || ""}</small>` },
    { key: "what", label: "Project", sort: (p) => p.what, cls: "wrap", cell: whatCell },
    { key: "levels", label: "Free", num: true, sort: (p) => p.levels, cell: (p) => String(p.levels) },
    { key: "cost", label: "Cost/lvl", num: true, sort: (p) => p.cost, cell: (p) => g2(p.cost, 1) },
    { key: "profit", label: "Profit/lvl", num: true, sort: (p) => p.profit, cell: (p) => g2(p.profit, 3) },
    { key: "toTreasury", label: "To treasury", num: true, sort: (p) => p.toTreasury,
      cell: (p) => `${g2(p.toTreasury, 3)}<br><small>${pc(p.control, 0)} ctl × ${pc(p.capture, 0)} tax</small>`, cls: (p) => goldCls(p.toTreasury) },
    { key: "need", label: "Break-even", num: true, sort: (p) => p.need, cell: (p) => g2(p.need, 3) },
    { key: "cover", label: "Covers", num: true, sort: (p) => (isFinite(p.cover) ? p.cover : 99), cell: covBar },
    { key: "rate", label: "Pays interest up to", num: true, sort: (p) => p.rateInterest, cell: (p) => pc(p.rateInterest) },
    { key: "pay", label: "Cash payback", num: true, sort: (p) => -p.payback, cell: (p) => yrs(p.payback) },
    { key: "verdict", label: "Verdict", sort: (p) => ["self", "interest", "loss", "none"].indexOf(p.verdict) * -1, cell: (p) => chip(p.verdict) },
  ], ok, { filters: [F_MIN, F_Q, F_KIND, F_VERD], sort: "cover", click: false, empty: "Nothing can be built now." });

  const no = d.projects.filter((p) => p.blocked || p.levels <= 0).map((p) => ({ ...p, why: p.blocked || "no room" }));
  grid("blocktable", [
    { key: "name", label: "Location", sort: (p) => p.name, cell: (p) => esc(p.name) },
    { key: "what", label: "Project", sort: (p) => p.what, cell: (p) => `${esc(p.what)}${p.kind === "expand" ? ` <small>L${p.level}</small>` : ""}` },
    { key: "profit", label: "Profit/lvl", num: true, sort: (p) => p.profit, cell: (p) => g2(p.profit, 3), cls: (p) => goldCls(p.profit) },
    { key: "why", label: "Why not", sort: (p) => p.why, cls: "wrap", cell: (p) => esc(p.why) },
  ], no, { filters: [F_Q, F_KIND, { type: "q", key: "why", label: "Reason", placeholder: "laying off…" }], sort: "profit", click: false });
}

function renderOwed(d) {
  const E = d.econ, I = d.owed.reduce((s, o) => s + o.monthly, 0);
  $("owesub").innerHTML = `${g2(E.debt, 1)} gold in all: ${g2(E.foreignDebt, 1)} to other countries, ${g2(E.bondDebt, 1)} in bonds` +
    (E.estateDebt ? `, ${g2(E.estateDebt, 1)} to the estates` : "") + `; <b>${g2(I, 2)}</b> a month in interest, ` +
    `${E.income > 0 ? pc(I / E.income, 1) : "–"} of income.` +
    (d.lent.count ? ` You lend ${g2(d.lent.amount, 0)} gold to others for ${g2(d.lent.monthly, 2)} a month.` : "") +
    ` Your estates could lend up to ${g2(E.loanCapacity, 0)}.`;
  grid("owetable", [
    { key: "who", label: "Owed to", sort: (o) => (o.bond ? "~bond" : o.lenderName || "estates"), cell: (o) => (o.bond ? "Government bond" : esc(o.lenderName || "Estates")) },
    { key: "amount", label: "Amount", num: true, sort: (o) => o.amount, cell: (o) => g2(o.amount, 1) },
    { key: "rate", label: "Rate", num: true, sort: (o) => o.rate, cell: (o) => pc(o.rate, 2) },
    { key: "term", label: "Term", num: true, sort: (o) => o.months || 9999, cell: (o) => (o.months ? o.months + " mo" : "none") },
    { key: "monthly", label: "Interest/mo", num: true, sort: (o) => o.monthly, cell: (o) => g2(o.monthly, 2) },
  ], d.owed, { sort: "rate", click: false, empty: "Nothing: no loans or bonds." });
}

function renderCompare(d) {
  const P = 100, T = d.opts.mode === "loan" ? d.opts.term : 60;
  const rows = [
    { what: `Loan, ${T} months at ${pc(d.rates.loan, 2)}`, i: P * d.rates.loan / 12, need: P * d.rates.loan / 12 + P / T, life: P * d.rates.loan / 12 * T, end: `repay ${P} in month ${T}` },
    { what: `Bond at ${pc(d.rates.bond, 2)}`, i: P * d.rates.bond / 12, need: P * d.rates.bond / 12, life: P * d.rates.bond / 12 * T, end: "never due; redeem when you like" },
  ];
  $("cmptable").innerHTML = `<thead><tr><th>100 gold as a</th><th class=n>Interest/mo</th><th class=n>Break-even</th><th class=n>${T} mo of interest</th></tr></thead><tbody>` +
    rows.map((r) => `<tr><td>${esc(r.what)}<span class="basis">${r.end}</span></td><td class=n>${g2(r.i, 3)}</td><td class=n>${g2(r.need, 3)}</td><td class=n>${g2(r.life, 1)}</td></tr>`).join("") + "</tbody>";
  const cheaper = d.rates.bond < d.rates.loan;
  $("cmpnote").innerHTML = cheaper
    ? `Bonds are the cheaper money for ${esc(d.name)}: a project only has to beat ${pc(d.rates.bond, 2)} a year, not ${pc(d.rates.loan, 2)} plus its principal. ` +
      `The catch is that a bond's interest never stops until you redeem it, so it suits projects that earn for good.`
    : `Loans are no dearer than bonds for ${esc(d.name)} right now.`;
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

function paintMap() {
  const d = current, c = mapCrop;
  if (!d || !c) return;
  const own = new Set(Object.keys(d.xy).map(Number));
  let max = 0;
  for (const p of d.byLoc.values()) max = Math.max(max, p.toTreasury / p.cost);
  max = max || 1;
  const foreign = rgbOf(cssVar("--map-foreign")), sea = rgbOf(cssVar("--map-sea")), zero = rgbOf(cssVar("--map-zero"));
  const verd = rgbOf(cssVar("--verd")), acc = rgbOf(cssVar("--accent")), alarm = rgbOf(cssVar("--alarm"));
  const seq = ramp(["--gain-0", "--gain-1", "--gain-2", "--gain-3", "--gain-4", "--gain-5"]);
  const kind = loaded.kind, lut = new Map();
  const colorOf = (l) => {
    if (lut.has(l)) return lut.get(l);
    let rgb;
    if (!own.has(l)) rgb = kind[l] === 0 || kind[l] === 3 ? foreign : sea;
    else {
      const p = d.byLoc.get(l);
      if (!p) rgb = zero;
      else if (mapMode === "return") rgb = seq(Math.sqrt(p.toTreasury / p.cost / max));
      else rgb = p.verdict === "self" ? verd : p.verdict === "interest" ? mix(zero, acc, 0.75) : mix(zero, alarm, 0.15 + 0.5 * Math.min(1, p.cover));
    }
    lut.set(l, rgb);
    return rgb;
  };
  const s = Math.max(1, Math.min(6, Math.floor(1100 / c.w)));
  const W = c.w * s, H = c.h * s, cv = $("map");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d"), id = ctx.createImageData(W, H), out = id.data;
  for (let y = 0; y < c.h; y++) {
    for (let x = 0; x < c.w; x++) {
      const p = y * c.w + x, l = c.lid[p];
      let rgb = colorOf(l);
      const r = x + 1 < c.w ? c.lid[p + 1] : l, b = y + 1 < c.h ? c.lid[p + c.w] : l;
      if ((r !== l && (own.has(r) || own.has(l))) || (b !== l && (own.has(b) || own.has(l)))) rgb = rgb.map((v) => v * 0.7);
      for (let yy = 0; yy < s; yy++) {
        let o = ((y * s + yy) * W + x * s) * 4;
        for (let xx = 0; xx < s; xx++, o += 4) { out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2]; out[o + 3] = 255; }
      }
    }
  }
  ctx.putImageData(id, 0, 0);
  if (d.xy[d.capital]) {
    const [cx, cy] = [(d.xy[d.capital][0] - c.x0 + 0.5) * s, (d.xy[d.capital][1] - c.y0 + 0.5) * s], r = Math.max(5, Math.min(11, 4 + s * 1.3));
    ctx.save(); ctx.lineWidth = 2.2; ctx.strokeStyle = cssVar("--raised"); ctx.fillStyle = cssVar("--accent"); ctx.beginPath();
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r * 1.1; ctx.lineTo(cx + rr * Math.cos(a), cy + rr * Math.sin(a)); }
    ctx.closePath(); ctx.stroke(); ctx.fill(); ctx.restore();
  }
  const sw = (rgb) => `<i style="background:rgb(${rgb.join(",")})"></i>`;
  if (mapMode === "return") {
    const n = 12, cells = Array.from({ length: n }, (_, i) => `<i style="background:rgb(${seq(i / (n - 1)).join(",")})"></i>`).join("");
    $("legend").innerHTML = `<span>Best project's monthly treasury return per gold spent</span><span class="scale"><span class="bar">${cells}</span>` +
      `<span class="ticks"><span>0</span><span>${pc(max / 4, 2)}</span><span>${pc(max, 2)}</span></span></span>` +
      `<span class="cats"><span>${sw(zero)}nothing to build</span></span>`;
  } else {
    $("legend").innerHTML = `<span>Best project in each location, on ${d.opts.mode === "loan" ? `a ${d.opts.term}-month loan` : "a bond"} at ${pc(d.opts.rate, 2)}</span><span class="cats">` +
      `<span>${sw(verd)}pays for itself</span><span>${sw(mix(zero, acc, 0.75))}covers interest only</span>` +
      `<span>${sw(mix(zero, alarm, 0.55))}doesn't cover interest</span><span>${sw(zero)}nothing to build</span></span>`;
  }
}

function locAt(e) {
  const c = mapCrop, cv = $("map");
  if (!current || !c) return null;
  const rect = cv.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) / rect.width * c.w), y = Math.floor((e.clientY - rect.top) / rect.height * c.h);
  const l = c.lid[y * c.w + x];
  return current.xy[l] ? l : null;
}

function onHover(e) {
  const d = current, tip = $("tip"), l = locAt(e);
  if (l === null) { tip.hidden = true; return; }
  const p = d.byLoc.get(l);
  const row = (a, b) => `<div class="row"><span>${a}</span><span>${b}</span></div>`;
  tip.innerHTML = `<b>${esc(d.locNames[l])}</b>` + (p
    ? row("Best project", esc(p.what)) + row("Cost a level", g2(p.cost, 1)) + row("To treasury", g2(p.toTreasury, 3) + "/mo") +
      row("Break-even", g2(p.need, 3) + "/mo") + row("Covers", isFinite(p.cover) ? Math.round(p.cover * 100) + "%" : "–") +
      row("Pays interest up to", pc(p.rateInterest))
    : row("Nothing to build", ""));
  tip.hidden = false;
  const bx = $("mapbox").getBoundingClientRect();
  let tx = e.clientX - bx.left + 14, ty = e.clientY - bx.top + 14;
  if (tx + tip.offsetWidth > bx.width) tx = e.clientX - bx.left - tip.offsetWidth - 14;
  if (ty + tip.offsetHeight > bx.height) ty = Math.max(0, e.clientY - bx.top - tip.offsetHeight - 14);
  tip.style.left = tx + "px"; tip.style.top = ty + "px";
}

/* clicking a location filters the project table to it */
function focusLoc(l) {
  const box = $("projtable-f"), q = box && box.querySelector('input[data-k="name"]');
  if (!q) return;
  q.value = current.locNames[l];
  q.dispatchEvent(new Event("input", { bubbles: true }));
  $("projtable").scrollIntoView({ behavior: "smooth", block: "start" });
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
$("nation").addEventListener("change", analyze);
for (const b of $("mode").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    mode = b.dataset.mode;
    for (const o of $("mode").querySelectorAll("button")) o.setAttribute("aria-checked", o === b ? "true" : "false");
    analyze();
  });
}
let debounce = 0;
const later = () => { clearTimeout(debounce); debounce = setTimeout(analyze, 250); };
$("rate").addEventListener("input", () => { const v = parseFloat($("rate").value); if (isFinite(v) && v > 0) { userRate[mode] = v; later(); } });
for (const id of ["term", "budget"]) $(id).addEventListener("input", later);
$("ratereset").addEventListener("click", () => { userRate[mode] = null; analyze(); });
for (const b of $("mapmode").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    mapMode = b.dataset.mode;
    for (const o of $("mapmode").querySelectorAll("button")) o.setAttribute("aria-selected", o === b ? "true" : "false");
    paintMap();
  });
}
$("map").addEventListener("mousemove", onHover);
$("map").addEventListener("mouseleave", () => { $("tip").hidden = true; });
$("map").addEventListener("click", (e) => { const l = locAt(e); if (l !== null) focusLoc(l); });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paintMap);

/* EU5 privateer finder - page controller. Runs js/privateer-worker.js and
   draws what it finds; scoring and filtering happen here so the weights
   respond at once. */
"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const BASES = { flow: "Trade through the port", tax: "Port's tax", ptax: "Port's possible tax" };
const REL = { self: "You", family: "Subject/overlord", friend: "Ally", enemy: "At war", rival: "Rival", neutral: "Neutral", none: "Unowned" };
const STORE = "eu5-privateers";

let worker = null, loaded = null, current = null, reqId = 0, t0 = 0, timer = 0;
let sel = null;            // selected area index (k)
let shown = [];            // the scored, filtered rows in rank order
const obs = new Map();     // loc -> gold the game shows (calibration)
let zoneArea = null;       // sea zone id -> area index
const settings = (() => {
  const d = { base: "flow", factor: 0.01, calibrated: false, w: { gold: 1, hurt: 0.5, risk: 0.5, opinion: 0.25 } };
  try { return Object.assign(d, JSON.parse(localStorage.getItem(STORE)) || {}); } catch (e) { return d; }
})();
const saveSettings = () => { try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch (e) {} };
let rangeOverride = null;  // the user's naval range, if they typed one

// ---------------------------------------------------------------- status box
function logLine(msg) { const l = $("log"); l.textContent += msg + "\n"; }
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
  worker = new Worker("js/privateer-worker.js");
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "log") logLine(m.msg);
    else if (m.type === "stage") $("stagetext").textContent = m.msg;
    else if (m.type === "progress") $("buildbar").value = m.value;
    else if (m.type === "loaded") onLoaded(m.data);
    else if (m.type === "analysis") { if (m.req === reqId) onAnalysis(m.data); }
    else if (m.type === "calibration") onCalibration(m.data);
    else if (m.type === "error") fail(m.message);
  };
  worker.onerror = (e) => fail("The page's worker crashed: " + (e.message || "unknown error"));
}

let scrollOnce = false;   // scroll to the results after a save the user picked
function openSave(file, scroll = true) {
  if (!file) return;
  $("log").textContent = "";
  $("errorbox").hidden = true;
  $("buildbar").value = 0;
  busy(true, "Reading " + file.name + "…");
  startWorker();
  scrollOnce = scroll;
  worker.postMessage({ save: file });
}

/* The early-game view shipped with the game data (privateer-start.json). */
function openStart() {
  $("log").textContent = "";
  $("errorbox").hidden = true;
  $("buildbar").value = 0;
  busy(true, "Loading the game-start view…");
  startWorker();
  worker.postMessage({ type: "start" });
}

function onLoaded(data) {
  // stay on the same nation (by tag: a save from another campaign numbers countries differently)
  const keep = loaded && current ? current.tag : null;
  loaded = data;
  mapImage = null; mapCrop = null;
  zoneArea = new Map();
  data.areas.forEach((a, k) => { for (const z of a.zones) zoneArea.set(z, k); });
  const opt = (n) => `<option value="${n.cid}">${esc(n.name)}${n.name !== n.tag ? " (" + esc(n.tag) + ")" : ""}` +
    `${n.player ? " · " + esc(n.player) : ""} — ${n.ports} ports</option>`;
  const players = data.nations.filter((n) => n.player), rest = data.nations.filter((n) => !n.player);
  $("nation").innerHTML = (players.length ? `<optgroup label="Players">${players.map(opt).join("")}</optgroup>` : "") +
    `<optgroup label="Everyone else">${rest.map(opt).join("")}</optgroup>`;
  const you = data.nations.find((n) => n.tag === data.you) || players[0] || data.nations[0];
  const kept = keep && data.nations.find((n) => n.tag === keep);
  if (kept) $("nation").value = kept.cid;
  else if (you) $("nation").value = you.cid;
  $("basis").innerHTML = data.start
    ? `<span class="tag">Game start</span><span>The world on <b>${esc(data.date)}</b>, from the game data ` +
      `${esc(data.pack.version)}. Drop your own save above to rank from where your campaign stands now.</span>`
    : `<span class="tag save">Your save</span><span class="mono">${esc(data.save)} · ${esc(data.date)} · game data ${esc(data.pack.version)}</span>` +
      `<button type="button" class="linkbtn" id="tostart">Back to the game-start view</button>`;
  $("result").hidden = false;
  analyze();
}

function analyze() {
  if (!loaded) return;
  reqId++;
  busy(true, "Weighing up the seas…");
  worker.postMessage({ type: "analyze", req: reqId, cid: +$("nation").value, base: settings.base, factor: settings.factor });
}

function onAnalysis(d) {
  const first = !current || current.cid !== d.cid;
  current = d;
  if (first) { rangeOverride = null; sel = null; obs.clear(); }
  $("range").value = Math.round(rangeOverride ?? d.stats.range);
  busy(false, `${d.name}: ${d.rows.length} sea areas weighed`);
  $("buildbar").value = 1;
  render();
  drawMap();
  if (scrollOnce) { scrollOnce = false; $("result").scrollIntoView({ behavior: "smooth", block: "start" }); }
}

// ---------------------------------------------------------------- scoring
function rescore() {
  const d = current, w = settings.w, range = +$("range").value || 0;
  let rows = d.rows.map((r) => ({ ...r, inRange: r.distance != null && r.distance <= range }));
  if ($("inrange").checked) rows = rows.filter((r) => r.inRange);
  if ($("hireable").checked) rows = rows.filter((r) => r.eligible);
  const max = (f) => Math.max(1e-9, ...rows.map(f));
  const mg = max((r) => r.gold), mh = max((r) => r.hurt), mr = max((r) => r.harass), mo = max((r) => -r.opinion);
  const top = Math.max(1e-9, w.gold + w.hurt);
  for (const r of rows)
    r.score = 100 * (w.gold * r.gold / mg + w.hurt * r.hurt / mh - w.risk * r.harass / mr - w.opinion * -r.opinion / mo) / top;
  rows.sort((a, b) => b.score - a.score);
  rows.forEach((r, i) => { r.no = i + 1; r.loc = r.k; });
  shown = rows;
}

// ---------------------------------------------------------------- results
const gold = (v) => v.toFixed(2);
const chip = (cls, text, title) => `<span class="chip ${cls}"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</span>`;
const relTag = (r) => `<span class="rel ${esc(r)}">${esc(REL[r] || r)}</span>`;

function render() {
  if (!current) return;
  rescore();
  renderTiles();
  renderTable();
  if (sel != null && !current.rows.some((r) => r.k === sel)) sel = null;
  if (sel == null && shown.length) sel = shown[0].k;
  renderDetail();
}

function renderTiles() {
  const d = current, st = d.stats;
  const tile = (lab, num, det, up) => `<div class="tile"><div class="lab">${lab}</div>` +
    `<div class="num${up ? " up" : ""}">${num}</div><div class="det">${det}</div></div>`;
  const how = st.sources.filter((s) => s.can_hire_privateers).map((s) => esc(s.name));
  const best = shown[0];
  const rangeSrc = st.sources.filter((s) => s.naval_range || s.naval_range_modifier).map((s) => esc(s.name));
  $("tiles").innerHTML =
    tile("Can hire privateers", st.canHire ? "Yes" : "Not yet",
      st.canHire ? "through " + how.join(", ")
        : "needs the <em>Privateers</em> advance (Renaissance), <em>Letters of Marque</em> (Reformation) or the state piracy policy", st.canHire) +
    tile("Best area", best ? esc(best.name) : "–",
      best ? `about ${gold(best.gold)} gold a month at full power, from ${best.open} port${best.open === 1 ? "" : "s"}` : "nothing qualifies", !!best) +
    tile("Naval range", Math.round(st.range).toLocaleString(),
      rangeSrc.length ? "base 1,000 + " + rangeSrc.join(", ") : "the starting 1,000; naval advances add more") +
    tile("Privateers out", String(d.existing.length),
      d.existing.length ? d.existing.map((p) => `${esc(areaName(p.area))} (${Math.round(p.power * 100)}%)`).join(", ") : "none hired yet");
  const basis = BASES[settings.base];
  $("fitnote").innerHTML = `Gold is <b>${settings.factor} × ${basis.toLowerCase()}</b> for every port that can be raided, at full privateer power. ` +
    (settings.calibrated ? "Calibrated against the game's tooltip."
      : "That's an <b>estimate</b>: the game computes plunder in its engine. Use <em>Calibrate</em> under an area once you have a privateer out.") +
    ` Durability ${Math.round(st.durability * 100)}% · income ${d.income.toFixed(1)} gold a month.`;
}

const areaName = (key) => { const a = loaded.areas.find((x) => x.key === key); return a ? a.name : key; };

const { grid } = EU5Grid("eu5-privateer-grids");
function renderTable() {
  const d = current;
  const max = Math.max(1e-9, ...shown.map((r) => r.score));
  $("ranksub").textContent = `${shown.length} sea area${shown.length === 1 ? "" : "s"}` +
    ($("inrange").checked ? " within naval range" : "") + ($("hireable").checked ? " you may hire in" : "") +
    `, best first. The score weighs plunder and rivals' shipping against pirate hunters and anger, each scaled to the best area. ` +
    `Click a row for the details.`;
  const rows = shown.map((r) => ({ ...r, cls: r.k === sel ? "sel" : "" }));
  grid("areatable", [
    { key: "no", label: "#", num: true, sort: (r) => -r.no, cell: (r) => r.no },
    { key: "name", label: "Sea area", sort: (r) => r.name, cell: (r) => esc(r.name) +
      (r.hired ? chip("hired", "Hired " + Math.round(r.hired.power * 100) + "%") : "") +
      (!r.inRange ? chip("out", "Out of range") : "") + (!r.eligible ? chip("no", "Can't hire", "anti-piracy agreements with every port owner") : "") },
    { key: "score", label: "Score", num: true, sort: (r) => r.score,
      cell: (r) => `<span class="bar" style="width:${Math.max(0, 50 * r.score / max).toFixed(0)}px"></span>${r.score.toFixed(0)}` },
    { key: "gold", label: "Gold/mo", num: true, sort: (r) => r.gold, cell: (r) => gold(r.gold) },
    { key: "open", label: "Ports", num: true, sort: (r) => r.open,
      cell: (r) => `${r.open}<small>/${r.ports}</small>` + (r.blocked ? ` <small title="with a coastal fort">${r.blocked}🛡</small>` : "") },
    { key: "hurt", label: "Rivals' shipping", num: true, sort: (r) => r.hurt, cell: (r) => r.hurt.toFixed(1) },
    { key: "harass", label: "Hunters", num: true, sort: (r) => r.harass, cell: (r) => r.harass ? r.harass.toFixed(1) : "–",
      cls: (r) => (r.harass > 2 ? "neg" : "") },
    { key: "opinion", label: "Opinion", num: true, sort: (r) => r.opinion, cell: (r) => r.opinion, cls: (r) => (r.opinion < -150 ? "neg" : "") },
    { key: "distance", label: "Distance", num: true, sort: (r) => (isFinite(r.distance) ? r.distance : 1e9), cell: (r) => isFinite(r.distance) ? r.distance.toLocaleString() : "–" },
  ], rows, { sort: "no", empty: "No sea area qualifies. Untick the filters above to see them all.", filters: [
    { type: "q", key: "name", label: "Sea area", placeholder: "name…" },
    { type: "min", key: "gold", label: "Min gold/mo", step: 0.25 },
  ] });
}

function renderDetail() {
  const d = current, r = d.rows.find((x) => x.k === sel);
  $("detail").hidden = !r;
  if (!r) return;
  const s = shown.find((x) => x.k === sel);
  $("dettitle").textContent = r.name;
  $("detsub").innerHTML = (s ? `Ranked <b>${s.no}</b> of ${shown.length} · score ${s.score.toFixed(0)} · ` : "Not in the list with the current filters · ") +
    `<b>${gold(r.gold)}</b> gold a month from ${r.open} of ${r.ports} ports` +
    (r.own ? ` (${r.own} are yours or your subjects')` : "") + (r.blocked ? `, ${r.blocked} behind coastal forts` : "") +
    ` · ${isFinite(r.distance) ? r.distance.toLocaleString() + " sailing distance" : "not reachable by sea"}` +
    ` · opinion ${r.opinion} in total`;
  // victims
  const vt = $("victims");
  vt.innerHTML = "<thead><tr><th>Country</th><th>Relation</th><th class='n'>Ports</th><th class='n'>Gold/mo</th>" +
    "<th class='n' title='Share of their monthly income'>Of income</th><th class='n'>Opinion</th></tr></thead><tbody>" +
    (r.victims.length ? r.victims.map((v) => `<tr><td>${esc(v.name)} <small>${esc(v.tag)}</small></td><td>${relTag(v.rel)}</td>` +
      `<td class="n">${v.ports}</td><td class="n">${gold(v.gold)}</td><td class="n">${(v.share * 100).toFixed(1)}%</td>` +
      `<td class="n${v.opinion <= -100 ? " neg" : ""}">${v.opinion}</td></tr>`).join("")
      : `<tr><td colspan="6" class="dim">No port here can be raided.</td></tr>`) + "</tbody>";
  // shipping
  const sh = $("shipping");
  sh.innerHTML = "<thead><tr><th>Country</th><th>Relation</th><th class='n' title='Average maritime presence per sea zone'>Presence</th></tr></thead><tbody>" +
    (r.top.length ? r.top.map((t) => `<tr><td>${esc(t.name)} <small>${esc(t.tag)}</small></td><td>${relTag(t.rel)}</td>` +
      `<td class="n">${t.presence.toFixed(1)}</td></tr>`).join("") : `<tr><td colspan="3" class="dim">No one has maritime presence here.</td></tr>`) +
    (r.presenceMine ? `<tr><td colspan="2" class="dim">Yours (not harassed)</td><td class="n dim">${r.presenceMine.toFixed(1)}</td></tr>` : "") +
    "</tbody>";
  const bits = [];
  bits.push(r.harass ? `Pirate hunters: ${r.harass.toFixed(2)} harassment last month, about ${(r.powerDrift * 100).toFixed(1)}% privateer power a month.`
    : "No pirate hunting here last month.");
  if (r.others.length) bits.push("Already raiding here: " + r.others.map((p) => `${esc(p.name)} (${Math.round(p.power * 100)}%)`).join(", ") + ".");
  if (r.hired) bits.push(`Your privateer is here at ${Math.round(r.hired.power * 100)}% power.`);
  $("others").innerHTML = bits.join(" ");
  renderPorts(r);
}

const { grid: portGrid } = EU5Grid("eu5-privateer-ports");
function renderPorts(r) {
  const unit = { flow: "Trade", tax: "Tax", ptax: "Poss. tax" }[current.base] || "Base";
  const rows = r.portRows.map((p) => ({ ...p, status: p.raidable ? "open" : p.blocked ? "fort" : p.rel === "self" || p.rel === "family" ? "own" : p.owner < 0 ? "empty" : "agreement" }));
  const ST = { open: ["ready", "Raidable"], fort: ["now", "Coastal fort"], own: ["now", "Yours"], empty: ["now", "Unowned"], agreement: ["now", "Agreement"] };
  portGrid("ports", [
    { key: "name", label: "Port", sort: (p) => p.name, cell: (p) => `${esc(p.name)} <small>${esc(p.rank)}</small>` },
    { key: "ownerName", label: "Owner", sort: (p) => p.ownerName, cell: (p) => `${esc(p.ownerTag || "–")}` },
    { key: "value", label: unit, num: true, sort: (p) => p.value, cell: (p) => p.value.toFixed(2) },
    { key: "gold", label: "Gold/mo", num: true, sort: (p) => p.gold, cell: (p) => (p.raidable ? gold(p.gold) : "–") },
    { key: "status", label: "", sort: (p) => Object.keys(ST).indexOf(p.status), cell: (p) => chip(ST[p.status][0], ST[p.status][1]) },
    { key: "obs", label: "Game shows", sort: (p) => obs.get(p.loc) ?? -1,
      cell: (p) => `<input class="obs" type="number" step="0.01" min="0" data-obs="${p.loc}" value="${obs.has(p.loc) ? obs.get(p.loc) : ""}">` },
  ], rows, { sort: "value", click: false, filters: [{ type: "check", key: "raidable", label: "Raidable only" }] });
}

// ---------------------------------------------------------------- calibration
function runCalibration() {
  const power = Math.max(0.01, (+$("calpower").value || 100) / 100);
  const list = [...obs].filter(([, v]) => v > 0).map(([loc, v]) => ({ loc, gold: v / power }));
  if (!list.length) { $("calnote").textContent = "Type the gold the game shows for at least one port first."; return; }
  $("calnote").textContent = `from ${list.length} port${list.length === 1 ? "" : "s"}…`;
  worker.postMessage({ type: "calibrate", obs: list });
}
function onCalibration(c) {
  const best = Object.entries(c).sort((a, b) => a[1].error - b[1].error)[0][0];
  $("calnote").textContent = obs.size > 1 ? `${BASES[best]} fits best.` : "One port can't tell the figures apart; enter two or more.";
  $("caltable").innerHTML = "<thead><tr><th>Gold from each port</th><th class='n'>Factor</th><th class='n'>Average miss</th><th></th></tr></thead><tbody>" +
    Object.entries(c).map(([k, v]) => `<tr${k === best ? ' class="sel"' : ""}><td>${esc(BASES[k])}</td><td class="n">${v.factor.toPrecision(3)}</td>` +
      `<td class="n">${(v.error * 100).toFixed(1)}%</td><td><button type="button" class="btn small" data-use="${k}" data-f="${v.factor}">Use</button></td></tr>`).join("") +
    "</tbody>";
}

// ---------------------------------------------------------------- map
let mapImage = null, mapCrop = null;
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const rgbOf = (h) => { h = h.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
function ramp(names) {
  const stops = names.map((n) => rgbOf(cssVar(n)));
  return (t) => {
    t = Math.max(0, Math.min(1, t)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(t)), f = t - i;
    return stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
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
  // frame the nation and the best areas shown
  const xy = loaded.xy, xs = [], ys = [];
  const add = (l) => { if (xy[2 * l] || xy[2 * l + 1]) { xs.push(xy[2 * l]); ys.push(xy[2 * l + 1]); } };
  for (const l of d.own) add(l);
  for (const r of shown.slice(0, 12)) for (const z of r.zones) add(z);
  if (!xs.length) { xs.push(0, img.width); ys.push(0, img.height); }
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pad = Math.max(40, 0.08 * Math.max(x1 - x0, y1 - y0));
  x0 = Math.max(0, Math.floor(x0 - pad)); y0 = Math.max(0, Math.floor(y0 - pad));
  x1 = Math.min(img.width, Math.ceil(x1 + pad)); y1 = Math.min(img.height, Math.ceil(y1 + pad));
  const w = x1 - x0, h = y1 - y0, key = [x0, y0, w, h].join();
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
  const kind = loaded.kind;
  const byK = new Map(shown.map((r) => [r.k, r]));
  const lo = Math.min(0, ...shown.map((r) => r.score)), hi = Math.max(1e-9, ...shown.map((r) => r.score));
  const col = ramp(["--seq-0", "--seq-1", "--seq-2", "--seq-3", "--seq-4", "--seq-5", "--seq-6"]);
  const foreign = rgbOf(cssVar("--map-foreign")), sea = rgbOf(cssVar("--map-sea"));
  const landCol = Object.fromEntries(["self", "family", "friend", "rival", "enemy"].map((k) => [k, rgbOf(cssVar("--map-" + k))]));
  const selCol = rgbOf(cssVar("--alarm"));
  const own = new Set(d.own);
  const areaOf = (l) => (kind[l] === 1 ? zoneArea.get(l) ?? -1 : -2);
  const lut = new Map();
  const colorOf = (l) => {
    if (lut.has(l)) return lut.get(l);
    let rgb;
    if (kind[l] === 1) {
      const r = byK.get(zoneArea.get(l));
      rgb = r ? col((r.score - lo) / (hi - lo)) : sea;
    } else if (kind[l] === 0) rgb = own.has(l) ? landCol.self : landCol[d.landRel[l]] || foreign;
    else rgb = kind[l] === 2 ? sea : foreign;
    lut.set(l, rgb);
    return rgb;
  };
  const s = Math.max(1, Math.min(4, Math.floor(1100 / c.w)));
  const W = c.w * s, H = c.h * s, cv = $("map");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  const id = ctx.createImageData(W, H), out = id.data;
  for (let y = 0; y < c.h; y++) {
    for (let x = 0; x < c.w; x++) {
      const p = y * c.w + x, l = c.lid[p];
      let rgb = colorOf(l);
      const r = x + 1 < c.w ? c.lid[p + 1] : l, b = y + 1 < c.h ? c.lid[p + c.w] : l;
      const a = areaOf(l), ar = areaOf(r), ab = areaOf(b);
      const selEdge = sel != null && ((a === sel) !== (ar === sel) || (a === sel) !== (ab === sel));
      if (selEdge) rgb = selCol;
      else if (ar !== a || ab !== a) rgb = rgb.map((v) => v * 0.72);
      else if (kind[l] === 0 && (r !== l || b !== l) && (own.has(l) || own.has(r) || own.has(b))) rgb = rgb.map((v) => v * 0.85);
      for (let yy = 0; yy < s; yy++) {
        let o = ((y * s + yy) * W + x * s) * 4;
        for (let xx = 0; xx < s; xx++, o += 4) { out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2]; out[o + 3] = 255; }
      }
    }
  }
  ctx.putImageData(id, 0, 0);
  drawMarkers(ctx, s);
  drawLegend(lo, hi, col);
}

function drawMarkers(ctx, s) {
  const d = current, c = mapCrop, xy = loaded.xy;
  const at = (l) => [(xy[2 * l] - c.x0 + 0.5) * s, (xy[2 * l + 1] - c.y0 + 0.5) * s];
  const halo = cssVar("--raised"), alarm = cssVar("--alarm"), ink = cssVar("--ink"), dim = cssVar("--ink-3");
  const r = sel != null && d.rows.find((x) => x.k === sel);
  if (r) for (const p of r.portRows) {
    if (!p.raidable && !p.blocked) continue;
    const [x, y] = at(p.loc);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(2.5, 1.2 * s + 1.5), 0, Math.PI * 2);
    ctx.lineWidth = 1.5; ctx.strokeStyle = halo; ctx.fillStyle = p.blocked ? dim : alarm;
    ctx.fill(); ctx.stroke();
  }
  // rank numbers on the best areas
  ctx.font = `600 ${Math.max(11, 7 + s * 2)}px Archivo, sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (const a of shown.slice(0, 10)) {
    const [x, y] = [(a.centre[0] - c.x0) * s, (a.centre[1] - c.y0) * s];
    if (x < 0 || y < 0 || x > c.w * s || y > c.h * s) continue;
    ctx.lineWidth = 3.5; ctx.strokeStyle = halo; ctx.strokeText(String(a.no), x, y);
    ctx.fillStyle = a.k === sel ? alarm : ink; ctx.fillText(String(a.no), x, y);
  }
}

function drawLegend(lo, hi, col) {
  const n = 12, cells = Array.from({ length: n }, (_, i) => `<i style="background:rgb(${col(i / (n - 1)).join(",")})"></i>`).join("");
  $("legend").innerHTML = `<span>Score of the sea areas listed</span><span class="scale"><span class="bar">${cells}</span>` +
    `<span class="ticks"><span>${lo.toFixed(0)}</span><span>${((lo + hi) / 2).toFixed(0)}</span><span>${hi.toFixed(0)}</span></span></span>`;
  const sw = (v, t) => `<span><i style="background:${cssVar(v)}"></i>${t}</span>`;
  $("mapkey").innerHTML = sw("--map-self", "you") + sw("--map-family", "subjects/overlord") + sw("--map-friend", "allies") +
    sw("--map-rival", "rivals") + sw("--map-enemy", "at war") +
    `<span><i style="background:${cssVar("--alarm")};border-radius:50%"></i>ports the selected area raids</span>` +
    `<span><i style="background:${cssVar("--ink-3")};border-radius:50%"></i>behind a coastal fort</span>`;
}

function locAt(e) {
  const c = mapCrop, cv = $("map"), rect = cv.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) / rect.width * c.w), y = Math.floor((e.clientY - rect.top) / rect.height * c.h);
  return c.lid[y * c.w + x];
}
function onHover(e) {
  const d = current, tip = $("tip");
  if (!d || !mapCrop) return;
  const l = locAt(e), k = loaded.kind[l] === 1 ? zoneArea.get(l) : undefined;
  const row = (a, b) => `<div class="row"><span>${a}</span><span>${b}</span></div>`;
  let html = "";
  if (k !== undefined) {
    const r = d.rows.find((x) => x.k === k), s = shown.find((x) => x.k === k);
    html = `<b>${esc(loaded.areas[k].name)}</b>` + row("Sea zone", esc(loaded.names[l] || "")) +
      (r ? row("Rank", s ? s.no + " · score " + s.score.toFixed(0) : "not listed") + row("Gold/mo", gold(r.gold)) +
        row("Ports raidable", r.open + "/" + r.ports) + row("Rivals' shipping", r.hurt.toFixed(1)) +
        row("Hunters", r.harass.toFixed(1)) + row("Opinion", r.opinion) : row("Ports", "none"));
  } else if (loaded.kind[l] === 0) {
    html = `<b>${esc(loaded.names[l] || "")}</b>` + (d.own.includes(l) ? row("Owner", "you") : d.landRel[l] ? row("Owner", REL[d.landRel[l]]) : "");
  }
  if (!html) { tip.hidden = true; return; }
  tip.innerHTML = html;
  tip.hidden = false;
  const bx = $("mapbox").getBoundingClientRect();
  let tx = e.clientX - bx.left + 14, ty = e.clientY - bx.top + 14;
  if (tx + tip.offsetWidth > bx.width) tx = e.clientX - bx.left - tip.offsetWidth - 14;
  if (ty + tip.offsetHeight > bx.height) ty = Math.max(0, e.clientY - bx.top - tip.offsetHeight - 14);
  tip.style.left = tx + "px"; tip.style.top = ty + "px";
}

function select(k, scroll) {
  sel = k;
  renderTable();
  renderDetail();
  paintMap();
  if (scroll) $("detail").scrollIntoView({ behavior: "smooth", block: "start" });
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
// Open on the game-start view; the leaderboard's latest save, when the browser
// still allows reading it, replaces it straight away.
openStart();
const linked = EU5Saves.mount($("linked"), (file) => openSave(file, false));

$("base").innerHTML = Object.entries(BASES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
$("base").value = settings.base;
$("factor").value = settings.factor;
for (const k of Object.keys(settings.w)) {
  const el = $("w-" + k), show = () => { $("w-" + k + "-v").textContent = (+el.value).toFixed(2).replace(/\.?0+$/, "") || "0"; };
  el.value = settings.w[k]; show();
  el.addEventListener("input", () => { settings.w[k] = +el.value; show(); saveSettings(); if (current) { render(); drawMap(); } });
}
$("nation").addEventListener("change", analyze);
$("base").addEventListener("change", () => { settings.base = $("base").value; settings.calibrated = false; saveSettings(); analyze(); });
$("factor").addEventListener("change", () => { settings.factor = Math.max(0, +$("factor").value || 0); settings.calibrated = false; saveSettings(); analyze(); });
$("range").addEventListener("change", () => { rangeOverride = +$("range").value; if (current) { render(); drawMap(); } });
for (const id of ["inrange", "hireable"]) $(id).addEventListener("change", () => { if (current) { render(); drawMap(); } });
$("calrun").addEventListener("click", runCalibration);
document.addEventListener("input", (e) => {
  const loc = e.target.dataset && e.target.dataset.obs;
  if (loc == null) return;
  const v = parseFloat(e.target.value);
  if (Number.isFinite(v)) obs.set(+loc, v); else obs.delete(+loc);
});
document.addEventListener("click", (e) => {
  const use = e.target.closest("[data-use]");
  if (use) {
    settings.base = use.dataset.use; settings.factor = +(+use.dataset.f).toPrecision(3); settings.calibrated = true; saveSettings();
    $("base").value = settings.base; $("factor").value = settings.factor;
    analyze();
    return;
  }
  if (e.target.id === "tostart") { openStart(); return; }
  const tr = e.target.closest("#areatable tr.click");
  if (tr) select(+tr.dataset.loc, true);
});
$("map").addEventListener("mousemove", onHover);
$("map").addEventListener("mouseleave", () => { $("tip").hidden = true; });
$("map").addEventListener("click", (e) => {
  if (!current || !mapCrop) return;
  const l = locAt(e), k = loaded.kind[l] === 1 ? zoneArea.get(l) : undefined;
  if (k !== undefined && current.rows.some((r) => r.k === k)) select(k, false);
});

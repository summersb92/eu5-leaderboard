/* EU5 capital & governor finder - page controller. Runs
   js/placement-worker.js and draws what it finds. */
"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (v, d = 2) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(d);
const STATUS = {
  ready: ["ready", "Can build"], city: ["city", "Needs a city"], road: ["road", "Needs a road"],
  "city+road": ["city+road", "Needs city + road"],
};

let worker = null, loaded = null, current = null, reqId = 0, t0 = 0, timer = 0;
let mapMode = "plan";

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
  worker = new Worker("js/placement-worker.js");
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
  loaded = data;
  mapImage = null;
  const sel = $("nation");
  sel.innerHTML = "";
  const opt = (n) => `<option value="${n.cid}">${esc(n.name)}${n.name !== n.tag ? " (" + esc(n.tag) + ")" : ""}` +
    `${n.player ? " · " + esc(n.player) : ""} — ${n.locations} loc.</option>`;
  const players = data.nations.filter((n) => n.player), rest = data.nations.filter((n) => !n.player);
  sel.innerHTML = (players.length ? `<optgroup label="Players">${players.map(opt).join("")}</optgroup>` : "") +
    `<optgroup label="Everyone else">${rest.map(opt).join("")}</optgroup>`;
  const you = data.nations.find((n) => n.tag === data.you) || players[0] || data.nations[0];
  if (you) sel.value = you.cid;
  $("savename").textContent = `${data.save} · ${data.date} · game data ${data.pack.version}`;
  $("result").hidden = false;
  analyze();
}

function analyze() {
  if (!loaded) return;
  reqId++;
  busy(true, "Working it out…");
  $("buildbar").value = 0;
  worker.postMessage({
    type: "analyze", req: reqId, cid: +$("nation").value, govs: +$("govs").value,
    eligibleOnly: $("eligible").checked, pendingBuilt: $("pending").checked,
  });
}

function onAnalysis(d) {
  current = d;
  busy(false, `${d.name}: every location tested`);
  $("buildbar").value = 1;
  renderTiles(d);
  renderPlans(d);
  renderTables(d);
  drawMap();
  $("result").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------------------------------------------------------------- results
function statusChip(s) { const [cls, text] = STATUS[s] || ["now", s]; return `<span class="chip ${esc(cls)}">${esc(text)}</span>`; }

function renderTiles(d) {
  const best = d.capRank[0], stay = best.loc === d.capital.loc;
  const K = +$("govs").value;
  const tile = (lab, num, det, up) => `<div class="tile"><div class="lab">${lab}</div>` +
    `<div class="num${up ? " up" : ""}">${num}</div><div class="det">${det}</div></div>`;
  $("tiles").innerHTML =
    tile("Settled tax base now", d.now.settled.toFixed(1),
      `avg proximity ${d.now.avg.toFixed(0)} · in the save: ${d.now.taxSaved.toFixed(1)} tax of ${d.now.taxPossible.toFixed(1)} possible`) +
    tile(`${K} more governor${K > 1 ? "s" : ""}`, fmt(d.plan.gain, 1),
      d.plan.picks.length ? d.plan.picks.map((p) => esc(p.name)).join(", ")
        : d.govRank.length && d.govRank[0].gain > 0 ? `no city with a road to the capital yet; best spot once it has one: ` +
          `${esc(d.govRank[0].name)} (${fmt(d.govRank[0].gain, 1)})` : "no location helps", d.plan.gain > 0) +
    tile("Best capital", stay ? "Stay" : fmt(best.gain, 1),
      stay ? `${esc(d.capital.name)} is already the best spot` : `move to ${esc(best.name)}`, !stay && best.gain > 0) +
    tile("Capital + governors", fmt(d.joint.gain, 1),
      `${d.joint.capital.loc === d.capital.loc ? "keep " + esc(d.capital.name) : "move to " + esc(d.joint.capital.name)}` +
      (d.joint.govs.length ? ", governors in " + d.joint.govs.map((p) => esc(p.name)).join(", ") : ""), d.joint.gain > 0);
  const f = d.fit;
  const src = [`capital ${esc(d.capital.name)}`, ...d.active.map((s) => (s.other ? "proximity source " : "governor ") + esc(s.name))];
  $("fitnote").innerHTML = `Sources: ${src.join(", ")}` +
    (d.pending.length ? `; being built: ${d.pending.map((s) => esc(s.name)).join(", ")}` : "") +
    `. <b>Model vs your save:</b> within 5 proximity for ${(f.within5 * 100).toFixed(0)}% of ${esc(d.tag)}'s ` +
    `${d.map.locs.length} locations, average error ${f.mae.toFixed(1)}.` +
    (f.within5 < 0.5 ? " That's rough for this nation (sea and lagoon routes, most likely), so read small gains with care." : "");
  $("pendingrow").hidden = !d.pending.length;
}

function planList(el, items, empty) {
  el.innerHTML = items.length ? items.map((p, i) => {
    const why = p.status && p.status !== "ready" ? `<span class="why">${
      { city: "Upgrade it to a city first.", road: "Needs a road to the capital first.",
        "city+road": "Needs a city upgrade and a road to the capital first." }[p.status] || ""}</span>` : "";
    return `<li><span class="no">${p.no || i + 1}</span><span class="nm">${esc(p.name)}<small>${esc(p.rank || "")}</small>` +
      `${p.status ? statusChip(p.status) : ""}${p.tag ? p.tag : ""}</span><span class="g">${p.g ?? fmt(p.gain)}</span>${why}</li>`;
  }).join("") : `<li><span class="none">${empty}</span></li>`;
}

function renderPlans(d) {
  const K = +$("govs").value;
  $("govsub").textContent = `With the capital in ${d.capital.name}: the ${K > 1 ? K + " best places, picked one after another" : "best place"}` +
    ` for a new governor, and the settled tax base each adds.`;
  planList($("govplan"), d.plan.picks, $("eligible").checked
    ? "No city with a road to the capital would add anything. Untick “Only where one can be built now” to see where to build towards."
    : "No location would add anything.");
  const moved = d.joint.capital.loc !== d.capital.loc;
  $("jointsub").textContent = moved
    ? `Moving the capital and then placing ${K} governor${K > 1 ? "s" : ""}: ${fmt(d.joint.gain, 1)} settled tax base in total, ` +
      `against ${fmt(d.plan.gain, 1)} for governors alone.`
    : `Keeping the capital in ${d.capital.name} and placing governors is already the best of the capitals tried.`;
  const items = [{ ...d.joint.capital, no: "★", g: moved ? "capital" : "stays", tag: moved ? "" : ' <span class="chip now">Current</span>' },
    ...d.joint.govs];
  planList($("jointplan"), items, "");
}

function renderTables(d) {
  $("govtable").innerHTML = "<thead><tr><th>#</th><th>Location</th><th>Rank</th><th>Can build?</th><th class=n>+Tax base</th></tr></thead><tbody>" +
    d.govRank.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td>${esc(r.rank)}</td><td>${statusChip(r.status)}</td>` +
      `<td class="n ${r.gain > 0 ? "pos" : ""}">${fmt(r.gain)}</td></tr>`).join("") + "</tbody>";
  const cur = d.capRank.findIndex((r) => r.loc === d.capital.loc);
  $("capsub").textContent = `Every location tried as the capital, keeping the governors you have. ` +
    (cur === 0 ? `${d.capital.name} is already the best.` : cur > 0 ? `${d.capital.name} ranks ${cur + 1}.` : `${d.capital.name} isn't in the top 15.`);
  $("captable").innerHTML = "<thead><tr><th>#</th><th>Location</th><th>Rank</th><th class=n>Avg prox.</th><th class=n>+Tax base</th></tr></thead><tbody>" +
    d.capRank.map((r, i) => `<tr class="${r.loc === d.capital.loc ? "cur" : ""}"><td>${i + 1}</td><td>${esc(r.name)}` +
      `${r.loc === d.capital.loc ? ' <span class="chip now">Current</span>' : ""}</td><td>${esc(r.rank)}</td>` +
      `<td class=n>${r.avg.toFixed(0)}</td><td class="n ${r.gain > 0.005 ? "pos" : r.gain < -0.005 ? "neg" : ""}">${fmt(r.gain)}</td></tr>`).join("") + "</tbody>";
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
  const m = d.map, xs = m.xy.filter((_, i) => i % 2 === 0), ys = m.xy.filter((_, i) => i % 2 === 1);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pad = Math.max(40, 0.12 * Math.max(x1 - x0, y1 - y0));
  x0 = Math.max(0, Math.floor(x0 - pad)); y0 = Math.max(0, Math.floor(y0 - pad));
  x1 = Math.min(img.width, Math.ceil(x1 + pad)); y1 = Math.min(img.height, Math.ceil(y1 + pad));
  const w = x1 - x0, h = y1 - y0;
  if (!mapCrop || mapCrop.key !== [d.cid, x0, y0, w, h].join()) {
    const oc = new OffscreenCanvas(w, h), ox = oc.getContext("2d", { willReadFrequently: true });
    ox.drawImage(img, x0, y0, w, h, 0, 0, w, h);
    const px = ox.getImageData(0, 0, w, h).data, lid = new Uint16Array(w * h);
    for (let p = 0; p < w * h; p++) lid[p] = (px[p * 4 + 1] << 8) | px[p * 4 + 2];
    mapCrop = { key: [d.cid, x0, y0, w, h].join(), x0, y0, w, h, lid };
  }
  paintMap();
}

function modeValues(d) {
  const m = d.map;
  if (mapMode === "gain") return m.plan.map((v, j) => v - m.base[j]);
  return m[mapMode];
}

function paintMap() {
  const d = current, c = mapCrop;
  if (!d || !c) return;
  const m = d.map, idx = new Map(m.locs.map((l, j) => [l, j]));
  const vals = modeValues(d), gain = mapMode === "gain";
  const maxGain = gain ? Math.max(1, ...vals) : 100;
  const col = gain ? ramp(["--gain-0", "--gain-1", "--gain-2", "--gain-3", "--gain-4", "--gain-5"])
    : ramp(["--seq-0", "--seq-1", "--seq-2", "--seq-3", "--seq-4", "--seq-5", "--seq-6"]);
  const foreign = rgbOf(cssVar("--map-foreign")), sea = rgbOf(cssVar("--map-sea")), zero = rgbOf(cssVar("--map-zero"));
  const kind = loaded.kind;
  const lut = new Map();
  const colorOf = (l) => {
    if (lut.has(l)) return lut.get(l);
    const j = idx.get(l);
    let rgb;
    if (j !== undefined) rgb = gain ? (vals[j] > 0.05 ? col(vals[j] / maxGain) : zero) : col(vals[j] / 100);
    else rgb = kind[l] === 0 || kind[l] === 3 ? foreign : sea;
    lut.set(l, rgb);
    return rgb;
  };
  // draw at an integer upscale so small nations aren't a blur
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
      const edge = (r !== l && (idx.has(r) || idx.has(l))) || (b !== l && (idx.has(b) || idx.has(l)));
      if (edge) rgb = rgb.map((v) => v * 0.7);
      for (let yy = 0; yy < s; yy++) {
        let o = ((y * s + yy) * W + x * s) * 4;
        for (let xx = 0; xx < s; xx++, o += 4) { out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2]; out[o + 3] = 255; }
      }
    }
  }
  ctx.putImageData(id, 0, 0);
  drawMarkers(ctx, s);
  drawLegend(gain, maxGain, col);
}

function drawMarkers(ctx, s) {
  const d = current, c = mapCrop, m = d.map, idx = new Map(m.locs.map((l, j) => [l, j]));
  const at = (l) => { const j = idx.get(l); return [(m.xy[2 * j] - c.x0 + 0.5) * s, (m.xy[2 * j + 1] - c.y0 + 0.5) * s]; };
  const r = Math.max(6, Math.min(12, 5 + s * 1.5));
  const ink = cssVar("--ink"), halo = cssVar("--raised"), accent = cssVar("--accent"), alarm = cssVar("--alarm");
  const shape = (l, kind, fill) => {
    const [x, y] = at(l);
    ctx.save();
    ctx.lineWidth = 2.5; ctx.strokeStyle = halo; ctx.fillStyle = fill;
    ctx.beginPath();
    if (kind === "star" || kind === "ostar") {
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r * 1.1;
        ctx.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
      }
      ctx.closePath();
    } else if (kind === "diamond") {
      ctx.moveTo(x, y - r); ctx.lineTo(x + r * 0.8, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r * 0.8, y); ctx.closePath();
    } else ctx.arc(x, y, r * 0.55, 0, Math.PI * 2);
    ctx.stroke();
    if (kind === "ostar") { ctx.lineWidth = 2; ctx.strokeStyle = fill; ctx.stroke(); } else ctx.fill();
    ctx.restore();
  };
  const joint = mapMode === "joint", moved = d.joint.capital.loc !== d.capital.loc;
  for (const g of [...d.active, ...($("pending").checked ? d.pending : [])]) shape(g.loc, "dot", ink);
  const sugg = mapMode === "plan" || mapMode === "gain" ? d.plan.picks : joint ? d.joint.govs : [];
  for (const p of sugg) shape(p.loc, "diamond", alarm);
  if (joint && moved) { shape(d.capital.loc, "ostar", accent); shape(d.joint.capital.loc, "star", accent); }
  else shape(d.capital.loc, "star", accent);
}

function drawLegend(gain, maxGain, col) {
  const n = 12, cells = Array.from({ length: n }, (_, i) => `<i style="background:rgb(${col(i / (n - 1)).join(",")})"></i>`).join("");
  const ticks = gain ? [0, maxGain / 2, maxGain].map((v) => "+" + v.toFixed(0)) : ["0", "25", "50", "75", "100"];
  const label = { saved: "Proximity recorded in the save", base: "Proximity, model of today",
    plan: "Proximity with the suggested governors", joint: "Proximity with the suggested capital and governors",
    gain: "Proximity gained from the suggested governors" }[mapMode];
  $("legend").innerHTML = `<span>${label}</span><span class="scale"><span class="bar">${cells}</span>` +
    `<span class="ticks">${ticks.map((t) => `<span>${t}</span>`).join("")}</span></span>`;
}

function onHover(e) {
  const d = current, c = mapCrop, cv = $("map"), tip = $("tip");
  if (!d || !c) return;
  const rect = cv.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) / rect.width * c.w), y = Math.floor((e.clientY - rect.top) / rect.height * c.h);
  const l = c.lid[y * c.w + x], j = d.map.locs.indexOf(l);
  if (j < 0) { tip.hidden = true; return; }
  const m = d.map, row = (a, b) => `<div class="row"><span>${a}</span><span>${b}</span></div>`;
  tip.innerHTML = `<b>${esc(m.names[j])}</b>` + row("Rank", esc(m.ranks[j] || "–")) + row("Possible tax", m.ptax[j].toFixed(2)) +
    row("Proximity in save", m.saved[j].toFixed(1)) + row("Model today", m.base[j].toFixed(1)) +
    row("With governors", m.plan[j].toFixed(1)) + row("Capital + governors", m.joint[j].toFixed(1));
  tip.hidden = false;
  const bx = $("mapbox").getBoundingClientRect();
  let tx = e.clientX - bx.left + 14, ty = e.clientY - bx.top + 14;
  if (tx + tip.offsetWidth > bx.width) tx = e.clientX - bx.left - tip.offsetWidth - 14;
  if (ty + tip.offsetHeight > bx.height) ty = Math.max(0, e.clientY - bx.top - tip.offsetHeight - 14);
  tip.style.left = tx + "px"; tip.style.top = ty + "px";
}

// ---------------------------------------------------------------- wiring
const drop = $("drop");
$("saveinput").addEventListener("change", (e) => openSave(e.target.files[0]));
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("saveinput").click(); } });
for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); openSave(e.dataTransfer.files[0]); });
for (const id of ["nation", "govs", "eligible", "pending"]) $(id).addEventListener("change", analyze);
for (const b of $("mapmode").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    mapMode = b.dataset.mode;
    for (const o of $("mapmode").querySelectorAll("button")) o.setAttribute("aria-selected", o === b ? "true" : "false");
    paintMap();
  });
}
$("map").addEventListener("mousemove", onHover);
$("map").addEventListener("mouseleave", () => { $("tip").hidden = true; });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paintMap);

/* EU5 leaderboard - page controller. Picks the save and (optionally) the
   game folder, runs js/worker.js, and turns its data into the report. */
"use strict";

const $ = (id) => document.getElementById(id);

// ==========================================================================
// Report building (mirrors build_html in eu5_leaderboard.py)
// ==========================================================================
const FIELDS = {
  gp_rank: "GP", tag: "Nation", pop: "Population", taxbase: "Tax base",
  econbase: "Econ base", wealth: "Wealth", control: "Control",
  control_wtd: "Control (wtd)", dev: "Development", locations: "Loc.",
  provinces: "Provinces", gold: "Gold", debt: "Debt", income: "Income",
  expense: "Expense", tax_income: "Tax income", trade_balance: "Trade income",
  building_income: "Building income", coin_minting: "Minting",
  trade_value: "Trade value", total_produced: "Goods produced",
  subject_tax_base: "Subject tax base", loan_capacity: "Loan capacity",
  creditworthiness: "Creditworthiness", inflation: "Inflation",
  army: "Army", levies: "Levies", regulars: "Regulars", mercs: "Mercs",
  navy: "Navy", subunits: "Regiments", manpower: "Manpower",
  max_manpower: "Manpower pool", army_tradition: "Army trad.",
  navy_tradition: "Navy trad.", kills: "Killed", war_battle: "Battle dead",
  war_attrition: "Attrition dead", wars: "Wars", rebels: "Rebellions",
  advances: "Advances", prestige: "Prestige", stability: "Stability",
  govpower: "Gov. power", gp_points: "GP points", score_place: "World rank",
  _sp: "Pop trend",
};
const DEFAULT_CONFIG = {
  standings: ["gp_rank", "tag", "pop", "taxbase", "econbase", "wealth",
    "control", "locations", "levies", "regulars", "mercs"],
  ledger: ["tag", "kills", "war_battle", "war_attrition", "wars", "rebels",
    "army_tradition"],
};
const NUMWORD = {
  1: "One", 2: "Two", 3: "Three", 4: "Four", 5: "Five", 6: "Six",
  7: "Seven", 8: "Eight", 9: "Nine", 10: "Ten", 11: "Eleven",
  12: "Twelve", 13: "Thirteen", 14: "Fourteen", 15: "Fifteen", 16: "Sixteen",
};

// U+2028/U+2029 are valid in JSON but end a line inside a <script>.
const LINE_SEPS = new RegExp("[" + String.fromCharCode(0x2028, 0x2029) + "]", "g");

let templatePromise = null;
const loadTemplate = () => (templatePromise ||= fetch("report-template.html").then((r) => {
  if (!r.ok) throw new Error("couldn't load the report template (" + r.status + ")");
  return r.text();
}));

function buildHtml(tpl, data) {
  const year = String(data.world.date).split(".")[0];
  const n = data.rows.length;
  const title = (NUMWORD[n] || String(n)) + " Crowns of " + year;
  const payload = JSON.stringify({ ...data, config: DEFAULT_CONFIG, fields: FIELDS })
    .replace(/</g, "\\u003c").replace(LINE_SEPS, (c) => "\\u" + c.charCodeAt(0).toString(16));
  const body = tpl.split("__TITLE__").join(title)
    .split("__YEAR__").join(year)
    .split("__DATA__").join(payload);
  const split = body.indexOf('<div class="wrap">');
  return '<!doctype html>\n<html lang="en">\n<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    "<style>html{color-scheme:light dark}img{max-width:100%}</style>\n" +
    body.slice(0, split) +
    "</head>\n<body>\n" +
    body.slice(split) +
    "\n</body>\n</html>\n";
}

/* Coerce everything to the types the report expects. Save-derived data
   already has them; a JSON file dropped on the page might not. */
function sanitizeData(d) {
  if (!d || typeof d !== "object" || !Array.isArray(d.rows) || !d.world || typeof d.world !== "object")
    throw new Error("That JSON file isn't leaderboard data.");
  const numOr0 = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
  const str = (v) => (v == null ? "" : String(v));
  const numMap = (o) => {
    const out = {};
    if (o && typeof o === "object" && !Array.isArray(o))
      for (const [k, v] of Object.entries(o)) out[k] = numOr0(v);
    return out;
  };
  const numList = (a) => (Array.isArray(a) ? a.map(numOr0) : []);
  const isPng = (v) => typeof v === "string" && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(v);
  const STR = new Set(["id", "tag", "name", "player"]);
  const rows = d.rows.filter((r) => r && typeof r === "object").map((r) => {
    const o = {};
    for (const [k, v] of Object.entries(r)) {
      if (STR.has(k)) o[k] = str(v);
      else if (k === "is_player") o[k] = v === true;
      else if (k === "flag") { if (isPng(v)) o[k] = v; }
      else if (["goods", "raw", "ranks", "score"].includes(k)) o[k] = numMap(v);
      else if (k.endsWith("_hist")) o[k] = numList(v);
      else o[k] = numOr0(v);
    }
    for (const k of STR) if (!(k in o)) o[k] = "";
    for (const k of ["goods", "raw", "ranks", "score"]) o[k] ||= {};
    for (const k of ["pop_hist", "tax_hist", "econ_hist"]) o[k] ||= [];
    if (!o.pop_hist.length) o.pop_hist = [o.pop || 0];
    for (const k of ["locations", "provinces", "gp_rank", "subunits", "advances", "wars", "rebels", "score_place"])
      o[k] = Math.trunc(numOr0(o[k] ?? (k === "gp_rank" ? 999 : 0)));
    return o;
  });
  const w = d.world;
  const date = /^[\d.?]+$/.test(str(w.date)) ? str(w.date) : "?";
  const world = {
    n_countries: numOr0(w.n_countries), world_pop: numOr0(w.world_pop),
    world_locations: numOr0(w.world_locations), date, version: str(w.version),
    multiplayer: w.multiplayer === true, you: w.you == null ? null : str(w.you),
    n_players: numOr0(w.n_players), wars_live: numOr0(w.wars_live), save: str(w.save),
  };
  let map;
  if (d.map && typeof d.map === "object" && isPng(d.map.image)) {
    const hexc = (v) => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : "#888888");
    map = {
      image: d.map.image,
      legend: (Array.isArray(d.map.legend) ? d.map.legend : []).map((m) => ({
        tag: str(m.tag), name: str(m.name), player: m.player == null ? null : str(m.player),
        is_player: m.is_player === true, color: hexc(m.color), locations: numOr0(m.locations),
      })),
      has_subjects: d.map.has_subjects === true, bg: hexc(d.map.bg), land: hexc(d.map.land),
    };
  }
  return map ? { rows, world, map } : { rows, world };
}

// ==========================================================================
// Game folder linking
// ==========================================================================
// Chrome refuses to let a page pick folders under Program Files, where
// Steam installs by default, so the game folder can also be dragged in
// (or reached through a junction, see the page). Either way only the few
// files we need are read, locally, when a report is built.
const NEEDED = ["main_menu/common/named_colors/", "main_menu/common/coat_of_arms/coat_of_arms/",
  "main_menu/gfx/coat_of_arms/", "in_game/map_data/", "in_game/setup/countries/"];
let game = null; // {files: Map(relative path -> File), label}

function setGameStatus(text, ok) {
  const s = $("gamestatus");
  s.textContent = text;
  s.classList.toggle("ok", !!ok);
  $("gameforget").hidden = !ok;
  $("gamebtn").textContent = ok ? "Change folder" : "Choose game folder";
}

/* Accepts the install folder, its `game` folder, or anything in between -
   paths are anchored on the main_menu/in_game layout. */
function linkFileList(list) {
  let prefix = null;
  for (const f of list) {
    const p = f.webkitRelativePath || "";
    const at = p.indexOf("main_menu/common/coat_of_arms/");
    if (at >= 0) { prefix = p.slice(0, at); break; }
  }
  if (prefix === null) {
    setGameStatus("That folder doesn't contain the game's files — pick Europa Universalis V, or the game folder inside it.");
    return;
  }
  const files = new Map();
  for (const f of list) {
    const p = f.webkitRelativePath;
    if (!p.startsWith(prefix)) continue;
    const rel = p.slice(prefix.length);
    if (NEEDED.some((n) => rel.startsWith(n))) files.set(rel, f);
  }
  const label = prefix.split("/")[0];
  game = { files, label };
  setGameStatus(`Linked: ${label}`, true);
  maybeRebuild();
}

/* A folder dragged in from Explorer. The drop hands over a lazy directory
   entry, so only the handful of subfolders we need are ever opened. */
const entryCall = (fn) => new Promise((res, rej) => fn(res, rej));
const subdir = (dir, path) => entryCall((ok, no) => dir.getDirectory(path, {}, ok, no)).catch(() => null);

async function listTree(dir, rel, out, onCount) {
  const reader = dir.createReader();
  for (;;) {
    const batch = await entryCall((ok, no) => reader.readEntries(ok, no));
    if (!batch.length) break;
    for (const e of batch) {
      if (e.isDirectory) await listTree(e, rel + e.name + "/", out, onCount);
      else out.push([rel + e.name, e]);
    }
    onCount(out.length);
  }
}

async function linkDroppedFolder(entry) {
  setGameStatus(`Reading ${entry.name}…`);
  try {
    let root = entry;
    if (!(await subdir(root, "main_menu"))) root = await subdir(entry, "game");
    if (!root || !(await subdir(root, "main_menu/common/coat_of_arms"))) {
      setGameStatus(`“${entry.name}” doesn't contain the game's files — drop Europa Universalis V, or the game folder inside it.`);
      return;
    }
    // List first (count unknown, so the bar is indeterminate), then open
    // each file entry with a real count to show against.
    const bar = $("gamebar");
    setBar(bar, null);
    const entries = [];
    for (const n of NEEDED) {
      const d = await subdir(root, n.replace(/\/$/, ""));
      if (d) await listTree(d, n, entries, (k) => setGameStatus(`Finding game files… ${k.toLocaleString()}`));
    }
    const files = new Map();
    let i = 0;
    for (const [rel, e] of entries) {
      files.set(rel, await entryCall((ok, no) => e.file(ok, no)));
      if (++i % 50 === 0 || i === entries.length) {
        setBar(bar, i / entries.length);
        setGameStatus(`Reading game files… ${i.toLocaleString()} of ${entries.length.toLocaleString()}`);
      }
    }
    bar.hidden = true;
    game = { files, label: entry.name };
    setGameStatus(`Linked: ${entry.name}`, true);
    maybeRebuild();
  } catch (err) {
    $("gamebar").hidden = true;
    setGameStatus(`Couldn't read “${entry.name}”: ${err.message || err.name}. Try the folder link below.`);
  }
}

function onDrop(e) {
  e.preventDefault();
  document.querySelectorAll(".over").forEach((el) => el.classList.remove("over"));
  const dt = e.dataTransfer;
  if (!dt) return;
  const item = dt.items && dt.items[0];
  const entry = item && item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
  if (entry && entry.isDirectory) linkDroppedFolder(entry);
  else if (dt.files.length) handleFile(dt.files[0]);
}

function forgetGame() {
  game = null;
  setGameStatus("Not linked");
}
// ==========================================================================
// Running a build
// ==========================================================================
let worker = null, timer = null, current = null, lastSave = null;

/* value in 0..1, or null for an indeterminate bar */
function setBar(bar, value) {
  bar.hidden = false;
  if (value == null) bar.removeAttribute("value");
  else bar.value = Math.max(0, Math.min(1, value));
}

function showStatus(text, state) {
  $("status").hidden = false;
  $("stagetext").textContent = text;
  const sp = $("spinner");
  sp.classList.toggle("stop", state === "done");
  sp.classList.toggle("fail", state === "error");
}
function logLine(msg) {
  const el = $("log");
  el.textContent += msg + "\n";
  el.scrollTop = el.scrollHeight;
}
function startTimer() {
  const t0 = performance.now();
  clearInterval(timer);
  const tick = () => { $("elapsed").textContent = ((performance.now() - t0) / 1000).toFixed(0) + "s"; };
  tick();
  timer = setInterval(tick, 500);
}

function options() {
  return {
    flags: $("optflags").checked,
    map: $("optmap").checked,
    top: Math.max(0, Math.min(50, parseInt($("opttop").value, 10) || 0)),
  };
}

function build(save) {
  lastSave = save;
  if (worker) worker.terminate();
  $("log").textContent = "";
  $("errorbox").hidden = true;
  showStatus("Starting…");
  setBar($("buildbar"), 0);
  startTimer();
  const opts = options();
  worker = new Worker("js/worker.js");
  worker.onmessage = async (e) => {
    const m = e.data;
    if (m.type === "log") logLine(m.msg);
    else if (m.type === "stage") $("stagetext").textContent = m.msg;
    else if (m.type === "progress") setBar($("buildbar"), m.value);
    else if (m.type === "done") {
      clearInterval(timer);
      worker.terminate();
      worker = null;
      const notes = [];
      if (!game && (opts.flags || opts.map))
        notes.push("Link your EU5 install (step 2) to add coats of arms and the political map.");
      else if (opts.map && !m.data.map)
        notes.push("The map couldn't be drawn — open Details above for the reason.");
      try {
        await showReport(m.data, save.name, notes);
        showStatus(`Built from ${save.name}`, "done");
      } catch (err) {
        fail(err.message);
      }
    } else if (m.type === "error") {
      clearInterval(timer);
      worker.terminate();
      worker = null;
      fail(m.message, m.code);
    }
  };
  worker.onerror = (e) => {
    clearInterval(timer);
    fail("The background worker crashed: " + (e.message || "unknown error") +
      (/memory/i.test(e.message || "") ? " — try closing other tabs." : ""));
  };
  worker.postMessage({ save, game, opts });
}

function fail(msg, code) {
  showStatus("Couldn't build the report", "error");
  const box = $("errorbox");
  box.hidden = false;
  box.textContent = msg;
  if (code === "packed") {
    const a = document.createElement("a");
    a.href = "#readable";
    a.textContent = " How to make a readable save →";
    box.appendChild(a);
  }
}

function maybeRebuild() {
  $("rebuild").hidden = !(lastSave && current);
}

async function loadJson(file) {
  lastSave = null;
  $("log").textContent = "";
  $("errorbox").hidden = true;
  showStatus("Reading " + file.name + "…");
  $("buildbar").hidden = true;
  $("elapsed").textContent = "";
  try {
    const data = JSON.parse(await file.text());
    await showReport(data, file.name, []);
    showStatus(`Built from ${file.name}`, "done");
  } catch (err) {
    fail(err instanceof SyntaxError ? "That file isn't valid JSON." : err.message);
  }
}

function handleFile(file) {
  if (!file) return;
  if (/\.json$/i.test(file.name)) loadJson(file);
  else build(file);
}

// ==========================================================================
// Showing and saving the report
// ==========================================================================
async function showReport(raw, sourceName, notes) {
  const data = sanitizeData(raw);
  const html = buildHtml(await loadTemplate(), data);
  const base = (data.world.save || sourceName).replace(/\.(eu5|json)$/i, "")
    .replace(/ standings$/i, "").replace(/[\\/:*?"<>|]+/g, "_");
  current = { data, html, base };
  $("result").hidden = false;
  $("savename").textContent = sourceName;
  const notice = $("notice");
  notice.hidden = !notes.length;
  notice.textContent = notes.join(" ");
  maybeRebuild();

  const frame = $("report");
  frame.onload = () => {
    const doc = frame.contentDocument;
    if (!doc) return;
    const fit = () => { frame.style.height = doc.documentElement.scrollHeight + "px"; };
    fit();
    try {
      new ResizeObserver(fit).observe(doc.body);
    } catch (e) { /* fixed height is fine */ }
    doc.addEventListener("toggle", fit, true);
  };
  frame.srcdoc = html;
  $("result").scrollIntoView({ behavior: "smooth", block: "start" });
}

function download(name, type, content) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// ==========================================================================
// Wiring
// ==========================================================================
function init() {
  const drop = $("drop"), input = $("saveinput");
  drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
  });
  input.addEventListener("change", () => { handleFile(input.files[0]); input.value = ""; });
  for (const zone of [drop, $("step-game")]) {
    ["dragenter", "dragover"].forEach((t) => zone.addEventListener(t, () => zone.classList.add("over")));
    zone.addEventListener("dragleave", (e) => {
      if (!zone.contains(e.relatedTarget)) zone.classList.remove("over");
    });
  }
  // Drops anywhere on the page: folders link the game, files are saves.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", onDrop);
  $("junccopy").addEventListener("click", () => {
    const btn = $("junccopy");
    navigator.clipboard.writeText($("junccmd").textContent).then(
      () => { btn.textContent = "Copied"; setTimeout(() => { btn.textContent = "Copy"; }, 2000); },
      () => { btn.textContent = "Select and copy it"; });
  });

  $("gamebtn").addEventListener("click", () => $("gameinput").click());
  $("gameforget").addEventListener("click", forgetGame);
  $("gameinput").addEventListener("change", (e) => {
    if (e.target.files.length) linkFileList(e.target.files);
    e.target.value = "";
  });

  $("rebuild").addEventListener("click", () => lastSave && build(lastSave));
  $("dlhtml").addEventListener("click", () => current &&
    download(current.base + " standings.html", "text/html", current.html));
  $("dljson").addEventListener("click", () => current &&
    download(current.base + " data.json", "application/json", JSON.stringify(current.data, null, 1)));
  $("opentab").addEventListener("click", () => {
    if (!current) return;
    const url = URL.createObjectURL(new Blob([current.html], { type: "text/html" }));
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });

  loadTemplate().catch(() => {});
}

init();

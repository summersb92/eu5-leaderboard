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
  advances: "Advances", advances_gained: "Adv. gained", prestige: "Prestige", stability: "Stability",
  govpower: "Gov. power", gp_points: "GP points", score_place: "World rank",
  _sp: "Pop trend",
};
const DEFAULT_CONFIG = {
  standings: ["gp_rank", "tag", "pop", "taxbase", "econbase", "wealth",
    "control", "locations", "levies", "regulars", "mercs"],
  ledger: ["tag", "kills", "war_battle", "war_attrition", "wars", "rebels",
    "army_tradition"],
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
  const title = "EU5 standings · " + data.world.date;
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
      else if (k === "color") o[k] = typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null;
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
// Pages never learn real file paths, so what can be remembered is a folder
// *handle* from Chrome/Edge's directory picker, kept in IndexedDB. That
// picker refuses anything under Program Files (Steam's default), so the
// folder can also be dragged in - which works there but can't be
// remembered - or reached through a junction outside Program Files, which
// can. Either way only the few files we need are read, locally.
const NEEDED = ["main_menu/common/named_colors/", "main_menu/common/coat_of_arms/coat_of_arms/",
  "main_menu/gfx/coat_of_arms/", "in_game/map_data/", "in_game/setup/countries/",
  "in_game/common/advances/"];
const canPickDir = typeof window.showDirectoryPicker === "function";
let game = null; // {files: Map(relative path -> File), label}
let savedHandle = null; // remembered folder still waiting for permission

const idb = {
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("eu5-leaderboard", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction("kv", mode);
      const req = fn(tx.objectStore("kv"));
      tx.oncomplete = () => res(req.result);
      tx.onerror = () => rej(tx.error);
    });
  },
  get(k) { return this.run("readonly", (s) => s.get(k)).catch(() => undefined); },
  set(k, v) { return this.run("readwrite", (s) => s.put(v, k)).catch(() => {}); },
  del(k) { return this.run("readwrite", (s) => s.delete(k)).catch(() => {}); },
};

function setGameStatus(text, ok, button) {
  const s = $("gamestatus");
  s.textContent = text;
  s.classList.toggle("ok", !!ok);
  $("gameforget").hidden = !(ok || savedHandle);
  $("gamebtn").textContent = button || (ok ? "Change folder" : "Choose game folder");
}

/* Folder <input> fallback (browsers without the directory picker). Accepts
   the install folder or its `game` folder - paths are anchored on the
   main_menu/in_game layout. */
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

/* One shape over the two folder APIs: a dropped FileSystemDirectoryEntry,
   or a FileSystemDirectoryHandle from the picker / IndexedDB. */
const entryCall = (fn) => new Promise((res, rej) => fn(res, rej));
const folderApi = {
  entry: {
    async sub(dir, path) {
      return entryCall((ok, no) => dir.getDirectory(path, {}, ok, no)).catch(() => null);
    },
    async list(dir) {
      const reader = dir.createReader(), out = [];
      for (;;) {
        const batch = await entryCall((ok, no) => reader.readEntries(ok, no));
        if (!batch.length) return out;
        for (const e of batch) out.push({ name: e.name, dir: e.isDirectory, obj: e });
      }
    },
    file: (e) => entryCall((ok, no) => e.file(ok, no)),
  },
  handle: {
    async sub(dir, path) {
      try {
        for (const part of path.split("/")) dir = await dir.getDirectoryHandle(part);
        return dir;
      } catch (e) {
        return null;
      }
    },
    async list(dir) {
      const out = [];
      for await (const [name, h] of dir.entries()) out.push({ name, dir: h.kind === "directory", obj: h });
      return out;
    },
    file: (h) => h.getFile(),
  },
};

async function listTree(api, dir, rel, out, onCount) {
  for (const e of await api.list(dir)) {
    if (e.dir) await listTree(api, e.obj, rel + e.name + "/", out, onCount);
    else out.push([rel + e.name, e.obj]);
  }
  onCount(out.length);
}

/* Returns true when linked. */
async function linkFolder(api, top, name) {
  setGameStatus(`Reading ${name}…`);
  const bar = $("gamebar");
  try {
    let root = top;
    if (!(await api.sub(root, "main_menu"))) root = await api.sub(top, "game");
    if (!root || !(await api.sub(root, "main_menu/common/coat_of_arms"))) {
      setGameStatus(`“${name}” doesn't contain the game's files — use Europa Universalis V, or the game folder inside it.`);
      return false;
    }
    // List first (count unknown, so the bar is indeterminate), then open
    // each file with a real count to show against.
    setBar(bar, null);
    const entries = [];
    for (const n of NEEDED) {
      const d = await api.sub(root, n.replace(/\/$/, ""));
      if (d) await listTree(api, d, n, entries, (k) => setGameStatus(`Finding game files… ${k.toLocaleString()}`));
    }
    const files = new Map();
    let i = 0;
    for (const [rel, obj] of entries) {
      files.set(rel, await api.file(obj));
      if (++i % 50 === 0 || i === entries.length) {
        setBar(bar, i / entries.length);
        setGameStatus(`Reading game files… ${i.toLocaleString()} of ${entries.length.toLocaleString()}`);
      }
    }
    bar.hidden = true;
    game = { files, label: name };
    return true;
  } catch (err) {
    bar.hidden = true;
    setGameStatus(`Couldn't read “${name}”: ${err.message || err.name}. Try the folder link below.`);
    return false;
  }
}

async function linkDroppedFolder(entry) {
  if (await linkFolder(folderApi.entry, entry, entry.name)) {
    setGameStatus(`Linked: ${entry.name} (for this visit — dragged folders can't be remembered)`, true);
    maybeRebuild();
  }
}

async function linkHandle(h) {
  if (await linkFolder(folderApi.handle, h, h.name)) {
    await idb.set("gameDir", h);
    savedHandle = null;
    setGameStatus(`Linked: ${h.name} (remembered)`, true);
    maybeRebuild();
  }
}

async function pickGame() {
  if (savedHandle) {
    const h = savedHandle;
    const perm = await h.requestPermission({ mode: "read" }).catch(() => "denied");
    if (perm === "granted") return linkHandle(h);
    setGameStatus(`Chrome didn't allow access to ${h.name} — choose the folder again.`, false);
    savedHandle = null;
    return;
  }
  if (!canPickDir) {
    $("gameinput").click();
    return;
  }
  let h;
  try {
    h = await window.showDirectoryPicker({ id: "eu5-install", mode: "read" });
  } catch (e) {
    // A folder Chrome blocks (Program Files) comes back as a plain cancel.
    if (!game) setGameStatus("Nothing linked. If Chrome said the folder contains system files, drag it onto this box instead.");
    return;
  }
  await linkHandle(h);
}

/* A folder remembered from an earlier visit: link it straight away if
   Chrome still grants access, otherwise wait for a click to ask again. */
async function restoreGame() {
  if (!canPickDir) return;
  const h = await idb.get("gameDir");
  if (!h || typeof h.queryPermission !== "function") return;
  const perm = await h.queryPermission({ mode: "read" }).catch(() => "denied");
  if (perm === "granted") return linkHandle(h);
  savedHandle = h;
  setGameStatus(`Remembered: ${h.name}`, false, "Reconnect");
}

function onDrop(e) {
  e.preventDefault();
  document.querySelectorAll(".over").forEach((el) => el.classList.remove("over"));
  const dt = e.dataTransfer;
  if (!dt) return;
  const item = dt.items && dt.items[0];
  const entry = item && item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
  if (entry && entry.isDirectory) return linkDroppedFolder(entry);
  const file = dt.files[0];
  if (!file) return;
  // Must be requested during the drop event itself; lets the save be
  // remembered in the recent list (Chrome/Edge).
  const pending = canPickFile && item && item.getAsFileSystemHandle ? item.getAsFileSystemHandle() : null;
  Promise.resolve(pending).catch(() => null)
    .then((h) => (h ? rememberSave(h, file) : null)).catch(() => null)
    .then((rec) => handleFile(file, rec));
}

async function forgetGame() {
  game = null;
  savedHandle = null;
  await idb.del("gameDir");
  setGameStatus("Not linked");
}

// ==========================================================================
// Recent saves
// ==========================================================================
// Pages can't keep file paths, but Chrome/Edge can keep file handles in
// IndexedDB and reopen the same file on a later visit after a permission
// prompt. Other browsers simply don't show the list.
const canPickFile = typeof window.showOpenFilePicker === "function";
const RECENT_MAX = 8;
let recent = []; // [{handle, name, size, modified, used, date}]

const fmtSize = (b) => (b >= 1e6 ? Math.round(b / 1e6) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB");
const fmtWhen = (t) => new Date(t).toLocaleString(undefined,
  { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

async function loadRecent() {
  if (!canPickFile) return;
  const saved = await idb.get("recentSaves");
  recent = Array.isArray(saved) ? saved.filter((r) => r && r.handle) : [];
  renderRecent();
}

const storeRecent = () => idb.set("recentSaves", recent);

/* Put a just-opened file at the top of the list; returns its entry. */
async function rememberSave(handle, file) {
  if (!canPickFile || !handle || handle.kind !== "file") return null;
  let entry = null;
  for (const r of recent) {
    if (await r.handle.isSameEntry(handle).catch(() => false)) entry = r;
  }
  if (entry) {
    // same file again: keep its in-game date unless it has been re-saved
    if (entry.modified !== file.lastModified) entry.date = null;
    Object.assign(entry, { handle, name: file.name, size: file.size, modified: file.lastModified, used: Date.now(), missing: false });
  } else {
    entry = { handle, name: file.name, size: file.size, modified: file.lastModified, used: Date.now(), date: null };
  }
  recent = [entry, ...recent.filter((r) => r !== entry)].slice(0, RECENT_MAX);
  await storeRecent();
  renderRecent();
  return entry;
}

/* After a successful build: note the in-game date shown in the list. */
function noteRecent(entry, world) {
  if (!entry || !recent.includes(entry)) return;
  entry.date = world && world.date ? String(world.date) : null;
  storeRecent();
  renderRecent();
}

async function openRecent(entry) {
  const h = entry.handle;
  let perm = await h.queryPermission({ mode: "read" }).catch(() => "denied");
  if (perm !== "granted") perm = await h.requestPermission({ mode: "read" }).catch(() => "denied");
  if (perm !== "granted") {
    fail(`The browser didn't allow access to ${entry.name}.`);
    return;
  }
  let file;
  try {
    file = await h.getFile();
  } catch (e) {
    fail(`${entry.name} isn't there any more — it may have been moved, renamed or deleted.`);
    entry.missing = true;
    renderRecent();
    return;
  }
  handleFile(file, await rememberSave(h, file));
}

async function forgetRecent(entry) {
  recent = entry ? recent.filter((r) => r !== entry) : [];
  await storeRecent();
  renderRecent();
}

function renderRecent() {
  const box = $("recent"), list = $("recentlist");
  box.hidden = !recent.length;
  list.textContent = "";
  for (const r of recent) {
    const li = document.createElement("li");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "recentopen" + (r.missing ? " missing" : "");
    const name = document.createElement("span");
    name.className = "recentname";
    name.textContent = r.name;
    const meta = document.createElement("span");
    meta.className = "recentmeta";
    meta.textContent = [r.missing ? "not found" : null, r.date, fmtSize(r.size), "saved " + fmtWhen(r.modified)]
      .filter(Boolean).join(" · ");
    open.append(name, meta);
    open.title = "Build the report from " + r.name;
    open.addEventListener("click", () => openRecent(r));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "recentdel";
    del.textContent = "×";
    del.setAttribute("aria-label", "Remove " + r.name + " from recent saves");
    del.addEventListener("click", () => forgetRecent(r));
    li.append(open, del);
    list.appendChild(li);
  }
}

async function pickSave() {
  if (!canPickFile) {
    $("saveinput").click();
    return;
  }
  let handle;
  try {
    [handle] = await window.showOpenFilePicker({
      id: "eu5-saves",
      types: [{
        description: "EU5 saves or leaderboard data",
        accept: { "application/octet-stream": [".eu5"], "application/json": [".json"] },
      }],
    });
  } catch (e) {
    return; // cancelled
  }
  const file = await handle.getFile();
  handleFile(file, await rememberSave(handle, file));
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

function build(save, entry) {
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
        noteRecent(entry, m.data.world);
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

async function loadJson(file, entry) {
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
    noteRecent(entry, data.world);
  } catch (err) {
    fail(err instanceof SyntaxError ? "That file isn't valid JSON." : err.message);
  }
}

function handleFile(file, entry) {
  if (!file) return;
  if (/\.json$/i.test(file.name)) loadJson(file, entry);
  else build(file, entry);
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
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickSave(); }
  });
  drop.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    e.preventDefault();
    pickSave();
  });
  $("recentclear").addEventListener("click", () => forgetRecent(null));
  loadRecent();
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

  $("gamebtn").addEventListener("click", pickGame);
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

  restoreGame();
  loadTemplate().catch(() => {});
}

init();

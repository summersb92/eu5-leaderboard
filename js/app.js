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
  const cleanRow = (r) => {
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
  };
  const cleanRows = (list) => (Array.isArray(list) ? list : []).filter((r) => r && typeof r === "object").map(cleanRow);
  const okDate = (v) => (/^[\d.?]+$/.test(str(v)) ? str(v) : "?");
  const rows = cleanRows(d.rows);
  const w = d.world;
  const date = /^[\d.?]+$/.test(str(w.date)) ? str(w.date) : "?";
  const world = {
    n_countries: numOr0(w.n_countries), world_pop: numOr0(w.world_pop),
    world_locations: numOr0(w.world_locations), date, version: str(w.version),
    multiplayer: w.multiplayer === true, you: w.you == null ? null : str(w.you),
    n_players: numOr0(w.n_players), wars_live: numOr0(w.wars_live), save: str(w.save),
    playthrough: w.playthrough == null ? null : str(w.playthrough),
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
  const out = map ? { rows, world, map } : { rows, world };
  // Earlier saves of the same campaign, for the "Over time" section.
  const tl = d.timeline && Array.isArray(d.timeline.snapshots) ? d.timeline.snapshots : [];
  const snaps = tl.filter((s) => s && typeof s === "object").map((s) => ({
    date: okDate(s.date), save: str(s.save), playthrough: s.playthrough == null ? null : str(s.playthrough),
    rows: cleanRows(s.rows).map((r) => {
      for (const k of ["goods", "raw", "ranks", "score", "flag"]) delete r[k];
      return r;
    }),
  })).filter((s) => s.date !== "?");
  if (snaps.length) out.timeline = { snapshots: snaps };
  return out;
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
  // File handles must be requested during the drop event itself; they let
  // the saves be remembered in the recent list (Chrome/Edge).
  const items = [...(dt.items || [])].filter((it) => it.kind === "file");
  const pending = items.map((it) => (canPickFile && it.getAsFileSystemHandle ? it.getAsFileSystemHandle() : null));
  const files = [...dt.files];
  if (!files.length) return;
  Promise.all(files.map((file, i) => Promise.resolve(pending[i]).catch(() => null)
    .then((h) => (h ? rememberSave(h, file) : null)).catch(() => null)
    .then((entry) => ({ file, entry }))))
    .then(handleFiles);
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

/* Reopen remembered saves (asking permission where needed), then build or
   add them. Several at once become a timeline. */
async function openEntries(entries, add) {
  const files = [];
  for (const entry of entries) {
    const h = entry.handle;
    let perm = await h.queryPermission({ mode: "read" }).catch(() => "denied");
    if (perm !== "granted") perm = await h.requestPermission({ mode: "read" }).catch(() => "denied");
    if (perm !== "granted") {
      fail(`The browser didn't allow access to ${entry.name}` +
        (entries.length > 1 ? " — click again to be asked for each file." : "."));
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
    files.push({ file, entry: await rememberSave(h, file) });
  }
  picked.clear();
  renderRecent();
  (add ? addToCurrent : handleFiles)(files);
}
const openRecent = (entry) => openEntries([entry], false);

async function forgetRecent(entry) {
  recent = entry ? recent.filter((r) => r !== entry) : [];
  picked.clear();
  await storeRecent();
  renderRecent();
}

const picked = new Set(); // recent entries ticked for comparing

function renderRecent() {
  const box = $("recent"), list = $("recentlist");
  box.hidden = !recent.length;
  list.textContent = "";
  for (const r of recent) {
    const li = document.createElement("li");
    const tick = document.createElement("input");
    tick.type = "checkbox";
    tick.className = "recenttick";
    tick.checked = picked.has(r);
    tick.setAttribute("aria-label", "Compare " + r.name);
    tick.addEventListener("change", () => {
      tick.checked ? picked.add(r) : picked.delete(r);
      updateCompare();
    });
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
    li.append(tick, open, del);
    list.appendChild(li);
  }
  updateCompare();
}

function updateCompare() {
  for (const r of picked) if (!recent.includes(r)) picked.delete(r);
  const btn = $("recentcompare");
  btn.hidden = recent.length < 2;
  btn.disabled = picked.size < 2;
  btn.textContent = picked.size >= 2 ? `Compare ${picked.size} saves` : "Tick two or more to compare";
}

let addMode = false; // the plain <input> fallback serves both buttons
async function pickSave(add) {
  if (!canPickFile) {
    addMode = !!add;
    $("saveinput").click();
    return;
  }
  let handles;
  try {
    handles = await window.showOpenFilePicker({
      id: "eu5-saves",
      multiple: true,
      types: [{
        description: "EU5 saves or leaderboard data",
        accept: { "application/octet-stream": [".eu5"], "application/json": [".json"] },
      }],
    });
  } catch (e) {
    return; // cancelled
  }
  const files = [];
  for (const h of handles) {
    const file = await h.getFile();
    files.push({ file, entry: await rememberSave(h, file) });
  }
  (add ? addToCurrent : handleFiles)(files);
}

// ==========================================================================
// Running builds
// ==========================================================================
// A report is built from one or more saves (or data files) of the same
// campaign. The newest becomes the full report, with flags and map; the
// others are read without them and kept as compact snapshots for the
// "Over time" section.
let timer = null, current = null, lastItems = null;

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

class BuildError extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
}

/* One worker run. onStage(text) and onProgress(0..1) report as it goes. */
let activeWorkers = new Set();
function runWorker(save, opts, onStage, onProgress) {
  return new Promise((resolve, reject) => {
    const w = new Worker("js/worker.js");
    activeWorkers.add(w);
    const end = () => { w.terminate(); activeWorkers.delete(w); };
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === "log") logLine(m.msg);
      else if (m.type === "stage") onStage && onStage(m.msg);
      else if (m.type === "progress") onProgress && onProgress(m.value);
      else if (m.type === "done") { end(); resolve(m.data); }
      else if (m.type === "error") { end(); reject(new BuildError(save.name + ": " + m.message, m.code)); }
    };
    w.onerror = (e) => {
      end();
      reject(new BuildError("The background worker crashed: " + (e.message || "unknown error") +
        (/memory/i.test(e.message || "") ? " — try closing other tabs." : "")));
    };
    w.postMessage({ save, game, opts });
  });
}

// "1368.1.21" -> comparable number
const dateKey = (d) => {
  const p = String(d || "").split(".").map((x) => parseInt(x, 10) || 0);
  return (p[0] || 0) * 10000 + (p[1] || 0) * 100 + (p[2] || 0);
};

/* Everything the timeline needs from a row: no flags, goods or ranks. */
function compactRow(r) {
  const o = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === "flag" || k === "goods" || k === "raw" || k === "ranks" || k === "score") continue;
    o[k] = v;
  }
  return o;
}
const toSnap = (data) => ({
  date: data.world.date, save: data.world.save, playthrough: data.world.playthrough || null,
  rows: data.rows.map(compactRow),
});

/* items: [{file, entry}] for saves and data files, or {snap} / {full} for
   what an earlier report already holds. */
async function buildMany(items) {
  lastItems = items;
  for (const w of activeWorkers) w.terminate();
  activeWorkers.clear();
  $("log").textContent = "";
  $("errorbox").hidden = true;
  showStatus("Starting…");
  setBar($("buildbar"), 0);
  startTimer();
  const opts = options();
  try {
    // 1. Read data files, and the date of every save, so they can be ordered.
    const cands = [];
    const saves = items.filter((it) => it.file && !/\.json$/i.test(it.file.name));
    for (const it of items) {
      if (it.snap) cands.push({ date: it.snap.date, snap: it.snap });
      else if (it.full) cands.push({ date: it.full.world.date, full: it.full });
      else if (/\.json$/i.test(it.file.name)) {
        let raw;
        try {
          raw = JSON.parse(await it.file.text());
        } catch (e) {
          throw new BuildError(it.file.name + " isn't valid JSON.");
        }
        const full = sanitizeData(raw);
        cands.push({ date: full.world.date, full, entry: it.entry });
        for (const s of (full.timeline && full.timeline.snapshots) || [])
          if (s.date !== full.world.date) cands.push({ date: s.date, snap: s });
      }
    }
    if (saves.length > 1) $("stagetext").textContent = `Putting ${saves.length} saves in date order…`;
    for (const it of saves) {
      const meta = await runWorker(it.file, { peek: true });
      cands.push({ date: meta.date, playthrough: meta.playthrough, file: it.file, entry: it.entry });
    }

    // 2. One per in-game date (a live save beats a stored snapshot), oldest first.
    cands.sort((a, b) => dateKey(a.date) - dateKey(b.date));
    const rank = (c) => (c.file ? 3 : c.full ? 2 : 1);
    const byDate = new Map();
    const dupes = [];
    for (const c of cands) {
      const have = byDate.get(c.date);
      if (!have) byDate.set(c.date, c);
      else {
        const [keep, drop] = rank(c) > rank(have) ? [c, have] : [have, c];
        byDate.set(c.date, keep);
        if (drop.file) dupes.push(drop.file.name);
      }
    }
    const list = [...byDate.values()];
    const newest = list[list.length - 1];

    // 3. Read the saves: the newest in full, the rest without flags or map.
    const runs = list.filter((c) => c.file);
    let done = 0;
    const multi = list.length > 1;
    for (const c of runs) {
      const isNewest = c === newest;
      const label = multi ? `Save ${done + 1} of ${runs.length} (${c.date}): ` : "";
      const o = isNewest ? opts : { ...opts, flags: false, map: false };
      if (multi) logLine(`— ${c.file.name}${isNewest ? " (newest: full report)" : ""}`);
      const data = await runWorker(c.file, o,
        (s) => { $("stagetext").textContent = label + s; },
        (v) => setBar($("buildbar"), (done + v) / runs.length));
      c.full = data;
      done++;
      noteRecent(c.entry, data.world);
    }
    if (newest.entry && newest.full) noteRecent(newest.entry, newest.full.world);

    // 4. Assemble: the newest save's report, plus every snapshot.
    const snaps = list.map((c) => (c.full ? toSnap(c.full) : c.snap));
    const report = { ...newest.full, timeline: { snapshots: snaps } };
    const notes = [];
    if (!game && (opts.flags || opts.map) && newest.file)
      notes.push("Link your EU5 install (step 2) to add coats of arms and the political map.");
    else if (opts.map && newest.file && !newest.full.map)
      notes.push("The map couldn't be drawn — open Details above for the reason.");
    if (dupes.length)
      notes.push(`Skipped ${dupes.join(", ")} — another save has the same in-game date.`);
    const camps = new Set(snaps.map((s) => s.playthrough).filter(Boolean));
    if (camps.size > 1)
      notes.push("These saves look like they come from different campaigns, so the comparisons may not mean much.");
    const source = multi ? `${list.length} saves, ${list[0].date} to ${newest.date}` : (newest.file || {}).name || newest.full.world.save;
    clearInterval(timer);
    await showReport(report, source, notes);
    showStatus(multi ? `Built from ${list.length} saves (${list[0].date} – ${newest.date})` : `Built from ${source}`, "done");
  } catch (err) {
    clearInterval(timer);
    fail(err.message, err.code);
  }
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
  $("rebuild").hidden = !(current && lastItems && lastItems.some((it) => it.file));
  $("addsave").hidden = !current;
}

/* files: [{file, entry}] */
function handleFiles(files) {
  files = files.filter((f) => f && f.file);
  if (files.length) buildMany(files);
}
const handleFile = (file, entry) => handleFiles([{ file, entry }]);

/* Add saves to what's on screen: the current report and its snapshots
   stay, the new files are read, and everything is rebuilt as a timeline. */
function addToCurrent(files) {
  if (!current) return handleFiles(files);
  const snaps = (current.data.timeline && current.data.timeline.snapshots) || [];
  const keep = [{ full: current.data }, ...snaps.filter((s) => s.date !== current.data.world.date).map((snap) => ({ snap }))];
  buildMany([...keep, ...files]);
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
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickSave(false); }
  });
  drop.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    e.preventDefault();
    pickSave(false);
  });
  $("recentclear").addEventListener("click", () => forgetRecent(null));
  loadRecent();
  input.addEventListener("change", () => {
    const files = [...input.files].map((file) => ({ file, entry: null }));
    input.value = "";
    (addMode ? addToCurrent : handleFiles)(files);
  });
  $("recentcompare").addEventListener("click", () => openEntries(recent.filter((r) => picked.has(r)), false));
  $("addsave").addEventListener("click", () => pickSave(true));
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

  $("rebuild").addEventListener("click", () => lastItems && buildMany(lastItems));
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

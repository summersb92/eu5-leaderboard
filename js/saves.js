/* EU5 saves shared by every page: the remembered saves (file handles in
   IndexedDB, Chrome/Edge only), the *current save* every page follows, and
   the nation picked last.

   Whichever page opens a save (the leaderboard its newest, or a tool page
   the one dropped or picked there) stores the File itself in IndexedDB as
   the current save and tells any other open page over a BroadcastChannel.
   A page opened later loads that File straight away: no permission prompt,
   in any browser. */
"use strict";
const EU5Saves = (() => {
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

  const canPickFile = typeof window.showOpenFilePicker === "function";
  const RECENT_MAX = 8;
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("eu5-saves") : null;

  /* The recent list, newest first: [{handle, name, size, modified, used, date}] */
  async function recent() {
    if (!canPickFile) return [];
    const saved = await idb.get("recentSaves");
    return Array.isArray(saved) ? saved.filter((r) => r && r.handle) : [];
  }

  /* Put a just-opened save at the top of the recent list. */
  async function remember(handle, file) {
    if (!canPickFile || !handle || handle.kind !== "file") return null;
    const list = await recent();
    let entry = null;
    for (const r of list) if (await r.handle.isSameEntry(handle).catch(() => false)) entry = r;
    if (entry) {
      if (entry.modified !== file.lastModified) entry.date = null;
      Object.assign(entry, { handle, name: file.name, size: file.size, modified: file.lastModified, used: Date.now(), missing: false });
    } else entry = { handle, name: file.name, size: file.size, modified: file.lastModified, used: Date.now(), date: null };
    await idb.set("recentSaves", [entry, ...list.filter((r) => r !== entry)].slice(0, RECENT_MAX));
    return entry;
  }

  /* A remembered handle -> File. `ask` may prompt for permission, which the
     browser only allows from a click. Returns null when not allowed. */
  async function fileOf(handle, ask) {
    let perm = await handle.queryPermission({ mode: "read" }).catch(() => "denied");
    if (perm !== "granted" && ask) perm = await handle.requestPermission({ mode: "read" }).catch(() => "denied");
    if (perm !== "granted") return null;
    return handle.getFile();
  }

  /* Which page this is, and what to call it. */
  const PAGE = (location.pathname.split("/").pop() || "").replace(/\.html$/i, "").replace(/^(index)?$/, "leaderboard");
  const PAGE_NAMES = { leaderboard: "the leaderboard", placement: "the capital finder", rights: "the rights advisor",
    privateers: "the privateer finder", loans: "the loan advisor" };

  /* Saves or records ({name, modified|lastModified, size}) of the same file version. */
  const stamp = (x) => x && [x.name, x.modified != null ? x.modified : x.lastModified, x.size].join("|");
  const sameSave = (a, b) => !!(a && b && stamp(a) === stamp(b));

  /* Make `file` the save every page follows. `date` and `saves` (how many
     saves went into the leaderboard's report) are shown beside it. */
  async function share(file, { date, saves } = {}) {
    if (!file) return;
    const prev = await idb.get("currentSave");
    if (sameSave(prev, file) && !date && !saves) return; // every page has it already
    const rec = { file, name: file.name, size: file.size, modified: file.lastModified,
      date: date || (sameSave(prev, file) ? prev.date : null), saves: saves || 1, from: PAGE, at: Date.now() };
    await idb.set("currentSave", rec);
    if (channel) channel.postMessage({ type: "current", rec });
  }
  const current = () => idb.get("currentSave");
  const onShare = (fn) => { if (channel) channel.addEventListener("message", (e) => e.data && e.data.type === "current" && fn(e.data.rec)); };
  /* The leaderboard built a report: its newest save becomes the current one. */
  const publishBuild = ({ file, date, saves }) => share(file, { date, saves });

  /* The nation picked last, by tag, so every page opens on it. */
  const NATION_KEY = "eu5nation";
  const nation = () => { try { return localStorage.getItem(NATION_KEY); } catch (e) { return null; } };
  const setNation = (tag) => { try { if (tag) localStorage.setItem(NATION_KEY, tag); } catch (e) {} };

  /* Files from a drop, with handles remembered where the browser gives them
     (they must be asked for during the drop event). -> Promise<[{file, entry}]> */
  function fromDrop(e) {
    const dt = e.dataTransfer;
    if (!dt) return Promise.resolve([]);
    const items = [...(dt.items || [])].filter((it) => it.kind === "file");
    const pending = items.map((it) => (canPickFile && it.getAsFileSystemHandle ? it.getAsFileSystemHandle() : null));
    const files = [...dt.files];
    return Promise.all(files.map((file, i) => Promise.resolve(pending[i]).catch(() => null)
      .then((h) => (h ? remember(h, file) : null)).catch(() => null)
      .then((entry) => ({ file, entry }))));
  }

  /* Open-file dialog that remembers what's picked; null when unsupported or cancelled. */
  async function pick() {
    if (!canPickFile) return null;
    try {
      const [h] = await window.showOpenFilePicker({ id: "eu5-saves",
        types: [{ description: "EU5 saves", accept: { "application/octet-stream": [".eu5"] } }] });
      const file = await h.getFile();
      return { file, entry: await remember(h, file) };
    } catch (e) { return null; }
  }

  const fmtSize = (b) => (b >= 1e6 ? Math.round(b / 1e6) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB");
  const fmtWhen = (t) => new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  /* For the tool pages: a box with the current save and the recent list,
     inside `box`. Loads the current save on opening, and again whenever
     another page makes a different save current (in another tab, or before
     this one came back into view). open(file, how) does the loading; `how`
     is "auto", "click" or "shared". Saves opened here become current. */
  async function mount(box, open) {
    let shown = null; // the save currently on the page
    const render = async () => {
      const [cur, list] = await Promise.all([current(), recent()]);
      box.textContent = "";
      if (cur && cur.file) {
        const p = document.createElement("div");
        p.className = "lbsave";
        const b = document.createElement("button");
        b.type = "button"; b.className = "btn";
        b.textContent = sameSave(shown, cur) ? "Reload" : "Use this save";
        b.addEventListener("click", () => load(cur.file, "click"));
        const t = document.createElement("span");
        const from = cur.from === PAGE ? "opened here" : "from " + (PAGE_NAMES[cur.from] || cur.from);
        t.innerHTML = `<b>Current save</b><span class="recentmeta">${esc(cur.name)}${cur.date ? " · " + esc(cur.date) : ""}` +
          `${cur.saves > 1 ? ` · newest of ${cur.saves}` : ""} · ${esc(from)} · ${esc(fmtWhen(cur.at))}</span>`;
        p.append(t, b);
        box.append(p);
      }
      const others = list.filter((r) => !sameSave(r, cur));
      if (others.length) {
        const d = document.createElement("details");
        d.className = "recent";
        d.innerHTML = `<summary class="recenthead"><span>Recent saves (${others.length})</span></summary>`;
        const ul = document.createElement("ul");
        ul.className = "recentlist";
        for (const r of others) {
          const li = document.createElement("li"), b = document.createElement("button");
          b.type = "button"; b.className = "recentopen" + (r.missing ? " missing" : "");
          b.innerHTML = `<span class="recentname">${esc(r.name)}</span><span class="recentmeta">` +
            [r.date, fmtSize(r.size), "saved " + fmtWhen(r.modified)].filter(Boolean).map(esc).join(" · ") + "</span>";
          b.addEventListener("click", async () => {
            const f = await fileOf(r.handle, true).catch(() => null);
            if (f) { await remember(r.handle, f); load(f, "click"); }
          });
          li.append(b);
          ul.append(li);
        }
        d.append(ul);
        box.append(d);
      }
      box.hidden = !box.childElementCount;
    };
    const load = (file, how) => {
      shown = file;
      open(file, how);
      (how === "click" ? share(file) : Promise.resolve()).then(render);
    };
    // load the current save unless it's the one already on the page
    const follow = async (how) => {
      const cur = await current();
      if (cur && cur.file && !sameSave(shown, cur)) load(cur.file, how);
      else render();
    };
    onShare(() => follow("shared"));
    // switching tabs, or back/forward from the page cache, can miss the message
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") follow("shared"); });
    window.addEventListener("pageshow", (e) => { if (e.persisted) follow("shared"); });
    await follow("auto");
    // note(file): a save dropped or picked on this page, already being opened
    return { refresh: render, note: (file) => { shown = file; share(file).then(render); } };
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  return { idb, canPickFile, recent, remember, fileOf, share, current, onShare, sameSave, publishBuild,
    nation, setNation, fromDrop, pick, mount, fmtSize, fmtWhen };
})();

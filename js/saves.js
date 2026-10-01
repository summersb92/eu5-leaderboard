/* EU5 saves shared by every page: the remembered saves (file handles in
   IndexedDB, Chrome/Edge only), and the save the leaderboard last built a
   report from, which the capital finder and urban rights advisor pick up.

   When the leaderboard finishes a build it records its newest save here and
   tells any other open page over a BroadcastChannel, passing the File itself
   so an open tab can reload without asking for permission again. */
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

  /* The leaderboard built a report: remember its newest save and tell the
     other pages. `saves` is how many saves went into the report. */
  async function publishBuild({ file, handle, date, saves }) {
    const rec = { name: file.name, size: file.size, modified: file.lastModified, date: date || null, saves: saves || 1,
      built: Date.now(), handle: handle || null };
    await idb.set("lastBuild", rec);
    if (channel) {
      try { channel.postMessage({ type: "built", rec, file }); }
      catch (e) { channel.postMessage({ type: "built", rec: { ...rec, handle: null }, file }); }
    }
  }
  const lastBuild = () => idb.get("lastBuild");
  const onBuild = (fn) => { if (channel) channel.addEventListener("message", (e) => e.data && e.data.type === "built" && fn(e.data)); };

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

  /* For the capital finder and rights advisor: a box with the leaderboard's
     latest save and the recent list, inside `box`. Loads the leaderboard's
     save straight away when the browser still allows it, and again whenever
     the leaderboard finishes a new build. open(file, how) does the loading;
     `how` is "auto", "click" or "leaderboard". */
  async function mount(box, open) {
    let shown = null; // the save currently on the page
    const render = async () => {
      const [lb, list] = await Promise.all([lastBuild(), recent()]);
      box.textContent = "";
      if (lb) {
        const p = document.createElement("div");
        p.className = "lbsave";
        const b = document.createElement("button");
        b.type = "button"; b.className = "btn";
        const onPage = shown && shown.name === lb.name && shown.modified === lb.modified;
        b.textContent = onPage ? "Reload" : "Use this save";
        if (!lb.handle) { b.disabled = true; b.textContent = onPage ? "Loaded" : "Open it here once"; b.title = "This browser didn't keep a handle to the file; drop or pick it here."; }
        b.addEventListener("click", async () => {
          const f = lb.handle && await fileOf(lb.handle, true).catch(() => null);
          if (f) load(f, "click"); else b.textContent = "Not allowed — open it from the leaderboard or drop it here";
        });
        const t = document.createElement("span");
        t.innerHTML = `<b>From the leaderboard</b><span class="recentmeta">${esc(lb.name)}${lb.date ? " · " + esc(lb.date) : ""}` +
          `${lb.saves > 1 ? ` · newest of ${lb.saves}` : ""} · built ${esc(fmtWhen(lb.built))}</span>`;
        p.append(t, b);
        box.append(p);
      }
      const others = list.filter((r) => !lb || r.name !== lb.name || r.modified !== lb.modified);
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
      shown = { name: file.name, modified: file.lastModified };
      open(file, how);
      render();
    };
    onBuild(({ file }) => { if (file) load(file, "leaderboard"); else render(); });
    await render();
    const lb = await lastBuild();
    if (lb && lb.handle) {
      const f = await fileOf(lb.handle, false).catch(() => null);
      if (f) load(f, "auto");
    }
    return { refresh: render, note: (file) => { shown = { name: file.name, modified: file.lastModified }; render(); } };
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  return { idb, canPickFile, recent, remember, fileOf, publishBuild, lastBuild, onBuild, fromDrop, pick, mount, fmtSize, fmtWhen };
})();

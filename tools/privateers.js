#!/usr/bin/env node
/* The privateer finder from the command line: runs js/privateer-worker.js
   in Node, for testing the model and for building the page's game-start view.

     node tools/privateers.js rank <save.eu5 | start> [TAG] [--all]
         ranks the sea areas for TAG (default: the save's player), from a
         debug save or from the pack's privateer-start.json; --all also lists
         areas out of naval range or closed by anti-piracy agreements
     node tools/privateers.js start <save.eu5> [version] [--you=TAG]
         writes gamedata/<version>/privateer-start.json from a debug save
         (player names are dropped); --you picks the nation the page opens
         on, for saves that don't name one (multiplayer hotjoin saves).
         Multiplayer oos/ folders hold plaintext hotjoin saves from 1337.4.1.

   Needs gamedata/<version>/privateer.json and proximity.json (default: the newest pack). */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");

const ROOT = path.join(__dirname, "..");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const [cmd, src, arg3] = args;
if (!["rank", "start"].includes(cmd) || !src) {
  console.error("usage: node tools/privateers.js rank <save.eu5|start> [TAG] [--all]\n" +
    "       node tools/privateers.js start <save.eu5> [version] [--you=TAG]");
  process.exit(1);
}
const newest = JSON.parse(fs.readFileSync(path.join(ROOT, "gamedata", "index.json"), "utf8")).packs
  .map((p) => p.version).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
const version = cmd === "start" ? arg3 || newest : newest;
const pack = path.join(ROOT, "gamedata", version);

// A File-like view of a save on disk, as the worker expects.
function fileOf(p) {
  const fd = fs.openSync(p, "r"), size = fs.statSync(p).size;
  const bytes = (a, b) => { const buf = Buffer.alloc(Math.max(0, b - a)); fs.readSync(fd, buf, 0, buf.length, a); return buf; };
  return { name: path.basename(p), size, slice: (a = 0, b = size) => ({
    text: async () => bytes(a, Math.min(b, size)).toString("utf8"),
    arrayBuffer: async () => { const x = bytes(a, Math.min(b, size)); return x.buffer.slice(x.byteOffset, x.byteOffset + x.length); } }) };
}

const ctx = {
  self: { location: { href: "file:///" + ROOT.replace(/\\/g, "/") + "/js/privateer-worker.js" }, addEventListener() {} },
  console, URL, TextDecoder, performance,
  postMessage: (m) => { if (m.type === "log") console.error("  " + m.msg); else if (m.type === "error") console.error("error: " + m.message); },
  importScripts: (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, "js", f), "utf8"), ctx, { filename: f }); },
};
vm.createContext(ctx);
ctx.importScripts("privateer-worker.js");
ctx.__D = JSON.parse(fs.readFileSync(path.join(pack, "privateer.json"), "utf8"));
ctx.__PX = JSON.parse(fs.readFileSync(path.join(pack, "proximity.json"), "utf8"));
vm.runInContext("D = __D; PX = __PX; PP = M.prepare(D, PX);", ctx);

(async () => {
  let loaded;
  if (src === "start") {
    ctx.__j = JSON.parse(fs.readFileSync(path.join(pack, "privateer-start.json"), "utf8"));
    loaded = vm.runInContext("fromSnapshot(__j)", ctx);
  } else {
    ctx.__file = fileOf(src);
    loaded = await vm.runInContext("loadSave(__file)", ctx);
  }

  if (cmd === "start") {
    ctx.__nations = loaded.nations.map((n) => ({ ...n, player: null }));
    const snap = vm.runInContext("snapshot(__nations)", ctx);
    const you = [...flags].find((f) => f.startsWith("--you="));
    if (you) snap.you = you.slice(6).toUpperCase();
    const out = path.join(pack, "privateer-start.json");
    fs.writeFileSync(out, JSON.stringify(snap));
    console.log(`${path.relative(ROOT, out)}: ${snap.date}, ${snap.nations.length} nations, ` +
      `${snap.presence.length} sea zones with presence, ${(fs.statSync(out).size / 1e6).toFixed(2)} MB`);
    return;
  }

  const tag = arg3 || loaded.you;
  const n = loaded.nations.find((x) => x.tag === tag);
  if (!n) { console.error(`no nation ${tag} with ports in that save`); process.exit(1); }
  ctx.__cid = n.cid;
  const r = vm.runInContext("analyze({ cid: __cid })", ctx);
  const M = ctx.self.EU5Priv;
  const rows = M.score(r.rows.filter((x) => flags.has("--all") || (x.eligible && x.inRange)),
    { gold: 1, hurt: 0.5, risk: 0.5, opinion: 0.25 }).sort((a, b) => b.score - a.score);
  const st = r.stats;
  console.log(`${r.name} (${r.tag}) · ${loaded.date} · income ${r.income} · can hire: ${st.canHire ? "yes" : "no"} · ` +
    `naval range ${Math.round(st.range)} · durability ${Math.round(st.durability * 100)}%`);
  console.log("  #  score  sea area                    gold/mo  ports    rivals  hunters  opinion  distance  top victims");
  rows.slice(0, flags.has("--all") ? rows.length : 15).forEach((a, i) => console.log(
    String(i + 1).padStart(3), a.score.toFixed(0).padStart(6), " " + a.name.padEnd(27), a.gold.toFixed(2).padStart(7),
    (a.open + "/" + a.ports).padStart(7), a.hurt.toFixed(1).padStart(8), a.harass.toFixed(1).padStart(8), String(a.opinion).padStart(8),
    (isFinite(a.distance) ? String(a.distance) : "–").padStart(9) + (a.inRange ? " " : "*"),
    a.victims.slice(0, 3).map((v) => `${v.tag} ${v.gold.toFixed(2)} (${v.opinion})`).join(", ")));
  if (flags.has("--all")) console.log("  * out of naval range");
})().catch((e) => { console.error(e); process.exit(1); });

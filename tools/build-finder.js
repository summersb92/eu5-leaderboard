#!/usr/bin/env node
/* Build finder with the data built in: writes build-finder.html with one save's nations already
   loaded, so the page opens on them (anyone can still drop in their own save there).

     node tools/build-finder.js <plaintext save.eu5> <TAG | TAG,TAG,... | players> <out.html>

   Runs js/loans-worker.js in Node - the same code the page runs on a dropped save ("finder"
   message, js/build-finder-model.js) - and fills tools/build-finder-template.html.
   Needs gamedata/<newest version>/rights.json, loans.json (with `interest`) and proximity.json. */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, "..");
if (process.argv.length < 5) { console.error("usage: node tools/build-finder.js <save.eu5> <TAG|TAG,TAG|players> <out.html>"); process.exit(1); }
const [src, TAG, out] = process.argv.slice(2);
const newest = JSON.parse(fs.readFileSync(path.join(ROOT, "gamedata", "index.json"), "utf8")).packs
  .map((p) => p.version).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
const pack = path.join(ROOT, "gamedata", newest);
function fileOf(p) {
  const fd = fs.openSync(p, "r"), size = fs.statSync(p).size;
  const bytes = (a, b) => { const buf = Buffer.alloc(Math.max(0, b - a)); fs.readSync(fd, buf, 0, buf.length, a); return buf; };
  return { name: path.basename(p), size, slice: (a = 0, b = size) => ({
    text: async () => bytes(a, Math.min(b, size)).toString("utf8"),
    arrayBuffer: async () => { const x = bytes(a, Math.min(b, size)); return x.buffer.slice(x.byteOffset, x.byteOffset + x.length); } }) };
}
const ctx = { self: { location: { href: "file:///" + ROOT.replace(/\\/g, "/") + "/js/loans-worker.js" }, addEventListener() {} },
  console, URL, TextDecoder, performance,
  postMessage: (m) => { if (m.type === "log") console.error("  " + m.msg); else if (m.type === "error") console.error("error: " + m.message); },
  importScripts: (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, "js", f), "utf8"), ctx, { filename: f }); } };
vm.createContext(ctx);
ctx.importScripts("loans-worker.js");
const json = (f) => JSON.parse(fs.readFileSync(path.join(pack, f), "utf8"));
ctx.__D = json("rights.json"); ctx.__LD = json("loans.json");
if (!ctx.__LD.interest) console.error(`warning: gamedata/${newest}/loans.json has no interest table; rates will be base + creditworthiness only`);
const px = json("proximity.json"); ctx.__G = { names: px.names, xy: px.xy, kind: px.kind };
vm.runInContext("D = __D; LD = __LD; G = __G;", ctx);

(async () => {
  ctx.__file = fileOf(src);
  const loaded = await vm.runInContext("loadSave(__file)", ctx);
  // TAG: one tag, a comma list, or "players" (every played nation, plus the saving player's)
  const want = TAG.toLowerCase() === "players"
    ? loaded.nations.filter((x) => x.player || x.tag === loaded.you).map((x) => x.tag)
    : TAG.split(",").map((t) => t.trim().toUpperCase());
  const cids = [];
  for (const tag of want) {
    const n = loaded.nations.find((x) => x.tag === tag);
    if (n) cids.push(n.cid); else console.error(`no nation ${tag} in that save, skipped`);
  }
  if (!cids.length) { console.error("no nations to write"); process.exit(1); }
  ctx.__cids = cids;
  const data = vm.runInContext("finder(__cids)", ctx);
  data.pack = newest;
  // the saving player's nation first, the rest by name
  const first = data.nations.find((x) => x.tag === loaded.you) || data.nations[0];
  data.nations.sort((a, b) => (b === first) - (a === first) || a.name.localeCompare(b.name));
  const js = JSON.stringify(data).replace(/</g, String.fromCharCode(92) + "u003c"); // keep "</script" out of the page
  const tpl = fs.readFileSync(path.join(__dirname, "build-finder-template.html"), "utf8");
  fs.writeFileSync(out, tpl.replace("__DATA__", () => js));
  console.error(`wrote ${data.nations.length} nation(s) to ${out}`);
})();

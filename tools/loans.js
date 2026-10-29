#!/usr/bin/env node
/* The loan & build advisor from the command line: runs js/loans-worker.js in
   Node, for testing the model.

     node tools/loans.js <save.eu5> [TAG] [--bond] [--rate=8.5] [--term=60] [--budget=500]

   Needs gamedata/<newest version>/rights.json, loans.json and proximity.json. */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");

const ROOT = path.join(__dirname, "..");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flag = (k) => { const f = process.argv.find((a) => a.startsWith("--" + k + "=")); return f ? parseFloat(f.split("=")[1]) : undefined; };
const [src, tagArg] = args;
if (!src) { console.error("usage: node tools/loans.js <save.eu5> [TAG] [--bond] [--rate=%] [--term=months] [--budget=gold]"); process.exit(1); }
// the newest game-data pack
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

const ctx = {
  self: { location: { href: "file:///" + ROOT.replace(/\\/g, "/") + "/js/loans-worker.js" }, addEventListener() {} },
  console, URL, TextDecoder, performance,
  postMessage: (m) => { if (m.type === "log") console.error("  " + m.msg); else if (m.type === "error") console.error("error: " + m.message); },
  importScripts: (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, "js", f), "utf8"), ctx, { filename: f }); },
};
vm.createContext(ctx);
ctx.importScripts("loans-worker.js");
const json = (f) => JSON.parse(fs.readFileSync(path.join(pack, f), "utf8"));
ctx.__D = json("rights.json"); ctx.__LD = json("loans.json");
const px = json("proximity.json"); ctx.__G = { names: px.names, xy: px.xy, kind: px.kind };
vm.runInContext("D = __D; LD = __LD; G = __G;", ctx);

const f2 = (v, d = 2) => (isFinite(v) ? v.toFixed(d) : "∞");
(async () => {
  ctx.__file = fileOf(src);
  const loaded = await vm.runInContext("loadSave(__file)", ctx);
  const tag = tagArg || loaded.you;
  const n = loaded.nations.find((x) => x.tag === tag);
  if (!n) { console.error(`no nation ${tag} in that save`); process.exit(1); }
  const rate = flag("rate");
  ctx.__q = { cid: n.cid, mode: process.argv.includes("--bond") ? "bond" : "loan", rate: rate === undefined ? undefined : rate / 100,
    term: flag("term"), budget: flag("budget") };
  const r = vm.runInContext("analyze(__q)", ctx);
  const E = r.econ;
  console.log(`\n${r.name} (${r.tag}) ${loaded.date}: gold ${f2(E.gold)}, income ${f2(E.income)}, expense ${f2(E.expense)}, ` +
    `debt ${f2(E.debt)} (foreign ${f2(E.foreignDebt)}, bonds ${f2(E.bondDebt)}), creditworthiness ${f2(E.credit * 100, 0)}`);
  console.log(`tax income ${f2(E.taxIncome)} vs model ${f2(r.modelTax)}; capture ${f2(r.capture * 100, 1)}% of tax base ${f2(r.taxBase)}; ` +
    `cost factor building x${f2(r.costFactor.building)} (${r.costFactor.from.building}), rgo x${f2(r.costFactor.rgo)} (${r.costFactor.from.rgo}); ` +
    `wealth per gold: building ${f2(r.wealth.building)}, RGO ${f2(r.wealth.rgo)}`);
  console.log(`financing: ${r.opts.mode} at ${f2(r.opts.rate * 100)}%${r.opts.mode === "loan" ? `, ${r.opts.term} months` : ""}; ` +
    `defaults loan ${f2(r.rates.loan * 100)}% (${r.rates.loanFrom}), bond ${f2(r.rates.bond * 100)}% (${r.rates.bondFrom})`);
  console.log(`owes: ${r.owed.map((o) => `${o.bond ? "bond" : o.lenderName || "estates"} ${f2(o.amount)} @${f2(o.rate * 100)}%`).join(", ") || "nothing"}`);
  const ok = r.projects.filter((p) => !p.blocked && p.levels > 0);
  const counts = {};
  for (const p of ok) counts[p.verdict] = (counts[p.verdict] || 0) + 1;
  const why = {};
  for (const p of r.projects) if (p.blocked) { const k = p.blocked.replace(/[\d.]+/g, "n"); why[k] = (why[k] || 0) + 1; }
  console.log(`projects: ${r.projects.length}, buildable ${ok.length}`, counts, "blocked:", why);
  console.log("\nbest treasury return per gold:");
  for (const p of ok.sort((a, b) => b.toTreasury / b.cost - a.toTreasury / a.cost).slice(0, 15))
    console.log(`  ${p.name.padEnd(18)} ${p.what.padEnd(30)} x${String(p.levels).padEnd(3)} cost ${f2(p.cost, 1).padStart(6)} profit ${f2(p.profit, 3)} ` +
      `-> treasury ${f2(p.toTreasury, 3)} (ctl ${f2(p.control * 100, 0)}% tax ${f2(p.capture * 100, 0)}%) need ${f2(p.need, 3)} cover ${f2(p.cover)} ` +
      `pays interest up to ${f2(p.rateInterest * 100, 1)}%  ${p.verdict}`);
  const T = r.planTotals;
  console.log(`\nplan: ${r.plan.length} lines, principal ${f2(T.principal, 1)}, returns ${f2(T.monthly, 3)}/mo, interest ${f2(T.interest, 3)}/mo`);
  for (const p of r.plan) console.log(`  ${p.name} ${p.what} x${p.take}`);
})();

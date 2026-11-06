/* Milan build finder: one self-contained HTML page with sliders over every build project a nation has.
     node tools/build-finder.js <plaintext save.eu5> <TAG | TAG,TAG,... | players> <out.html>
   Uses js/loans-worker.js (the loan & build advisor model) and tools/build-finder-template.html. */
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
const px = json("proximity.json"); ctx.__G = { names: px.names, xy: px.xy, kind: px.kind };
vm.runInContext("D = __D; LD = __LD; G = __G;", ctx);
// country display names from the game's localisation, when the install is where Steam usually puts it
const NAME = {};
try {
  const loc = "C:/Program Files (x86)/Steam/steamapps/common/Europa Universalis V/game/main_menu/localization/english/country_names_l_english.yml";
  for (const m of fs.readFileSync(loc, "utf8").matchAll(/^ ([A-Z][A-Z0-9]{2}):\d* "([^"]+)"/gm)) NAME[m[1]] = m[2];
} catch (e) { /* tags only */ }

vm.runInContext("M.readEconomy.keepRaw = true;", ctx);

/* ---- loan and bond interest, the way the game builds it --------------------------------------
   bank_interest = 0.10 (auto_modifiers/country.txt) - 0.05 x (creditworthiness - 0.5)
                   + every bank_interest from researched advances, implemented laws/policies, privileges and
                   reforms, timed modifiers (x size) and the capital-vs-traditional economy societal value.
   bond_interest is the same with base 0.05 and -0.04 per creditworthiness. Clamped to LOAN_MIN/MAX (1%-25%).
   Checked on Milan 1472: 10 - 0.29 - 2 (banking) - 1 (treasury rights) - 2.15 (capital economy -72) - 1 (generous terms) = 3.56%. */
const GAME = "C:/Program Files (x86)/Steam/steamapps/common/Europa Universalis V/game";
const INTEREST = { advance: new Map(), policy: new Map(), privilege: new Map(), reform: new Map(), modifier: new Map(), societal: new Map() };
function scanInterest(file, kind, depth) {
  // depth: which nesting level names the thing a nation has (1 = top-level object, 2 = a policy inside a law)
  let text; try { text = fs.readFileSync(file, "utf8"); } catch (e) { return; }
  const stack = [];
  for (let line of text.split("\n")) {
    line = line.replace(/#.*/, "");
    const open = line.match(/^\s*([A-Za-z_0-9]+)\s*=\s*\{/);
    const opens = line.split("{").length - 1, closes = line.split("}").length - 1;
    // the names in scope for a value on this line (an inline "x = { ... }" block counts while we read it)
    const scope = open ? [...stack, open[1]] : stack;
    const m = line.match(/\b(bank_interest|bond_interest)\s*=\s*(-?[\d.]+)/);
    if (m && scope.length >= depth) {
      const name = scope[depth - 1], key = m[1] === "bank_interest" ? "bank" : "bond";
      const map = INTEREST[kind], v = map.get(name) || { bank: 0, bond: 0 };
      // societal values: keep the left and right side apart
      if (kind === "societal") { const side = scope[1] || ""; v[side + ":" + key] = (v[side + ":" + key] || 0) + +m[2]; }
      else if (!v["seen_" + key]) { v[key] = +m[2]; v["seen_" + key] = 1; } // first value only (later ones are usually alternatives)
      map.set(name, v);
    }
    if (opens > closes) { stack.push(open ? open[1] : "?"); for (let i = 1; i < opens - closes; i++) stack.push("?"); }
    else for (let i = 0; i < closes - opens; i++) stack.pop();
  }
}
function walk(dir, fn) { let e = []; try { e = fs.readdirSync(dir, { withFileTypes: true }); } catch (x) { return; }
  for (const d of e) { const p = path.join(dir, d.name); if (d.isDirectory()) walk(p, fn); else if (d.name.endsWith(".txt")) fn(p); } }
const roots = [GAME, ...(() => { try { return fs.readdirSync(path.join(GAME, "dlc")).map((d) => path.join(GAME, "dlc", d)); } catch (e) { return []; } })()];
for (const r of roots) {
  walk(path.join(r, "in_game/common/advances"), (f) => scanInterest(f, "advance", 1));
  walk(path.join(r, "in_game/common/laws"), (f) => scanInterest(f, "policy", 2));
  walk(path.join(r, "in_game/common/estate_privileges"), (f) => scanInterest(f, "privilege", 1));
  walk(path.join(r, "in_game/common/government_reforms"), (f) => scanInterest(f, "reform", 1));
  walk(path.join(r, "main_menu/common/static_modifiers"), (f) => scanInterest(f, "modifier", 1));
  walk(path.join(r, "in_game/common/societal_values"), (f) => scanInterest(f, "societal", 1));
}
console.error(`interest sources: ${Object.entries(INTEREST).map(([k, m]) => k + " " + m.size).join(", ")}`);

function interestOf(raw, credit) {
  const parts = [], add = (what, bank, bond) => { if (bank || bond) parts.push({ what, bank: bank || 0, bond: bond || 0 }); };
  add("base", 0.10, 0.05);
  add(`creditworthiness ${Math.round(credit * 100)}%`, -0.05 * (credit - 0.5), -0.04 * (credit - 0.5));
  if (raw) {
    const blk = (k) => { const i = raw.indexOf("\n\t\t" + k + "={"); if (i < 0) return ""; let d = 0, j = raw.indexOf("{", i);
      for (let x = j; x < raw.length; x++) { if (raw[x] === "{") d++; else if (raw[x] === "}" && --d === 0) return raw.slice(j, x); } return ""; };
    const ra = (raw.match(/\n\tresearched_advances=\{([^}]*)\}/) || [])[1] || "";
    for (const m of ra.matchAll(/(\w+)=yes/g)) { const v = INTEREST.advance.get(m[1]); if (v) add(m[1], v.bank, v.bond); }
    for (const [k, map] of [["implemented_laws", INTEREST.policy], ["implemented_privileges", INTEREST.privilege], ["implemented_reforms", INTEREST.reform]])
      for (const m of blk(k).matchAll(/object=(\w+)/g)) { const v = map.get(m[1]); if (v) add(m[1], v.bank, v.bond); }
    const tm = (raw.match(/\n\ttimed_modifiers=\{[\s\S]*?\n\t\}/) || [""])[0];
    for (const m of tm.matchAll(/modifier=(\w+)[\s\S]*?size=(-?[\d.]+)/g)) { const v = INTEREST.modifier.get(m[1]); if (v) add(m[1], v.bank * +m[2], v.bond * +m[2]); }
    for (const [name, v] of INTEREST.societal) {
      const m = raw.match(new RegExp("\\n\\t+" + name + "=(-?[\\d.]+)")); if (!m) continue;
      const x = +m[1] / 100; // -1 = fully left, +1 = fully right
      const side = x < 0 ? "left_modifier" : "right_modifier", s = Math.abs(x);
      add(`${name} ${Math.round(+m[1])}`, (v[side + ":bank"] || 0) * s, (v[side + ":bond"] || 0) * s);
    }
  }
  const clamp = (v) => Math.min(0.25, Math.max(0.01, v));
  return { loan: clamp(parts.reduce((s, p) => s + p.bank, 0)), bond: clamp(parts.reduce((s, p) => s + p.bond, 0)),
    parts: parts.map((p) => ({ what: p.what, bank: r4(p.bank), bond: r4(p.bond) })) };
}

const r4 = (v) => (typeof v === "number" && isFinite(v) ? Math.round(v * 1e4) / 1e4 : v);
function nationData(r, loaded) {
  const mk = vm.runInContext("S.markets", ctx);
  const mname = (id) => { const m = mk.get(id); return m ? px.names[m.center] || "#" + m.center : "?"; };
  const mkt = vm.runInContext("new Map([...S.locs].map(([l, L]) => [l, L.market]))", ctx);
  const P = r.projects.filter((p) => p.levels > 0 || p.blocked).map((p) => ({
    loc: p.name, rank: p.rank, market: mname(mkt.get(p.loc)), kind: p.kind, type: p.type, what: p.what,
    level: p.level, levels: p.levels, cap: p.cap, pop: p.pop, staff: r4(p.staff), cost: r4(p.cost), profit: r4(p.profit),
    control: r4(p.control), capture: r4(p.capture), wealth: r4(p.kind === "rgo" ? r.wealth.rgo : r.wealth.building),
    basis: p.basis, blocked: p.blocked, crowded: p.crowded, marketLevels: p.marketLevels }));
  const E = r.econ;
  // court / diplomatic / stability spending: 0.1 x tax base x slider x k, with k (cost modifiers) read back from last month
  const TB = E.taxBaseGame || r.taxBase;
  const line = (setting, spent) => ({ setting, spent, k: setting > 0 && TB > 0 && spent != null ? spent / (0.1 * setting * TB) : 1 });
  const spend = { taxBase: TB,
    court: line(E.settings.CourtMaintenance || 0, E.spent.CourtMaintenance),
    diplo: line(E.settings.DiplomaticMaintenance || 0, E.spent.DiplomaticMaintenance),
    stab: line(E.stabilityInvestment || 0, null) };
  return { tag: r.tag, name: NAME[r.tag] || r.name,
    econ: { gold: E.gold, income: E.income, expense: E.expense, debt: E.debt, credit: E.credit, taxIncome: E.taxIncome },
    spend, capture: r.capture, wealth: r.wealth, costFactor: r.costFactor.building, interest: interestOf(E.raw, E.credit),
    owed: r.owed.map((o) => ({ amount: o.amount, rate: o.rate, bond: !!o.bond })), projects: P };
}

(async () => {
  ctx.__file = fileOf(src);
  const loaded = await vm.runInContext("loadSave(__file)", ctx);
  // TAG: one tag, a comma list, or "players" (every played nation, plus the saving player's)
  const want = TAG.toLowerCase() === "players"
    ? loaded.nations.filter((x) => x.player || x.tag === loaded.you).map((x) => x.tag)
    : TAG.split(",").map((t) => t.trim().toUpperCase());
  const nations = [];
  for (const tag of want) {
    const n = loaded.nations.find((x) => x.tag === tag);
    if (!n) { console.error(`no nation ${tag} in that save, skipped`); continue; }
    ctx.__q = { cid: n.cid, mode: "loan", rate: 0.035, term: 60, budget: 0 };
    const d = nationData(vm.runInContext("analyze(__q)", ctx), loaded);
    if (n.player && n.player !== "player") d.player = n.player;
    nations.push(d);
    console.error(`${tag}: ${d.projects.length} projects`);
  }
  if (!nations.length) { console.error("no nations to write"); process.exit(1); }
  const first = nations.find((x) => x.tag === loaded.you) || nations[0];
  nations.sort((a, b) => (b === first) - (a === first) || a.name.localeCompare(b.name));
  const data = JSON.stringify({ baseAge1: vm.runInContext("LD.prices.p_building_age_1_traditions", ctx), date: loaded.date,
    save: loaded.save, pack: newest, nations }).replace(/</g, String.fromCharCode(92) + "u003c"); // keep "</script" out of the page
  const title = `${nations.length > 1 ? "EU5" : nations[0].name} build finder (${loaded.date})`;
  const tpl = fs.readFileSync(path.join(__dirname, "build-finder-template.html"), "utf8");
  fs.writeFileSync(out, tpl.split("__TITLE__").join(title).replace("__DATA__", () => data));
  console.error(`wrote ${nations.length} nation(s) to ${out}`);
})();

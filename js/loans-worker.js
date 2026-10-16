/* EU5 loan & build advisor - reads a save and values every building project
   of a nation against a loan or a bond, in a Web Worker. Reuses the
   leaderboard worker's save reading and game-data packs (worker.js) and the
   rights advisor's market and production readers (rights-model.js); the
   model is in loans-model.js.

   in:  {save: File}                                          -> "loaded"
        {type: "analyze", cid, mode, rate, term, budget}      -> "analysis"
   out: {type: "log"|"stage"|"progress"|"loaded"|"analysis"|"error", ...} */
"use strict";
importScripts("worker.js", "rights-model.js", "loans-model.js");
const R = self.EU5Rights, M = self.EU5Loans;

let S = null;   // the save's data
let D = null;   // rights.json from the pack
let LD = null;  // loans.json from the pack
let G = null;   // names and centres from proximity.json

async function loadSave(save) {
  stage("Checking the save…");
  await checkPlaintext(save);
  log(`reading ${save.name} (${Math.round(save.size / 1e6)} MB)`);
  const sections = await scanSections(save);
  for (const k of ["metadata", "countries", "locations", "building_manager", "market_manager"])
    if (!sections.has(k)) throw new UserError(`The save has no ${k} section.`);

  const meta = (await readSpan(save, ...sections.get("metadata")[0])).slice(0, 200000);
  const you = (meta.match(/flag="([A-Z0-9]{2,3})=\{/) || [])[1] || null;
  const date = (meta.match(/\n\tdate=([\d.]+)/) || [])[1] || "?";
  const version = (meta.match(/\n\tversion="([^"]+)"/) || [])[1] || "?";

  const players = new Map();
  for (const [a, b] of sections.get("played_country") || []) {
    const t = await readSpan(save, a, b);
    const cid = t.match(/\n\tcountry=(\d+)/), nm = t.match(/\n\tname="([^"]*)"/);
    if (cid && !players.has(+cid[1])) players.set(+cid[1], nm ? nm[1] : "player");
  }

  stage("Reading countries…");
  progress(0.3);
  let ctext = await readSpan(save, ...sections.get("countries")[0]);
  const tags = countryHeaderTags(ctext);
  const countries = new Map(), researched = new Map(), econ = new Map(), names = new Map();
  for (const [cid, chunk] of splitEntries(ctext, "database")) {
    const tag = tags.get(cid) || "?";
    names.set(+cid, NAMES[tag] || tag);
    const cap = chunk.match(/\n\tcapital=(\d+)/);
    if (!cap) continue;
    countries.set(+cid, { cid: +cid, tag, name: NAMES[tag] || tag, capital: +cap[1] });
    econ.set(+cid, M.readEconomy(chunk));
    const ra = chunk.match(/\n\tresearched_advances=\{([^}]*)\}/);
    if (ra) researched.set(+cid, new Set([...ra[1].matchAll(/(\w+)=yes/g)].map((m) => m[1])));
  }
  ctext = null;

  stage("Reading locations…");
  progress(0.42);
  let ltext = await readSpan(save, ...sections.get("locations")[0]);
  const locs = M.readLocations(ltext);
  ltext = null;
  if (sections.has("population")) {
    stage("Counting people…");
    const size = M.readPopSizes(await readSpan(save, ...sections.get("population")[0]));
    for (const L of locs.values()) { let s = 0; for (const id of L.pops) s += size.get(id) || 0; L.pop = s; delete L.pops; }
  }

  stage("Reading buildings…");
  progress(0.62);
  const buildings = [];
  for (const [a, b] of sections.get("building_manager")) buildings.push(...M.readBuildings(await readSpan(save, a, b)));

  stage("Reading markets, loans and constructions…");
  progress(0.78);
  const markets = R.readMarkets(await readSpan(save, ...sections.get("market_manager")[0]));
  const loans = sections.has("loan_manager") ? M.readLoans(await readSpan(save, ...sections.get("loan_manager")[0])) : [];
  const cons = sections.has("construction_manager") ? M.readConstructions(await readSpan(save, ...sections.get("construction_manager")[0])) : [];

  stage("Working out what every RGO makes…");
  progress(0.88);
  const { out: prod } = R.production(D, locs, [], markets);
  log(`${locs.size} locations, ${buildings.length} buildings, ${markets.size} markets, ${loans.length} loans and bonds, ` +
    `${cons.length} paid constructions`);

  const nLocs = new Map();
  for (const L of locs.values()) nLocs.set(L.owner, (nLocs.get(L.owner) || 0) + 1);
  const list = [];
  for (const c of countries.values()) {
    const k = nLocs.get(c.cid) || 0;
    if (!k) continue;
    list.push({ ...c, locations: k, player: players.get(c.cid) || null });
  }
  list.sort((a, b) => (!!b.player - !!a.player) || b.locations - a.locations);
  S = { locs, buildings, markets, prod, econ, loans, cons, researched, countries, names };
  return { date, version, you, save: save.name, nations: list };
}

const locName = (i) => (G.names[i] || "#" + i);
const r3 = (v) => (isFinite(v) ? Math.round(v * 1000) / 1000 : v);

function analyze({ cid, mode, rate, term, budget }) {
  const t0 = performance.now();
  const c = S.countries.get(cid);
  if (!c) throw new UserError("That nation isn't in the save.");
  const rates = M.defaultRates(S, cid);
  const opts = { mode: mode || "loan", rate: rate ?? (mode === "bond" ? rates.bond : rates.loan),
    term: term || 60, budget: budget ?? 500 };
  const res = M.analyzeCountry(D, LD, S, cid, opts);
  const bname = (k) => (D.buildings[k] && D.buildings[k].name) || k;
  const gname = (k) => (D.goods[k] && D.goods[k].name) || k;
  const label = (p) => (p.kind === "rgo" ? `Expand ${gname(p.type)} RGO` : `${p.kind === "new" ? "Build" : "Expand"} ${bname(p.type)}`);
  const slim = (p) => ({
    loc: p.loc, name: locName(p.loc), rank: p.rank, kind: p.kind, type: p.type, what: label(p), level: p.level, levels: p.levels,
    cap: isFinite(p.cap) ? p.cap : null, pop: p.pop, staff: r3(p.staff), cost: r3(p.cost), profit: r3(p.profit),
    toTreasury: r3(p.toTreasury), control: r3(p.control), capture: r3(p.capture), basis: p.basis, blocked: p.blocked,
    crowded: p.crowded || 0, marketLevels: p.marketLevels || 0,
    interest: r3(p.interest), need: r3(p.need), cover: r3(p.cover), payback: r3(p.payback),
    rateInterest: r3(p.rateInterest), rateRepay: r3(p.rateRepay), verdict: p.verdict, take: p.take,
  });
  log(`analysed ${c.tag}: ${res.projects.length} projects, plan ${res.plan.length} in ${Math.round(performance.now() - t0)} ms`);
  return {
    cid, tag: c.tag, name: c.name, capital: c.capital, opts, rates,
    econ: res.econ, costFactor: res.costFactor, wealth: res.wealth, capture: res.capture, taxBase: res.taxBase, modelTax: res.modelTax,
    baseGold: { building: LD.prices.p_building_age_1_traditions },
    projects: res.projects.map(slim), plan: res.plan.map(slim), planTotals: res.planTotals,
    owed: res.owed, lent: res.lent, defines: LD.loans,
    xy: Object.fromEntries([...S.locs].filter(([, L]) => L.owner === cid).map(([l]) => [l, [G.xy[2 * l], G.xy[2 * l + 1]]])),
    locNames: Object.fromEntries([...S.locs].filter(([, L]) => L.owner === cid).map(([l]) => [l, locName(l)])),
  };
}

self.onmessage = async (e) => {
  const d = e.data;
  try {
    if (d.type === "analyze") {
      postMessage({ type: "analysis", data: analyze(d) });
      return;
    }
    const pack = await choosePack(null);
    if (!pack) throw new UserError("Couldn't load the built-in game data.");
    const base = new URL(pack.version + "/", PACK_ROOT);
    const get = async (f, what) => {
      const r = await fetch(new URL(f, base));
      if (!r.ok) throw new UserError(`The ${pack.label} has no ${what}.`);
      return r.json();
    };
    if (!D) { stage("Loading game data…"); D = await get("rights.json", "building data"); }
    if (!LD) LD = await get("loans.json", "building price data");
    if (!G) { const p = await get("proximity.json", "map data"); G = { names: p.names, xy: p.xy, kind: p.kind }; }
    const data = await loadSave(d.save);
    data.kind = G.kind;
    data.pack = { version: pack.version, name: pack.name || null, base: base.href };
    if (data.version !== "?" && data.version !== pack.version) log(`save is ${data.version}; using ${pack.label}`);
    postMessage({ type: "loaded", data });
  } catch (err) {
    if (!(err instanceof UserError) && err && err.stack) log(err.stack);
    postMessage({ type: "error", code: err instanceof UserError ? err.code : "internal", message: err && err.message ? err.message : String(err) });
  }
};

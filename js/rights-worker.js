/* EU5 urban rights advisor - values every urban right in every location of
   a nation, in a Web Worker. Reuses the leaderboard worker's save reading and
   game-data packs (worker.js); the model is in rights-model.js.

   in:  {save: File}                                     -> "loaded"
        {type: "analyze", cid, boroughOnly, rgoPenalty}  -> "analysis"
   out: {type: "log"|"stage"|"progress"|"loaded"|"analysis"|"error", ...} */
"use strict";
importScripts("worker.js", "rights-model.js");
const R = self.EU5Rights;

let S = null;   // the save's data
let D = null;   // rights.json from the pack
let G = null;   // names, centres and ports from proximity.json

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
  progress(0.4);
  let ctext = await readSpan(save, ...sections.get("countries")[0]);
  const tags = countryHeaderTags(ctext);
  const countries = new Map(), researched = new Map();
  for (const [cid, chunk] of splitEntries(ctext, "database")) {
    const cap = chunk.match(/\n\tcapital=(\d+)/);
    if (!cap) continue;
    const tag = tags.get(cid) || "?";
    countries.set(+cid, { cid: +cid, tag, name: NAMES[tag] || tag, capital: +cap[1] });
    const ra = chunk.match(/\n\tresearched_advances=\{([^}]*)\}/);
    if (ra) researched.set(+cid, new Set([...ra[1].matchAll(/(\w+)=yes/g)].map((m) => m[1])));
  }
  ctext = null;

  stage("Reading locations…");
  progress(0.5);
  let ltext = await readSpan(save, ...sections.get("locations")[0]);
  const locs = R.readLocations(ltext);
  ltext = null;

  stage("Reading buildings…");
  progress(0.62);
  const pmNames = new Set();
  for (const b of Object.values(D.buildings)) for (const p of b.pms) pmNames.add(p.name);
  const buildings = [];
  for (const [a, b] of sections.get("building_manager")) buildings.push(...R.readBuildings(await readSpan(save, a, b), pmNames));

  stage("Reading markets…");
  progress(0.75);
  const markets = R.readMarkets(await readSpan(save, ...sections.get("market_manager")[0]));
  const rights = sections.has("townrights_manager")
    ? R.readTownRights(await readSpan(save, ...sections.get("townrights_manager")[0])) : new Map();

  stage("Working out what every location makes…");
  progress(0.85);
  const { out: prod, scale } = R.production(D, locs, buildings, markets);
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
  log(`${locs.size} locations, ${buildings.length} buildings, ${markets.size} markets, ${[...rights.values()].flat().length} urban rights; ` +
    `market calibration: raw x${med(scale.raw).toFixed(2)}, buildings x${med(scale.bld).toFixed(2)} (median)`);

  const ports = new Set();
  for (let i = 0; i < G.port.length; i += 2) ports.add(G.port[i]);
  const nLocs = new Map();
  for (const L of locs.values()) nLocs.set(L.owner, (nLocs.get(L.owner) || 0) + 1);
  const list = [];
  for (const c of countries.values()) {
    const k = nLocs.get(c.cid) || 0;
    if (!k) continue;
    const res = researched.get(c.cid);
    list.push({ ...c, locations: k, player: players.get(c.cid) || null, borough: res ? res.has("town_rights_enable") : null });
  }
  list.sort((a, b) => (!!b.player - !!a.player) || b.locations - a.locations);
  S = { locs, markets, prod, rights, researched, countries, isPort: (l) => ports.has(l) };
  return { date, version, you, save: save.name, nations: list };
}

const locName = (i) => (G.names[i] || "#" + i);
const r2 = (v) => Math.round(v * 100) / 100;

function analyze({ cid, boroughOnly, rgoPenalty }) {
  const t0 = performance.now();
  const c = S.countries.get(cid);
  if (!c) throw new UserError("That nation isn't in the save.");
  const res = R.analyzeCountry(D, S, cid, { boroughOnly, rgoPenalty });
  const rows = res.rows.map((r) => ({
    ...r, name: locName(r.loc),
    rgoAmount: r2(r.rgoAmount), rgoValue: r2(r.rgoValue), bldValue: r2(r.bldValue), bestNet: r2(r.bestNet),
    values: r.values.map((v) => ({ ...v, net: r2(v.net), rgo: r2(v.rgo), bld: r2(v.bld), pen: r2(v.pen) })),
  }));
  // every right in the country already, by type
  const granted = {};
  for (const r of rows) for (const h of r.have) granted[h] = (granted[h] || 0) + 1;
  log(`analysed ${c.tag} (${rows.length} locations) in ${Math.round(performance.now() - t0)} ms`);
  return {
    cid, tag: c.tag, name: c.name, capital: c.capital, hasBorough: res.hasBorough,
    rights: res.rights.map((k) => ({ key: k, ...D.rights[k] })),
    allRightNames: Object.fromEntries(Object.entries(D.rights).map(([k, v]) => [k, v.name])),
    goods: Object.fromEntries(Object.entries(D.goods).map(([k, v]) => [k, v.name])),
    buildingNames: Object.fromEntries(Object.entries(D.buildings).map(([k, v]) => [k, v.name])),
    penalty: D.penalty, granted, rows,
    xy: Object.fromEntries(rows.map((r) => [r.loc, [G.xy[2 * r.loc], G.xy[2 * r.loc + 1]]])),
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
    if (!D) {
      stage("Loading game data…");
      const r = await fetch(new URL("rights.json", base));
      if (!r.ok) throw new UserError(`The ${pack.label} has no urban rights data.`);
      D = await r.json();
    }
    if (!G) {
      const r = await fetch(new URL("proximity.json", base));
      if (!r.ok) throw new UserError(`The ${pack.label} has no map data.`);
      const p = await r.json();
      G = { names: p.names, xy: p.xy, port: p.port, kind: p.kind };
    }
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

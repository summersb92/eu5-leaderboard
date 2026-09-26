/* EU5 placement - finds the best capital and local-governor locations for a
   nation, in a Web Worker. Reuses the leaderboard worker's save reading and
   game-data packs (worker.js), and the proximity model in proximity.js.

   in:  {save: File}                                   -> "loaded"
        {type: "analyze", cid, govs, eligibleOnly, pendingBuilt} -> "analysis"
   out: {type: "log"|"stage"|"progress"|"loaded"|"analysis"|"error", ...} */
"use strict";
importScripts("worker.js", "proximity.js");
const P = self.EU5Prox;

let S = null;       // the save's data
let G = null;       // the pack's location graph
const cache = new Map(); // cid -> country analysis state

const LOC_RANKS = { rural_settlement: "Rural", town: "Town", city: "City", megalopolis: "Megalopolis" };

async function loadSave(save) {
  stage("Checking the save…");
  await checkPlaintext(save);
  log(`reading ${save.name} (${Math.round(save.size / 1e6)} MB)`);
  const sections = await scanSections(save);
  for (const k of ["metadata", "countries", "locations"])
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
  const countries = new Map();
  for (const [cid, chunk] of splitEntries(ctext, "database")) {
    const cap = chunk.match(/\n\tcapital=(\d+)/);
    if (!cap) continue;
    const cm = chunk.match(/\n\tcolor=(rgb|hsv360|hsv)\s*\{([^}]*)\}/);
    const rgb = cm ? colorFrom(cm[1], cm[2]) : null;
    const tag = tags.get(cid) || "?";
    countries.set(+cid, { cid: +cid, tag, name: NAMES[tag] || tag, capital: +cap[1], color: rgb ? hex(rgb) : null });
  }
  ctext = null;

  stage("Reading locations…");
  progress(0.55);
  const n = G.n;
  const owner = new Int32Array(n).fill(-1), dev = new Float64Array(n), prox = new Float64Array(n);
  const ptax = new Float64Array(n), tax = new Float64Array(n), control = new Float64Array(n);
  const rank = new Array(n).fill("");
  let ltext = await readSpan(save, ...sections.get("locations")[0]);
  for (const part of ltext.split(/\n\t\t(?=\d+=\{)/)) {
    const id = part.match(/^(\d+)=\{/), o = part.match(/\n\t\t\towner=(\d+)/);
    if (!id || !o) continue;
    const i = +id[1];
    if (i >= n) continue;
    const f = (k) => { const m = part.match(new RegExp("\\n\\t\\t\\t" + k + "=([\\d.]+)")); return m ? parseFloat(m[1]) : 0; };
    owner[i] = +o[1];
    dev[i] = f("development"); prox[i] = f("proximity"); ptax[i] = f("possible_tax");
    tax[i] = f("tax"); control[i] = f("control");
    rank[i] = (part.match(/\n\t\t\trank=(\w+)/) || [])[1] || "";
  }
  ltext = null;

  stage("Reading roads, ports and buildings…");
  progress(0.7);
  const roads = new Map(), roadNb = new Map();
  if (sections.has("road_network")) {
    const t = await readSpan(save, ...sections.get("road_network")[0]);
    for (const m of t.matchAll(/from=(\d+)\s+to=(\d+)\s+type=(\w+)/g)) {
      const a = +m[1], b = +m[2];
      roads.set(G.key(a, b), m[3]); roads.set(G.key(b, a), m[3]);
      (roadNb.get(a) || roadNb.set(a, []).get(a)).push(b);
      (roadNb.get(b) || roadNb.set(b, []).get(b)).push(a);
    }
  }
  const presence = new Map();
  if (sections.has("maritime_manager")) {
    const t = await readSpan(save, ...sections.get("maritime_manager")[0]);
    for (const part of t.split(/\n\t\t(?=\d+=\{)/)) {
      const id = part.match(/^(\d+)=\{/);
      if (!id) continue;
      const m = new Map();
      for (const p of part.matchAll(/power=([\d.]+)\s+country=(\d+)/g)) m.set(+p[2], parseFloat(p[1]));
      if (m.size) presence.set(+id[1], m);
    }
  }
  // Local governors, finished or being built (a finished one's location
  // sits at exactly the governor's proximity).
  const governors = [];
  if (sections.has("building_manager")) {
    for (const [a, b] of sections.get("building_manager")) {
      const t = await readSpan(save, a, b);
      let at = -1;
      while ((at = t.indexOf("\n\ttype=local_governor\n", at + 1)) >= 0) {
        const body = t.slice(at, at + 1500).split(/\n\d+=\{/)[0];
        const loc = body.match(/\n\tlocation=(\d+)/), own = body.match(/\n\towner=(\d+)/);
        if (loc && own) governors.push({ loc: +loc[1], owner: +own[1] });
      }
    }
  }
  // Nations worth offering: anyone owning locations.
  const nLocs = new Map();
  for (let i = 1; i < n; i++) if (owner[i] >= 0 && G.kind[i] === 0) nLocs.set(owner[i], (nLocs.get(owner[i]) || 0) + 1);
  const list = [];
  for (const c of countries.values()) {
    const k = nLocs.get(c.cid) || 0;
    if (!k || owner[c.capital] !== c.cid) continue;
    list.push({ ...c, locations: k, player: players.get(c.cid) || null, capitalName: locName(c.capital) });
  }
  list.sort((a, b) => (!!b.player - !!a.player) || b.locations - a.locations);
  S = { owner, dev, prox, ptax, tax, control, rank, roads, roadNb, presence, governors, countries, you, date, version, save: save.name };
  log(`${list.length} nations, ${roads.size / 2} road links, ${governors.length} local governors`);
  return { date, version, you, save: save.name, nations: list };
}

const locName = (i) => (G.names[i] || "#" + i);

function analyze({ cid, govs: K, eligibleOnly, pendingBuilt }) {
  const t0 = performance.now();
  const c = S.countries.get(cid);
  if (!c) throw new UserError("That nation isn't in the save.");
  let st = cache.get(cid);
  if (!st) st = prepare(c);
  cache.set(cid, st);
  const { cg, locs, idx, cap, weight, cpp } = st;
  const m = locs.length;
  const sources = [...st.active, ...(pendingBuilt ? st.pending : [])];
  const others = combine(st, sources.map((s) => st.srcField(s.loc, s.value)));
  const capField = st.capFields[idx.get(cap)];
  const base = maxOf(capField, others);
  const baseScore = scoreOf(base, weight, cpp);

  // --- local governors with the current capital ---------------------------
  const taken = new Set([cap, ...sources.map((s) => s.loc)]);
  const status = (i, reach) => {
    const city = S.rank[i] === "city" || S.rank[i] === "megalopolis";
    const road = reach.has(i);
    return city && road ? "ready" : !city && !road ? "city+road" : !city ? "city" : "road";
  };
  const reachCap = P.roadReach(cg, S, G, cap);
  const govRank = [];
  for (let j = 0; j < m; j++) {
    const i = locs[j];
    if (taken.has(i)) continue;
    const f = st.govFields[j];
    const gain = scoreOf(maxOf(base, f), weight, cpp) - baseScore;
    govRank.push({ loc: i, gain, status: status(i, reachCap) });
  }
  govRank.sort((a, b) => b.gain - a.gain);
  const pool = (reach, capital) => locs.map((i, j) => j).filter((j) => {
    const i = locs[j];
    return i !== capital && !taken.has(i) && (!eligibleOnly || status(i, reach) === "ready");
  });
  const plan = greedy(st, base, pool(reachCap, cap), K, (i) => status(i, reachCap));

  // --- moving the capital (governors you have stay put) ------------------
  const capRank = [];
  for (let j = 0; j < m; j++) {
    const f = maxOf(st.capFields[j], others);
    capRank.push({ loc: locs[j], gain: scoreOf(f, weight, cpp) - baseScore, avg: avgOf(f, st) });
  }
  capRank.sort((a, b) => b.gain - a.gain);

  // --- both together: the best few capitals, each with its own governors --
  let joint = null;
  const tries = [cap, ...capRank.slice(0, 8).map((r) => r.loc).filter((l) => l !== cap)];
  for (const nc of tries) {
    const f0 = maxOf(st.capFields[idx.get(nc)], others);
    const reach = P.roadReach(cg, S, G, nc);
    const pl = greedy(st, f0, pool(reach, nc), K, (i) => status(i, reach));
    const total = scoreOf(pl.field, weight, cpp) - baseScore;
    if (!joint || total > joint.gain + 1e-9) joint = { capital: nc, govs: pl.picks, gain: total, field: pl.field };
  }

  const r3 = (v) => Math.round(v * 1000) / 1000;
  const label = (x) => ({ ...x, name: locName(x.loc), rank: LOC_RANKS[S.rank[x.loc]] || S.rank[x.loc], gain: r3(x.gain) });
  const toArr = (f) => Array.from(f, (v) => Math.round(v * 10) / 10);
  log(`analysed ${c.tag} (${m} locations) in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  return {
    cid, tag: c.tag, name: c.name, color: c.color,
    capital: { loc: cap, name: locName(cap) },
    active: st.active.map((s) => ({ ...s, name: locName(s.loc) })),
    pending: st.pending.map((s) => ({ ...s, name: locName(s.loc) })),
    fit: { scale: r3(cg.scale), mae: r3(st.fit.mae), within5: r3(st.fit.within5) },
    now: { taxSaved: r3(locs.reduce((s, i) => s + S.tax[i], 0)), taxPossible: r3(locs.reduce((s, i) => s + S.ptax[i], 0)),
      settled: r3(baseScore), avg: r3(avgOf(base, st)) },
    govRank: govRank.slice(0, 25).map(label),
    plan: { picks: plan.picks.map(label), gain: r3(plan.gain), avg: r3(avgOf(plan.field, st)) },
    capRank: capRank.slice(0, 15).map(label),
    joint: { capital: label({ loc: joint.capital, gain: 0 }), govs: joint.govs.map(label), gain: r3(joint.gain), avg: r3(avgOf(joint.field, st)) },
    map: {
      locs, xy: locs.flatMap((i) => [G.xy[2 * i], G.xy[2 * i + 1]]),
      names: locs.map(locName), ranks: locs.map((i) => LOC_RANKS[S.rank[i]] || ""),
      saved: locs.map((i) => Math.round(S.prox[i] * 10) / 10), ptax: locs.map((i) => r3(S.ptax[i])),
      base: toArr(base), plan: toArr(plan.field), joint: toArr(joint.field),
    },
    ms: Math.round(performance.now() - t0),
  };
}

/* Fields are Float32Arrays over the country's locations (index j, not id). */
function prepare(c) {
  stage(`Mapping ${c.name}…`);
  const cg = P.countryGraph(G, S, c.cid);
  const locs = cg.locs, m = locs.length, idx = new Map(locs.map((i, j) => [i, j]));
  const cap = c.capital;
  // Sources: the capital, plus every local governor. A finished one's
  // location sits at the governor's full proximity; anything lower is still
  // being built.
  const gv = G.c.governor, active = [], pending = [];
  for (const b of S.governors) {
    if (b.owner !== c.cid || !idx.has(b.loc) || b.loc === cap) continue;
    (S.prox[b.loc] >= gv - 0.5 ? active : pending).push({ loc: b.loc, value: gv });
  }
  // Other sources (event and unique buildings): a location at 80+ proximity
  // that none of its neighbours could have given it.
  const own = new Set(locs);
  for (const i of locs) {
    if (i === cap || S.prox[i] < gv - 0.5 || active.some((s) => s.loc === i) || pending.some((s) => s.loc === i)) continue;
    let top = true;
    for (let e = G.start[i]; e < G.start[i + 1]; e++) { const v = G.to[e]; if (own.has(v) && S.prox[v] >= S.prox[i] - 0.01) top = false; }
    if (top) active.push({ loc: i, value: Math.round(S.prox[i]), other: true });
  }
  const fit = P.calibrate(cg, [[cap, G.c.capital], ...active.map((s) => [s.loc, s.value])], S.prox);
  const buf = new Float32Array(G.n);
  const compact = (full) => { const f = new Float32Array(m); for (let j = 0; j < m; j++) f[j] = full[locs[j]]; return f; };
  const field = (loc, v) => compact(P.spread(cg, [[loc, v]], buf));
  const capFields = new Array(m), govFields = new Array(m);
  for (let j = 0; j < m; j++) {
    if ((j & 15) === 0) { stage(`Testing ${c.name}'s locations… ${j} of ${m}`); progress(j / m); }
    capFields[j] = field(locs[j], G.c.capital);
    govFields[j] = field(locs[j], gv);
  }
  progress(1);
  const weight = Float32Array.from(locs, (i) => S.ptax[i]);
  const srcCache = new Map();
  const srcField = (loc, v) => {
    const k = loc + ":" + v;
    if (!srcCache.has(k)) srcCache.set(k, v === gv ? govFields[idx.get(loc)] : field(loc, v));
    return srcCache.get(k);
  };
  return { cg, locs, idx, cap, active, pending, fit, capFields, govFields, weight, cpp: G.c.controlPerProximity, srcField };
}

function maxOf(a, b) { const o = new Float32Array(a.length); for (let j = 0; j < a.length; j++) o[j] = a[j] > b[j] ? a[j] : b[j]; return o; }
function combine(st, fields) { let o = new Float32Array(st.locs.length); for (const f of fields) o = maxOf(o, f); return o; }
function scoreOf(f, w, cpp) { let s = 0; for (let j = 0; j < f.length; j++) s += w[j] * Math.min(1, f[j] * cpp); return s; }
function avgOf(f) { let s = 0; for (let j = 0; j < f.length; j++) s += f[j]; return f.length ? s / f.length : 0; }

/* Add governors one at a time, each where it adds the most settled tax. */
function greedy(st, start, pool, K, statusFn) {
  let field = start, cur = scoreOf(field, st.weight, st.cpp);
  const picks = [], used = new Set();
  const s0 = cur;
  for (let k = 0; k < K; k++) {
    let best = null;
    for (const j of pool) {
      if (used.has(j)) continue;
      const f = st.govFields[j];
      let s = 0;
      for (let q = 0; q < f.length; q++) { const v = f[q] > field[q] ? f[q] : field[q]; s += st.weight[q] * Math.min(1, v * st.cpp); }
      if (!best || s > best.s) best = { j, s };
    }
    if (!best || best.s - cur < 1e-6) break;
    used.add(best.j);
    field = maxOf(field, st.govFields[best.j]);
    const i = st.locs[best.j];
    picks.push({ loc: i, gain: best.s - cur, status: statusFn(i) });
    cur = best.s;
  }
  return { picks, field, gain: cur - s0 };
}

self.onmessage = async (e) => {
  const d = e.data;
  try {
    if (d.type === "analyze") {
      postMessage({ type: "analysis", data: analyze(d) });
      return;
    }
    cache.clear();
    const pack = await choosePack(null);
    if (!pack) throw new UserError("Couldn't load the built-in game data.");
    if (!G) {
      stage("Loading the map graph…");
      const r = await fetch(new URL(pack.version + "/proximity.json", PACK_ROOT));
      if (!r.ok) throw new UserError(`The ${pack.label} has no proximity data.`);
      G = P.buildGraph(await r.json());
    }
    const data = await loadSave(d.save);
    data.kind = Array.from(G.kind);
    data.pack = { version: pack.version, name: pack.name || null, base: new URL(pack.version + "/", PACK_ROOT).href };
    if (data.version !== "?" && data.version !== pack.version) log(`save is ${data.version}; using ${pack.label}`);
    postMessage({ type: "loaded", data });
  } catch (err) {
    if (!(err instanceof UserError) && err && err.stack) log(err.stack);
    postMessage({ type: "error", code: err instanceof UserError ? err.code : "internal", message: err && err.message ? err.message : String(err) });
  }
};

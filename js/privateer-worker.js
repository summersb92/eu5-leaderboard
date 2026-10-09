/* EU5 privateer finder - reads a save and ranks the sea areas a nation
   could privateer in, in a Web Worker. Reuses the leaderboard worker's save
   reading and game-data packs (worker.js); the model is privateer-model.js.

   in:  {save: File}                                     -> "loaded"
        {type: "analyze", cid, base, factor, power}      -> "analysis"
        {type: "calibrate", obs: [{loc, gold}]}          -> "calibration"
   out: {type: "log"|"stage"|"progress"|"loaded"|"analysis"|"calibration"|"error", ...} */
"use strict";
importScripts("worker.js", "privateer-model.js");
const M = self.EU5Priv;

let S = null;      // the save's data
let D = null;      // privateer.json
let PX = null;     // proximity.json (names, kind, xy, ports)
let PP = null;     // M.prepare(D, PX)

const LOC_RANKS = { rural_settlement: "Rural", town: "Town", city: "City", megalopolis: "Megalopolis" };
const locName = (i) => (PX.names[i] || "#" + i);

async function loadSave(save) {
  stage("Checking the save…");
  await checkPlaintext(save);
  log(`reading ${save.name} (${Math.round(save.size / 1e6)} MB)`);
  const sections = await scanSections(save);
  for (const k of ["metadata", "countries", "locations"])
    if (!sections.has(k)) throw new UserError(`The save has no ${k} section.`);
  const span = async (k) => (sections.has(k) ? readSpan(save, ...sections.get(k)[0]) : "");

  const meta = (await span("metadata")).slice(0, 200000);
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
  let ctext = await span("countries");
  const tags = countryHeaderTags(ctext);
  const countries = new Map();
  for (const [cid, chunk] of splitEntries(ctext, "database")) {
    const cap = chunk.match(/\n\tcapital=(\d+)/);
    if (!cap) continue;
    const cm = chunk.match(/\n\tcolor=(rgb|hsv360|hsv)\s*\{([^}]*)\}/);
    const rgb = cm ? colorFrom(cm[1], cm[2]) : null;
    const tag = tags.get(cid) || "?";
    const inc = chunk.match(/\n\tlast_month_gold_income=(-?[\d.]+)/);
    const adv = chunk.match(/\n\tresearched_advances=\{([^}]*)\}/);
    const laws = chunk.match(/\n\t\timplemented_laws=\{([\s\S]*?)\n\t\t\}/);
    const refs = chunk.match(/\n\t\timplemented_reforms=\{([\s\S]*?)\n\t\t\}/);
    countries.set(+cid, {
      cid: +cid, tag, name: NAMES[tag] || tag, capital: +cap[1], color: rgb ? hex(rgb) : null,
      income: inc ? parseFloat(inc[1]) : 0,
      advances: adv ? [...adv[1].matchAll(/(\w+)=yes/g)].map((m) => m[1]) : [],
      policies: laws ? [...laws[1].matchAll(/object=(\w+)/g)].map((m) => m[1]) : [],
      reforms: refs ? [...refs[1].matchAll(/object=(\w+)/g)].map((m) => m[1]) : [],
    });
  }
  ctext = null;

  stage("Reading locations…");
  progress(0.55);
  const n = PX.n;
  const owner = new Int32Array(n).fill(-1), tax = new Float64Array(n), ptax = new Float64Array(n), flow = new Float64Array(n);
  const rank = new Array(n).fill("");
  let ltext = await span("locations");
  for (const part of ltext.split(/\n\t\t(?=\d+=\{)/)) {
    const id = part.match(/^(\d+)=\{/);
    if (!id) continue;
    const i = +id[1];
    if (i >= n) continue;
    const f = (k) => { const m = part.match(new RegExp("\\n\\t\\t\\t" + k + "=(-?[\\d.]+)")); return m ? parseFloat(m[1]) : 0; };
    const o = part.match(/\n\t\t\towner=(\d+)/);
    if (o) owner[i] = +o[1];
    tax[i] = f("tax"); ptax[i] = f("possible_tax"); flow[i] = f("value_flow");
    rank[i] = (part.match(/\n\t\t\trank=(\w+)/) || [])[1] || "";
  }
  ltext = null;

  stage("Reading buildings, fleets and diplomacy…");
  progress(0.7);
  // ports that can't be raided
  const blocked = new Set(), blockTypes = new Set(D.blockers);
  for (const [a, b] of sections.get("building_manager") || []) {
    const t = await readSpan(save, a, b);
    for (const m of t.matchAll(/\n\ttype=(\w+)\n/g)) {
      if (!blockTypes.has(m[1])) continue;
      const body = t.slice(m.index, m.index + 1500).split(/\n\d+=\{/)[0];
      const loc = body.match(/\n\tlocation=(\d+)/);
      if (loc) blocked.add(+loc[1]);
    }
  }
  // maritime presence per sea zone
  const presence = new Map();
  {
    const t = await span("maritime_manager");
    for (const part of t.split(/\n\t\t(?=\d+=\{)/)) {
      const id = part.match(/^(\d+)=\{/);
      if (!id) continue;
      const m = new Map();
      for (const p of part.matchAll(/power=([\d.]+)\s+country=(\d+)/g)) m.set(+p[2], parseFloat(p[1]));
      if (m.size) presence.set(+id[1], m);
    }
  }
  // privateers out now, and how hard each area hunts pirates
  const privateers = [], harassment = new Map();
  {
    const t = await span("privateer_manager");
    for (const m of t.matchAll(/\n\d+=\{\s*country=(\d+)\s*area=(\w+)\s*power=([\d.]+)/g))
      privateers.push({ country: +m[1], area: m[2], power: parseFloat(m[3]) });
    const h = t.indexOf("pirate_harassment={");
    if (h >= 0) for (const m of t.slice(h).matchAll(/(\w+)=\{\s*last_months_average_harassment=([\d.]+)/g))
      harassment.set(m[1], parseFloat(m[2]));
  }
  // relations
  const subjects = new Map(), overlords = new Map(), allies = new Map(), antiPiracy = new Map();
  const rivals = new Map(), enemies = new Map();
  const addTo = (m, a, b) => (m.get(a) || m.set(a, new Set()).get(a)).add(b);
  {
    const t = await span("diplomacy_manager");
    for (const m of t.matchAll(/dependency=\{\s*first=(\d+)\s*second=(\d+)/g)) { addTo(subjects, +m[1], +m[2]); addTo(overlords, +m[2], +m[1]); }
    const REL = /scripted_(mutual|oneway)=\{\s*first=(\d+)\s*second=(\d+)\s*named_targets=\{\s*\{\s*flag="scripted_relation_type"\s*target=\{\s*type=relation_type\s*object=(\w+)/g;
    for (const m of t.matchAll(REL)) {
      const a = +m[2], b = +m[3];
      if (m[4] === "alliance") { addTo(allies, a, b); addTo(allies, b, a); }
      // the giver of an anti-piracy agreement can't send privateers to the receiver
      else if (m[4] === "anti_piracy_agreement") { addTo(antiPiracy, a, b); if (m[1] === "mutual") addTo(antiPiracy, b, a); }
    }
    for (const [cid, chunk] of splitEntries(t, "diplomacy_manager")) {
      const r = chunk.match(/\n\t\trivals_2=\{\s*list=\{([\s\S]*?)\}\s*\}/);
      if (r) for (const m of r[1].matchAll(/country=(\d+)/g)) addTo(rivals, +cid, +m[1]);
    }
  }
  {
    const t = await span("war_manager");
    for (const mm of t.matchAll(/\n(\d+)=\{\n\tall=\{/g)) {
      const end = t.indexOf("\n}", mm.index + 1);
      const body = t.slice(mm.index, end > 0 ? end : t.length);
      const side = new Map();
      for (const p of body.matchAll(/\{\s*country=(\d+)\s*all_history=\{([\s\S]*?)\n\t\tstatus=(\w+)/g)) {
        if (p[3] !== "Active") continue;
        const s = (p[2].match(/side=(\w+)/) || [])[1];
        if (s) side.set(+p[1], s);
      }
      for (const [a, sa] of side) for (const [b, sb] of side) if (sa !== sb) addTo(enemies, a, b);
    }
  }

  // nations worth offering: anyone owning a port
  const nPorts = new Map();
  for (const land of PP.portZones.keys()) if (owner[land] >= 0) nPorts.set(owner[land], (nPorts.get(owner[land]) || 0) + 1);
  const list = [];
  for (const c of countries.values()) {
    const k = nPorts.get(c.cid) || 0;
    if (!k || owner[c.capital] !== c.cid) continue;
    list.push({ cid: c.cid, tag: c.tag, name: c.name, color: c.color, ports: k, player: players.get(c.cid) || null });
  }
  list.sort((a, b) => (!!b.player - !!a.player) || b.ports - a.ports);
  S = { owner, tax, ptax, flow, rank, blocked, presence, privateers, harassment, subjects, overlords, allies, antiPiracy,
    rivals, enemies, countries, you, date, version, save: save.name };
  log(`${list.length} nations with ports, ${privateers.length} privateers out, ${blocked.size} ports with coastal forts, ` +
    `${[...enemies.values()].reduce((s, x) => s + x.size, 0) / 2} pairs at war`);
  return { date, version, you, save: save.name, nations: list };
}

function analyze({ cid, base, factor, power }) {
  const c = S.countries.get(cid);
  if (!c) throw new UserError("That nation isn't in the save.");
  const r = M.rank(D, PX, PP, S, cid, { base, factor, power });
  const cname = (x) => { const k = S.countries.get(x); return k ? k.name : "#" + x; };
  const ctag = (x) => { const k = S.countries.get(x); return k ? k.tag : "?"; };
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const rows = r.rows.map((a) => ({
    ...a,
    gold: r3(a.gold), hurt: r3(a.hurt), presence: r3(a.presence), presenceMine: r3(a.presenceMine), opinion: Math.round(a.opinion),
    distance: Math.round(a.distance), harass: r3(a.harass), powerDrift: r3(a.powerDrift),
    top: a.top.map((t) => ({ ...t, name: cname(t.cid), tag: ctag(t.cid), presence: r3(t.presence) })),
    victims: a.victims.map((v) => ({ ...v, name: cname(v.cid), tag: ctag(v.cid), gold: r3(v.gold), opinion: Math.round(v.opinion),
      income: r3((S.countries.get(v.cid) || {}).income || 0), share: r3(v.share) })),
    others: a.others.map((p) => ({ ...p, name: cname(p.country), tag: ctag(p.country), power: r3(p.power) })),
    portRows: a.portRows.map((p) => ({ ...p, name: locName(p.loc), zoneName: locName(p.zone), ownerName: p.owner >= 0 ? cname(p.owner) : "–",
      ownerTag: p.owner >= 0 ? ctag(p.owner) : "", rank: LOC_RANKS[S.rank[p.loc]] || "", value: r3(p.value), gold: r3(p.gold) })),
  }));
  // map: every land location's owner relation, and the sea zones' areas
  const rel = M.relations(S, cid);
  const landRel = {};
  for (let i = 1; i < PX.n; i++) {
    if (PX.kind[i] !== 0 || S.owner[i] < 0) continue;
    const x = rel(S.owner[i]);
    if (x !== "neutral") landRel[i] = x;
  }
  const own = [];
  for (let i = 1; i < PX.n; i++) if (S.owner[i] === cid) own.push(i);
  return { cid, tag: c.tag, name: c.name, color: c.color, income: r3(c.income), stats: r.stats, rows, base: r.base, factor: r.factor,
    power: r.power, landRel, own, existing: S.privateers.filter((p) => p.country === cid).map((p) => ({ ...p, power: r3(p.power) })) };
}

/* The save data the model needs, small enough to ship in the game-data pack
   as the page's starting view (privateer-start.json): every location's
   owner, the ports' tax and trade, maritime presence, privateers, relations,
   and each country's privateering advances, policies and reforms only. */
function snapshot(nations) {
  const ports = [...PP.portZones.keys()].sort((a, b) => a - b);
  const keep = (list, kind) => list.filter((k) => D.sources[kind][k]);
  const pairs = (m) => { const o = []; for (const [a, s] of m) for (const b of s) o.push(a, b); return o; };
  const r2 = (v) => Math.round(v * 100) / 100;
  const owner = Array.from(S.owner);
  return {
    format: 1, date: S.date, version: S.version, save: S.save, you: S.you, nations,
    owner,
    ports: ports.flatMap((i) => [i, r2(S.tax[i]), r2(S.ptax[i]), r2(S.flow[i]), S.rank[i] || ""]),
    blocked: [...S.blocked],
    presence: [...S.presence].map(([z, m]) => [z, ...[...m].filter(([, p]) => p >= 0.05).flatMap(([c, p]) => [c, r2(p)])]),
    privateers: S.privateers, harassment: [...S.harassment],
    subjects: pairs(S.subjects), allies: pairs(S.allies), antiPiracy: pairs(S.antiPiracy), rivals: pairs(S.rivals), enemies: pairs(S.enemies),
    countries: [...S.countries.values()].map((c) => ({ ...c, advances: keep(c.advances, "advance"),
      policies: keep(c.policies, "policy"), reforms: keep(c.reforms, "reform"), income: r2(c.income) })),
  };
}

function fromSnapshot(j) {
  const n = PX.n;
  const owner = Int32Array.from(j.owner), tax = new Float64Array(n), ptax = new Float64Array(n), flow = new Float64Array(n);
  const rank = new Array(n).fill("");
  for (let p = 0; p < j.ports.length; p += 5) {
    const i = j.ports[p];
    tax[i] = j.ports[p + 1]; ptax[i] = j.ports[p + 2]; flow[i] = j.ports[p + 3]; rank[i] = j.ports[p + 4];
  }
  const presence = new Map();
  for (const [z, ...cp] of j.presence) {
    const m = new Map();
    for (let q = 0; q < cp.length; q += 2) m.set(cp[q], cp[q + 1]);
    presence.set(z, m);
  }
  const sets = (flat) => { const m = new Map(); for (let q = 0; q < flat.length; q += 2) (m.get(flat[q]) || m.set(flat[q], new Set()).get(flat[q])).add(flat[q + 1]); return m; };
  const subjects = sets(j.subjects), overlords = new Map();
  for (const [a, s] of subjects) for (const b of s) (overlords.get(b) || overlords.set(b, new Set()).get(b)).add(a);
  S = { owner, tax, ptax, flow, rank, blocked: new Set(j.blocked), presence, privateers: j.privateers, harassment: new Map(j.harassment),
    subjects, overlords, allies: sets(j.allies), antiPiracy: sets(j.antiPiracy), rivals: sets(j.rivals), enemies: sets(j.enemies),
    countries: new Map(j.countries.map((c) => [c.cid, c])), you: j.you, date: j.date, version: j.version, save: j.save };
  return { date: j.date, version: j.version, you: j.you, save: j.save, nations: j.nations, start: true };
}

let lastNations = null;
async function ensurePack() {
  const pack = await choosePack(null);
  if (!pack) throw new UserError("Couldn't load the built-in game data.");
  if (!D) {
    stage("Loading the map data…");
    const [r1, r2] = await Promise.all([fetch(new URL(pack.version + "/privateer.json", PACK_ROOT)),
      fetch(new URL(pack.version + "/proximity.json", PACK_ROOT))]);
    if (!r1.ok || !r2.ok) throw new UserError(`The ${pack.label} has no privateer data.`);
    D = await r1.json();
    PX = await r2.json();
    PP = M.prepare(D, PX);
  }
  return pack;
}

self.onmessage = async (e) => {
  const d = e.data;
  try {
    if (d.type === "analyze") { postMessage({ type: "analysis", req: d.req, data: analyze(d) }); return; }
    if (d.type === "calibrate") { postMessage({ type: "calibration", data: M.calibrate(S, d.obs) }); return; }
    if (d.type === "snapshot") { postMessage({ type: "snapshot", data: snapshot(lastNations) }); return; }
    const pack = await ensurePack();
    let data;
    if (d.type === "start") {
      stage("Loading the game-start view…");
      const r = await fetch(new URL(pack.version + "/privateer-start.json", PACK_ROOT));
      if (!r.ok) throw new UserError(`The ${pack.label} has no game-start view; drop a save instead.`);
      data = fromSnapshot(await r.json());
    } else {
      data = await loadSave(d.save);
      lastNations = data.nations;
    }
    data.kind = Array.from(PX.kind);
    data.areas = D.areas.map((a) => ({ key: a.key, name: a.name, zones: a.zones }));
    data.xy = PX.xy;
    data.names = PX.names;
    data.pack = { version: pack.version, name: pack.name || null, base: new URL(pack.version + "/", PACK_ROOT).href };
    if (data.version !== "?" && data.version !== pack.version) log(`save is ${data.version}; using ${pack.label}`);
    postMessage({ type: "loaded", data });
  } catch (err) {
    if (!(err instanceof UserError) && err && err.stack) log(err.stack);
    postMessage({ type: "error", code: err instanceof UserError ? err.code : "internal", message: err && err.message ? err.message : String(err) });
  }
};

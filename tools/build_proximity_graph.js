#!/usr/bin/env node
/* Builds gamedata/<version>/proximity.json - the location graph the
   placement page needs to work out proximity - from an EU5 install and the
   pack's own map.json.

     node tools/build_proximity_graph.js "<EU5 install>/game" 1.3.11

   What it holds (arrays are indexed by location id, 0 unused):
     adj    flat [a, b, ...] land/sea borders from locations.png, plus the
            sea crossings in adjacencies.csv
     river  flat [a, b, ...] pairs of locations a river runs between (rivers.png)
     port   flat [land, sea, ...] from ports.csv
     kind   0 land, 1 sea, 2 lake, 3 impassable (no pixels / wasteland)
     terr   proximity cost increase of leaving the location, from its
            topography + vegetation (e.g. mountains 0.5, forest 0.25)
     harbor natural harbour suitability
     xy     flat [x, y, ...] centroid in locations_half.png pixels
     consts the base proximity costs and sources, from the game files      */
"use strict";
const fs = require("fs"), path = require("path"), zlib = require("zlib");

const [game, version] = process.argv.slice(2);
if (!game || !version) {
  console.error('usage: node tools/build_proximity_graph.js "<EU5 install>/game" <version>');
  process.exit(1);
}
const packDir = path.join(__dirname, "..", "gamedata", version);
const mapd = path.join(game, "in_game", "map_data");
const read = (p) => fs.readFileSync(p, "utf8").replace(/^﻿/, "");

/* 8-bit RGB / RGBA / palette PNG -> {W, H, ch, px} (px holds palette indexes for ch=1) */
function decodePNG(buf) {
  let off = 8, W = 0, H = 0, ch = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      W = data.readUInt32BE(0); H = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error("unsupported PNG");
      ch = { 2: 3, 6: 4, 3: 1 }[data[9]];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = W * ch, out = Buffer.alloc(W * H * ch);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < H; y++) {
    const f = raw[y * (stride + 1)], cur = out.subarray(y * stride, (y + 1) * stride);
    raw.copy(cur, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      if (f === 1) cur[x] = (cur[x] + a) & 255;
      else if (f === 2) cur[x] = (cur[x] + b) & 255;
      else if (f === 3) cur[x] = (cur[x] + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        cur[x] = (cur[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    prev = cur;
  }
  return { W, H, ch, px: out };
}

const map = JSON.parse(read(path.join(packDir, "map.json")));
const N = map.locations.length;
const idOf = new Map(map.names.map((n, i) => [n, i]));
const lidOf = new Map();
map.locations.forEach((k, lid) => { if (k) lidOf.set(k, lid); });

// ---- terrain -------------------------------------------------------------
/* `<key> = { ... proximity = -0.5 ... }` -> key -> cost increase (0.5) */
function proximityImpacts(file) {
  const out = {};
  for (const m of read(file).replace(/#[^\n]*/g, "").matchAll(/^(\w+)\s*=\s*\{([\s\S]*?)^\}/gm)) {
    const p = m[2].match(/^\s*proximity\s*=\s*(-?[\d.]+)/m);
    out[m[1]] = p ? -parseFloat(p[1]) : 0;
  }
  return out;
}
const TOPO = proximityImpacts(path.join(game, "in_game/common/topography/00_default.txt"));
const VEG = proximityImpacts(path.join(game, "in_game/common/vegetation/00_default.txt"));
const WATER = new Set(["coastal_ocean", "ocean", "inland_sea", "deep_ocean", "narrows", "ocean_wasteland"]);
const LAKE = new Set(["lakes", "high_lakes"]);
const kind = new Array(N).fill(3), terr = new Array(N).fill(0), harbor = new Array(N).fill(0);
for (const m of read(path.join(mapd, "location_templates.txt")).matchAll(/^(\S+)\s*=\s*\{([^}]*)\}/gm)) {
  const i = idOf.get(m[1]);
  if (!i) continue;
  const o = {};
  for (const kv of m[2].matchAll(/(\w+)\s*=\s*(\S+)/g)) o[kv[1]] = kv[2];
  const t = o.topography || "";
  kind[i] = LAKE.has(t) ? 2 : WATER.has(t) ? 1 : /wasteland/.test(t) ? 3 : 0;
  terr[i] = +((TOPO[t] || 0) + (VEG[o.vegetation] || 0)).toFixed(3);
  harbor[i] = +(+o.natural_harbor_suitability || 0).toFixed(2);
}

// ---- borders and centroids -------------------------------------------------
console.log("reading locations.png…");
const L = decodePNG(fs.readFileSync(path.join(packDir, "locations.png")));
const W = L.W, H = L.H;
const ids = new Uint16Array(W * H);
for (let p = 0, q = 0; p < W * H; p++, q += L.ch) ids[p] = lidOf.get((L.px[q] << 16) | (L.px[q + 1] << 8) | L.px[q + 2]) || 0;
const cnt = new Float64Array(N), sx = new Float64Array(N), sy = new Float64Array(N);
const adj = new Set();
const key = (a, b) => (a < b ? a * 65536 + b : b * 65536 + a);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const p = y * W + x, a = ids[p];
    if (!a) continue;
    cnt[a]++; sx[a] += x; sy[a] += y;
    const r = ids[y * W + ((x + 1) % W)];   // the map wraps east-west
    if (r && r !== a) adj.add(key(a, r));
    if (y + 1 < H) { const d = ids[p + W]; if (d && d !== a) adj.add(key(a, d)); }
  }
}
for (const line of read(path.join(mapd, "adjacencies.csv")).split(/\r?\n/).slice(1)) {
  const [f, t] = line.split(";");
  const a = idOf.get(f), b = idOf.get(t);
  if (a && b) adj.add(key(a, b));
}
for (let i = 1; i < N; i++) if (!cnt[i]) kind[i] = 3;

// ---- rivers ------------------------------------------------------------------
// rivers.png is paletted: 254 is sea, 255 is land, anything lower is river.
console.log("reading rivers.png…");
const R = decodePNG(fs.readFileSync(path.join(mapd, "rivers.png")));
if (R.W !== W || R.H !== H || R.ch !== 1) throw new Error("rivers.png doesn't match locations.png");
const river = new Set();
for (let y = 0; y < H - 1; y++) {
  for (let x = 0; x < W; x++) {
    const p = y * W + x;
    if (R.px[p] >= 254) continue;
    for (const q of [p + 1, p + W, p + W + 1, p + W - 1]) {
      if (q % W === 0 && q !== p + W) continue;  // don't wrap rows
      if (R.px[q] < 254 && ids[p] && ids[q] && ids[p] !== ids[q]) river.add(key(ids[p], ids[q]));
    }
  }
}

// ---- ports -------------------------------------------------------------------
const port = [];
for (const line of read(path.join(mapd, "ports.csv")).split(/\r?\n/).slice(1)) {
  const [l, s] = line.split(";");
  const a = idOf.get(l), b = idOf.get(s);
  if (a && b) port.push(a, b);
}

// ---- base costs and sources from the game files ------------------------------
const auto = read(path.join(game, "in_game/common/auto_modifiers/country.txt"));
const val = (k, d) => { const m = auto.match(new RegExp("\\b" + k + "\\s*=\\s*(-?[\\d.]+)")); return m ? parseFloat(m[1]) : d; };
const roads = {};
for (const m of read(path.join(game, "in_game/common/road_types/00_generic.txt").replace(/#[^\n]*/g, ""))
  .matchAll(/^(\w+)\s*=\s*\{([\s\S]*?)^\}/gm)) {
  const p = m[2].match(/\bproximity\s*=\s*(-?[\d.]+)/);
  roads[m[1]] = p ? parseFloat(p[1]) : 0;
}
const caps = read(path.join(game, "in_game/common/building_types/capital_buildings.txt"));
const gov = caps.slice(caps.indexOf("\nlocal_governor = {"));
const govSource = parseFloat((gov.match(/local_proximity_source\s*=\s*([\d.]+)/) || [0, 80])[1]);
const consts = {
  land: val("land_cost_on_distance_from_capital", 40),
  road: val("road_cost_on_distance_from_capital", 20),
  sea: val("sea_cost_on_distance_from_capital", 30),
  maritime: val("sea_cost_on_distance_from_capital_when_maritime", 5),
  // Not the game's base values: ports and rivers were fitted to real saves
  // (see README, "Placement model"). port_cost_distance_from_capital is 40.
  port: 35, harborCut: 0.5, river: val("land_cost_going_downstream", 12),
  roads, capital: 100, governor: govSource,
  devCut: 0.004, devCap: 0.2, controlPerProximity: 0.0075,
};

// English display names ("" where the key is the name, capitalised)
const names = new Array(N).fill("");
const locDir = path.join(game, "main_menu/localization/english/location_names");
for (const fn of fs.existsSync(locDir) ? fs.readdirSync(locDir) : []) {
  for (const m of read(path.join(locDir, fn)).matchAll(/^\s*([\w-]+):\d*\s*"([^"]*)"/gm)) {
    const i = idOf.get(m[1]);
    if (i && !names[i]) names[i] = m[2];
  }
}

const xy = [];
for (let i = 0; i < N; i++) xy.push(cnt[i] ? Math.round(sx[i] / cnt[i] / 2) : 0, cnt[i] ? Math.round(sy[i] / cnt[i] / 2) : 0);
const flat = (set) => { const out = []; for (const k of set) out.push(Math.floor(k / 65536), k % 65536); return out; };
const out = { version, n: N, consts, names, kind, terr, harbor, xy, adj: flat(adj), river: flat(river), port };
fs.writeFileSync(path.join(packDir, "proximity.json"), JSON.stringify(out));
console.log(`proximity.json: ${N - 1} locations, ${adj.size} borders, ${river.size} river links, ${port.length / 2} ports`);

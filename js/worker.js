/* EU5 leaderboard - save processing, run in a Web Worker.
   A port of eu5_leaderboard.py: reads a debug-mode (plaintext) .eu5 save
   straight from the File the user picked, and - when the user has linked
   their EU5 install - renders coats of arms and the political map from the
   game's own files. Nothing is uploaded anywhere.

   in:  {save: File, game: GameSource|null, opts: {flags, map, top}}
   out: {type:"log"|"stage"|"done"|"error", ...}                        */
"use strict";
importScripts("dds.js");

const log = (msg) => postMessage({ type: "log", msg });
const stage = (msg) => postMessage({ type: "stage", msg });
/* overall build progress, 0..1 */
const progress = (value) => postMessage({ type: "progress", value });

// --------------------------------------------------------------------------
// tag -> display name. Best-effort, hand-checked; anything missing shows the
// raw tag.
// --------------------------------------------------------------------------
const NAMES = {
  FRA: "France", ENG: "England", GBR: "Great Britain", CAS: "Castile",
  ARA: "Aragon", SPA: "Spain", POR: "Portugal", MOS: "Muscovy",
  RUS: "Russia", NOV: "Novgorod", POL: "Poland", LIT: "Lithuania",
  PLC: "Poland-Lithuania", TEU: "Teutonic Order", LIV: "Livonian Order",
  HUN: "Hungary", BOH: "Bohemia", AUS: "Austria", HAB: "Habsburg",
  BAV: "Bavaria", BRA: "Brandenburg", PRU: "Prussia", SAX: "Saxony",
  SWE: "Sweden", DAN: "Denmark", NOR: "Norway", KAL: "Kalmar Union",
  SCO: "Scotland", IRE: "Ireland", NED: "Netherlands", BUR: "Burgundy",
  FLA: "Flanders", BRB: "Brabant", HOL: "Holland", MIL: "Milan",
  VEN: "Venice", GEN: "Genoa", FLO: "Florence", TUS: "Tuscany",
  PAP: "the Papal State", NAP: "Naples", SIC: "Sicily", SAV: "Savoy",
  BYZ: "Byzantium", OTT: "the Ottomans", TUR: "the Ottomans",
  MAM: "the Mamluks", TUN: "Tunis", MOR: "Morocco", TLC: "Tlemcen",
  TRP: "Tripoli", GRA: "Granada", SER: "Serbia", BUL: "Bulgaria",
  BOS: "Bosnia", CRO: "Croatia", WAL: "Wallachia", MOL: "Moldavia",
  ALB: "Albania", ATH: "Athens", EPI: "Epirus", TRE: "Trebizond",
  GLH: "the Golden Horde", CRI: "Crimea", KAZ: "Kazan", NOG: "Nogai",
  TIM: "the Timurids", PER: "Persia", QAR: "Qara Qoyunlu",
  AKK: "Aq Qoyunlu", JAL: "the Jalayirids", GEO: "Georgia",
  ARM: "Armenia", CYP: "Cyprus", HSA: "the Hansa", LUB: "Lubeck",
  SWI: "Switzerland", COL: "Cologne", MAI: "Mainz", TRI: "Trier",
  PAL: "the Palatinate", WUR: "Wurttemberg", HES: "Hesse",
  MEC: "Mecklenburg", POM: "Pomerania", SIL: "Silesia",
  DLH: "Delhi", BAH: "the Bahmanis", VIJ: "Vijayanagar",
  BEN: "Bengal", GUJ: "Gujarat", CHI: "China", ORI: "Orissa",
  KHM: "the Khmer", DAI: "Dai Viet", MAJ: "Majapahit", PEG: "Pegu",
  CHG: "Chagatai",
  JAP: "Japan", KOR: "Korea", ETH: "Ethiopia", MAL: "Mali",
  SON: "Songhai", KON: "Kongo", AZT: "the Aztecs", INC: "the Inca",
  MYA: "the Maya", ICE: "Iceland", FIN: "Finland", PSK: "Pskov",
  TVE: "Tver", RYA: "Ryazan", SMO: "Smolensk", KIE: "Kiev",
  ULM: "Ulm", NUR: "Nuremberg", AUG: "Augsburg", FRN: "Franconia",
  ANS: "Ansbach", BAD: "Baden", LOR: "Lorraine", PRO: "Provence",
  BRI: "Brittany", ORL: "Orleans", BOU: "Bourbonnais",
  NAV: "Navarra", LEO: "Leon", GAL: "Galicia", VAL: "Valencia",
};

// Fixed-point divisor for country script variables.
const VAR_SCALE = 100000.0;

// Age-of-traditions advances a country starts with when their
// starting_technology_level is at or below its own (1.3.11 values; the
// game's files replace this when an install is linked).
const STARTING_ADVANCES = {
  written_alphabet: 2, cultural_traditions_law_advance: 2, cultural_acceptance_advance: 3,
  codified_laws: 2, agriculture_advance: 1, alchemy_advance: 3, ranching: 1,
  horse_riding_advance: 1, trade_caravans: 1, mining_advance: 1, mining_law_advance: 1,
  iron_working: 1, ship_building_advance: 2, trade_advance_age_of_trad: 3,
  more_merchants_age_of_trad: 3, organized_religion: 4, castle_advance: 3,
  unlock_traditional_galley_advance: 2, unlock_cog_advance: 3, nomadic_tendencies: 4,
  three_sisters: 1, medicinal_infusions: 2, system_of_tributaries: 4, valley_irrigation: 4,
};

async function loadStartingAdvances(fs) {
  const dir = "in_game/common/advances";
  const names = await fs.list(dir);
  if (!names) return null;
  const out = {};
  for (const fn of pySort(names)) {
    if (!fn.endsWith(".txt")) continue;
    const txt = await fs.text(dir + "/" + fn);
    if (txt == null) continue;
    const clean = txt.replace(/#[^\n]*/g, "");
    for (const m of clean.matchAll(/^(\w+)\s*=\s*\{([\s\S]*?)^\}/gm)) {
      if (!/\bage\s*=\s*age_1_traditions\b/.test(m[2])) continue;
      const s = m[2].match(/\bstarting_technology_level\s*=\s*(\d+)/);
      if (s) out[m[1]] = parseInt(s[1], 10);
    }
  }
  return Object.keys(out).length ? out : null;
}

/* Advances gained since the start: everything researched, minus the ones a
   country of its starting technology level begins the game with. The save
   keeps no research dates, so this is the only baseline available. */
function attachAdvanceGains(rows, table) {
  for (const r of rows) {
    const done = r._researched, level = r._startLevel;
    delete r._researched;
    delete r._startLevel;
    if (!done || level == null) continue;
    const start = done.filter((a) => a in table && table[a] <= level).length;
    r.advances_start = start;
    r.advances_gained = done.length - start;
  }
}

// ==========================================================================
// Python-compatibility helpers
// ==========================================================================
const isDict = (x) => x instanceof Map;
const get = (d, k, dflt) => (isDict(d) && d.has(k) ? d.get(k) : dflt);
/* Python truthiness, for the many `x or default` idioms in the original. */
function truthy(x) {
  if (x == null || x === "" || x === 0 || x === false) return false;
  if (Array.isArray(x)) return x.length > 0;
  if (isDict(x)) return x.size > 0;
  return true;
}
const or = (x, d) => (truthy(x) ? x : d);
/* Python's round(): half to even. */
function pyRound(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : r;
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

class Counter extends Map {
  add(k, v) { this.set(k, (this.get(k) || 0) + v); }
  val(k) { return this.get(k) || 0; }
  total() { let s = 0; for (const v of this.values()) s += v; return s; }
}

// ==========================================================================
// Clausewitz plaintext parser (small chunks only). Blocks become Map (keyed,
// insertion-ordered, with bare items under "__items__") or Array (bare list).
// ==========================================================================
function parse(s) {
  const n = s.length;
  let i = 0;

  function skip() {
    while (i < n) {
      const c = s.charCodeAt(i);
      if (c === 32 || c === 9 || c === 13 || c === 10) i++;
      else if (c === 35) { while (i < n && s.charCodeAt(i) !== 10) i++; }
      else break;
    }
  }
  // tokens: "{" "}" "=" or a string value (typeof "string" with a marker)
  const OPEN = { t: "{" }, CLOSE = { t: "}" }, EQ = { t: "=" };
  function tok() {
    skip();
    if (i >= n) return null;
    const c = s[i];
    if (c === "{") { i++; return OPEN; }
    if (c === "}") { i++; return CLOSE; }
    if (c === "=") { i++; return EQ; }
    if (c === '"') {
      i++;
      let buf = "";
      let st = i;
      while (i < n) {
        const ch = s[i];
        if (ch === "\\") { buf += s.slice(st, i) + (s[i + 1] ?? ""); i += 2; st = i; }
        else if (ch === '"') { buf += s.slice(st, i); i++; st = -1; break; }
        else i++;
      }
      if (st !== -1) buf += s.slice(st, Math.min(i, n));
      return { t: "v", v: buf };
    }
    const st = i;
    while (i < n) {
      const ch = s.charCodeAt(i);
      if (ch === 32 || ch === 9 || ch === 13 || ch === 10 || ch === 61 || ch === 123 || ch === 125) break;
      i++;
    }
    return { t: "v", v: s.slice(st, i) };
  }
  function obj() {
    const d = new Map(), lst = [];
    for (;;) {
      const t = tok();
      if (t === null || t === CLOSE) break;
      if (t === OPEN) { lst.push(obj()); continue; }
      if (t === EQ) continue;
      const key = t.v;
      const save = i;
      const t2 = tok();
      if (t2 === null) { lst.push(key); break; }
      if (t2 === EQ) {
        const t3 = tok();
        if (t3 === null) throw new Error("unexpected end of block");
        let val;
        if (t3 === OPEN) val = obj();
        else if (t3.t === "v") val = t3.v;
        else throw new Error("unexpected token " + t3.t);
        if (d.has(key)) {
          const cur = d.get(key);
          if (Array.isArray(cur) && cur.__dup) cur.push(val);
          else { const arr = [cur, val]; arr.__dup = true; d.set(key, arr); }
        } else d.set(key, val);
      } else {
        lst.push(key);
        i = save;
      }
    }
    if (lst.length && !d.size) return lst;
    if (lst.length) d.set("__items__", lst);
    return d;
  }
  skip();
  if (i < n && s[i] === "{") i++;
  return obj();
}

function asList(x) {
  if (x == null) return [];
  if (Array.isArray(x)) return x;
  if (isDict(x)) return x.has("__items__") ? x.get("__items__") : [x];
  return [x];
}

function num(x, dflt = 0.0) {
  if (typeof x === "number") return x;
  if (typeof x !== "string") return dflt;
  const s = x.trim().replace(/_/g, "");
  if (!s) return dflt;
  const v = Number(s);
  if (Number.isNaN(v)) {
    const l = s.toLowerCase();
    if (l === "nan") return NaN;
    if (l === "inf" || l === "+inf" || l === "infinity") return Infinity;
    if (l === "-inf" || l === "-infinity") return -Infinity;
    return dflt;
  }
  return v;
}

// ==========================================================================
// Game files: a {relative path -> File} map from a folder <input>, with
// paths relative to the install's `game` folder.
// ==========================================================================
class GameFS {
  constructor(src) {
    this.files = src.files;
    this.label = src.label || "your EU5 install";
  }
  async file(rel) {
    return this.files.get(rel) || null;
  }
  async text(rel) {
    const f = await this.file(rel);
    if (!f) return null;
    const t = await f.text();
    return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
  }
  /* file names (not subfolders) directly inside rel, or null if missing */
  async list(rel) {
    const pre = rel.replace(/\/?$/, "/");
    let found = false;
    const out = [];
    for (const k of this.files.keys()) {
      if (!k.startsWith(pre)) continue;
      found = true;
      const rest = k.slice(pre.length);
      if (!rest.includes("/")) out.push(rest);
    }
    return found ? out : null;
  }
}
const pySort = (arr) => arr.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

// ==========================================================================
// Coat-of-arms rendering
//
// Channel conventions, measured against the shipped 1.3.11 textures:
//   patterns        R/G/B are full-intensity masks for colour1/2/3.
//   colored_emblems body is colour1; G blends toward colour2, R toward
//                   colour3. B sits at a constant ~0.5 in every emblem and
//                   carries no colour information.
// ==========================================================================
function hsvToRgb(h, s, v) {
  let r, g, b;
  if (s === 0) r = g = b = v;
  else {
    let i = Math.trunc(h * 6.0);
    const f = h * 6.0 - i;
    const p = v * (1.0 - s), q = v * (1.0 - s * f), t = v * (1.0 - s * (1.0 - f));
    i = ((i % 6) + 6) % 6;
    [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i];
  }
  return [pyRound(r * 255), pyRound(g * 255), pyRound(b * 255)];
}

function colorFrom(kind, body) {
  const parts = body.split(/\s+/).filter(Boolean);
  const vals = [];
  for (const p of parts) {
    const v = num(p, NaN);
    if (Number.isNaN(v)) return null;
    vals.push(v);
  }
  if (vals.length < 3) return null;
  if (kind === "rgb") return vals.slice(0, 3).map((v) => pyRound(v > 1 ? v : v * 255));
  if (kind === "hsv360") return hsvToRgb(vals[0] / 360.0, vals[1] / 100.0, vals[2] / 100.0);
  return hsvToRgb(vals[0], vals[1], vals[2]);
}

async function loadNamedColors(fs) {
  const out = new Map();
  const dir = "main_menu/common/named_colors";
  const names = await fs.list(dir);
  if (!names) return out;
  for (const fn of pySort(names)) {
    const txt = await fs.text(dir + "/" + fn);
    if (txt == null) continue;
    for (const m of txt.matchAll(/(\w+)\s*=\s*(rgb|hsv360|hsv)\s*\{([^}]*)\}/g)) {
      const c = colorFrom(m[2], m[3]);
      if (c) out.set(m[1], c);
    }
  }
  return out;
}

async function loadCoaDefs(fs) {
  const defs = new Map(), variables = new Map();
  const dir = "main_menu/common/coat_of_arms/coat_of_arms";
  const names = (await fs.list(dir)) || [];
  for (const fn of pySort(names)) {
    if (!fn.endsWith(".txt")) continue;
    let txt = await fs.text(dir + "/" + fn);
    if (txt == null) continue;
    for (const m of txt.matchAll(/^@(\w+)\s*=\s*([-\d.]+)/gm)) variables.set(m[1], m[2]);
    txt = txt.replace(/@(\w+)/g, (_, k) => (variables.has(k) ? variables.get(k) : "0"));
    const starts = [...txt.matchAll(/^(\w+)\s*=\s*\{/gm)].map((m) => [m[1], m.index + m[0].length]);
    for (let i = 0; i < starts.length; i++) {
      const [key, s0] = starts[i];
      const e = i + 1 < starts.length ? starts[i + 1][1] : txt.length;
      const chunk = txt.slice(s0, e);
      let depth = 1, j = 0, inq = false;
      while (j < chunk.length && depth > 0) {
        const c = chunk[j];
        if (inq) inq = c !== '"';
        else if (c === '"') inq = true;
        else if (c === "{") depth++;
        else if (c === "}") depth--;
        j++;
      }
      if (!defs.has(key)) defs.set(key, chunk.slice(0, Math.max(0, j - 1)));
    }
  }
  return defs;
}

function canvas(w, h) {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return [c, ctx];
}

/* float RGB (w*h*3) + float alpha (w*h) -> canvas, truncating like numpy */
function floatToCanvas(rgb, a, w, h) {
  const [c, ctx] = canvas(w, h);
  const id = ctx.createImageData(w, h);
  const d = id.data;
  for (let p = 0, q = 0; p < w * h; p++, q += 3) {
    d[p * 4] = Math.trunc(clamp01(rgb[q]) * 255);
    d[p * 4 + 1] = Math.trunc(clamp01(rgb[q + 1]) * 255);
    d[p * 4 + 2] = Math.trunc(clamp01(rgb[q + 2]) * 255);
    d[p * 4 + 3] = Math.trunc(clamp01(a[p]) * 255);
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

async function canvasToDataURI(c) {
  const blob = await c.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return "data:image/png;base64," + btoa(bin);
}

class FlagRenderer {
  constructor(fs) {
    this.fs = fs;
    this._tex = new Map();
  }
  async init() {
    this.colors = await loadNamedColors(this.fs);
    this.defs = await loadCoaDefs(this.fs);
  }
  /* -> {w, h, px: Uint8ClampedArray RGBA} or null */
  async tex(sub, name) {
    if (typeof name !== "string") throw new TypeError("bad texture name");
    const key = sub + "/" + name;
    if (!this._tex.has(key)) {
      let t = null;
      try {
        const f = name ? await this.fs.file("main_menu/gfx/coat_of_arms/" + key) : null;
        if (f) {
          const im = decodeDDS(await f.arrayBuffer());
          t = { w: im.width, h: im.height, px: im.data };
        }
      } catch (e) {
        t = null;
      }
      this._tex.set(key, t);
    }
    return this._tex.get(key);
  }
  _col(val, parent, dflt = [0, 0, 0]) {
    if (val == null) return dflt;
    if (typeof val !== "string") throw new TypeError("bad colour");
    if (/^color[1-5]$/.test(val)) return parent.has(val) ? parent.get(val) : dflt;
    return this.colors.get(val) || [128, 128, 128];
  }
  static over(rgb, alpha, srgb, sa) {
    for (let p = 0; p < alpha.length; p++) {
      const a = sa[p];
      rgb[p * 3] = srgb[p * 3] * a + rgb[p * 3] * (1 - a);
      rgb[p * 3 + 1] = srgb[p * 3 + 1] * a + rgb[p * 3 + 1] * (1 - a);
      rgb[p * 3 + 2] = srgb[p * 3 + 2] * a + rgb[p * 3 + 2] * (1 - a);
      alpha[p] = a + alpha[p] * (1 - a);
    }
  }
  /* Scale / flip / rotate an emblem and composite it at `pos`. Mirrors the
     PIL pipeline, including paste(im, box, mask=im) onto a transparent
     layer, which leaves the layer at rgb*a, alpha*a. */
  place(rgb, alpha, srgb, sa, sw0, sh0, pos, sc, rot, H, W) {
    const sw = Math.abs(sc[0]) * W, sh = Math.abs(sc[1]) * H;
    if (sw < 1 || sh < 1) return;
    const src = floatToCanvas(srgb, sa, sw0, sh0);
    const rw = Math.max(1, pyRound(sw)), rh = Math.max(1, pyRound(sh));
    const [c1, x1] = canvas(rw, rh);
    x1.translate(sc[0] < 0 ? rw : 0, sc[1] < 0 ? rh : 0);
    x1.scale(sc[0] < 0 ? -1 : 1, sc[1] < 0 ? -1 : 1);
    x1.drawImage(src, 0, 0, rw, rh);

    let img = c1, nw = rw, nh = rh;
    const ang = (((-rot) % 360) + 360) % 360;
    if (ang !== 0) {
      const r15 = (v) => Math.round(v * 1e15) / 1e15;
      const th = -ang * Math.PI / 180;
      const a = r15(Math.cos(th)), b = r15(Math.sin(th));
      const d = r15(-Math.sin(th)), e = r15(Math.cos(th));
      const cx = rw / 2, cy = rh / 2;
      const c = a * -cx + b * -cy + cx, f = d * -cx + e * -cy + cy;
      const xs = [], ys = [];
      for (const [x, y] of [[0, 0], [rw, 0], [rw, rh], [0, rh]]) {
        xs.push(a * x + b * y + c);
        ys.push(d * x + e * y + f);
      }
      nw = Math.ceil(Math.max(...xs)) - Math.floor(Math.min(...xs));
      nh = Math.ceil(Math.max(...ys)) - Math.floor(Math.min(...ys));
      const [c2, x2] = canvas(nw, nh);
      x2.translate(nw / 2, nh / 2);
      x2.rotate(ang === 90 || ang === 180 || ang === 270 ? -ang * Math.PI / 180 : th);
      x2.drawImage(c1, -rw / 2, -rh / 2);
      img = c2;
    }
    const [lc, lx] = canvas(W, H);
    lx.drawImage(img, pyRound(pos[0] * W - nw / 2), pyRound(pos[1] * H - nh / 2));
    const la = lx.getImageData(0, 0, W, H).data;
    const lrgb = new Float32Array(W * H * 3), laa = new Float32Array(W * H);
    for (let p = 0; p < W * H; p++) {
      const a = la[p * 4 + 3] / 255;
      lrgb[p * 3] = (la[p * 4] / 255) * a;
      lrgb[p * 3 + 1] = (la[p * 4 + 1] / 255) * a;
      lrgb[p * 3 + 2] = (la[p * 4 + 2] / 255) * a;
      laa[p] = a * a;
    }
    FlagRenderer.over(rgb, alpha, lrgb, laa);
  }
  async render(tag, H = 64, W = 96, depth = 0) {
    const body = this.defs.get(tag);
    if (body == null || depth > 3) return null;
    const d = parse("{" + body + "}");
    if (!isDict(d)) return null;
    const subs = asList(get(d, "sub"));
    if (subs.length && isDict(subs[0]) && truthy(get(subs[0], "parent"))) {
      const r = await this.render(get(subs[0], "parent"), H, W, depth + 1);
      if (r) return r;
    }
    const parent = new Map();
    for (let i = 1; i <= 5; i++) {
      const k = "color" + i;
      if (d.has(k)) {
        const v = d.get(k);
        if (typeof v !== "string") throw new TypeError("bad colour");
        parent.set(k, this.colors.get(v) || [128, 128, 128]);
      }
    }
    const rgb = new Float32Array(W * H * 3), alpha = new Float32Array(W * H);
    const pat = get(d, "pattern");
    if (truthy(pat)) {
      const t = await this.tex("patterns", pat);
      if (t) {
        const [pc, px] = canvas(W, H);
        const [sc0, sx0] = canvas(t.w, t.h);
        sx0.putImageData(new ImageData(new Uint8ClampedArray(t.px), t.w, t.h), 0, 0);
        px.drawImage(sc0, 0, 0, W, H);
        const tp = px.getImageData(0, 0, W, H).data;
        const c1 = parent.get("color1") || [128, 128, 128];
        const c2 = parent.get("color2") || [0, 0, 0];
        const c3 = parent.get("color3") || [0, 0, 0];
        const prgb = new Float32Array(W * H * 3), pa = new Float32Array(W * H);
        for (let p = 0; p < W * H; p++) {
          const r = tp[p * 4] / 255, g = tp[p * 4 + 1] / 255, b = tp[p * 4 + 2] / 255;
          const s = r + g + b;
          const on = s > 1e-4;
          const w0 = on ? r / s : 1, w1 = on ? g / s : 0, w2 = on ? b / s : 0;
          for (let k = 0; k < 3; k++)
            prgb[p * 3 + k] = clamp01(w0 * (c1[k] / 255) + w1 * (c2[k] / 255) + w2 * (c3[k] / 255));
          pa[p] = tp[p * 4 + 3] / 255;
        }
        FlagRenderer.over(rgb, alpha, prgb, pa);
      }
    }
    for (const [kind, folder] of [["colored_emblem", "colored_emblems"], ["textured_emblem", "textured_emblems"]]) {
      for (const em of asList(get(d, kind))) {
        if (!isDict(em)) continue;
        const t = await this.tex(folder, get(em, "texture", ""));
        if (!t) continue;
        const n = t.w * t.h;
        const ergb = new Float32Array(n * 3), ea = new Float32Array(n);
        if (kind === "colored_emblem") {
          const c1 = this._col(get(em, "color1"), parent);
          const c2 = this._col(get(em, "color2"), parent, c1);
          const c3 = this._col(get(em, "color3"), parent, c1);
          for (let p = 0; p < n; p++) {
            const r = t.px[p * 4] / 255, g = t.px[p * 4 + 1] / 255;
            for (let k = 0; k < 3; k++) {
              let v = (c1[k] / 255) * (1 - g) + (c2[k] / 255) * g;
              v = v * (1 - r) + (c3[k] / 255) * r;
              ergb[p * 3 + k] = clamp01(v);
            }
            ea[p] = t.px[p * 4 + 3] / 255;
          }
        } else {
          for (let p = 0; p < n; p++) {
            ergb[p * 3] = t.px[p * 4] / 255;
            ergb[p * 3 + 1] = t.px[p * 4 + 1] / 255;
            ergb[p * 3 + 2] = t.px[p * 4 + 2] / 255;
            ea[p] = t.px[p * 4 + 3] / 255;
          }
        }
        let insts = asList(get(em, "instance"));
        if (!insts.length) insts = [new Map()];
        for (let inst of insts) {
          if (!isDict(inst)) inst = new Map();
          const toF = (v) => {
            const x = num(v, NaN);
            if (Number.isNaN(x)) throw new TypeError("bad number");
            return x;
          };
          let pos = asList(get(inst, "position")).map(toF);
          let sc = asList(get(inst, "scale")).map(toF);
          const rr = asList(get(inst, "rotation"));
          const rot = rr.length ? toF(rr[0]) : 0.0;
          if (pos.length < 2) pos = [0.5, 0.5];
          if (sc.length < 2) sc = [1.0, 1.0];
          this.place(rgb, alpha, ergb, ea, t.w, t.h, pos, sc, rot, H, W);
        }
      }
    }
    // Final image drops alpha (PIL convert("RGB")), keeping the raw colour.
    const [oc, ox] = canvas(W, H);
    const id = ox.createImageData(W, H);
    for (let p = 0; p < W * H; p++) {
      id.data[p * 4] = Math.trunc(clamp01(rgb[p * 3]) * 255);
      id.data[p * 4 + 1] = Math.trunc(clamp01(rgb[p * 3 + 1]) * 255);
      id.data[p * 4 + 2] = Math.trunc(clamp01(rgb[p * 3 + 2]) * 255);
      id.data[p * 4 + 3] = 255;
    }
    ox.putImageData(id, 0, 0);
    return oc;
  }
  async dataURI(tag) {
    const c = await this.render(tag);
    return c ? canvasToDataURI(c) : null;
  }
}

async function attachFlags(rows, fs) {
  if (typeof OffscreenCanvas === "undefined") {
    log("flags: this browser can't draw off-screen - skipping");
    return 0;
  }
  const fr = new FlagRenderer(fs);
  await fr.init();
  if (!fr.defs.size) {
    log("flags: no coat-of-arms definitions found in " + fs.label + " - skipping");
    return 0;
  }
  let n = 0, done = 0;
  for (const r of rows) {
    progress(0.6 + 0.15 * (done++ / rows.length));
    let uri = null;
    try {
      uri = await fr.dataURI(r.tag);
    } catch (e) {
      uri = null;
    }
    if (uri) {
      r.flag = uri;
      n++;
    }
  }
  log(`flags: rendered ${n} of ${rows.length}`);
  return n;
}

// ==========================================================================
// Political map
// ==========================================================================
// The location numeric ID used by locations.locations.<id> in the save is
// the 1-based index of a depth-first walk of definitions.txt.
// named_locations/*.txt gives each named location's own flat display color;
// setup/countries/*.txt + named_colors gives each tag's in-game map color;
// location_templates.txt's topography field tells land from water.
const MAP_WATER_TOPO = new Set(["coastal_ocean", "ocean", "inland_sea", "deep_ocean", "lakes",
  "high_lakes", "ocean_wasteland", "narrows"]);
const MAP_BG = [235, 231, 220];     // water / unclassified
const MAP_LAND = [176, 172, 163];   // land not owned by a tracked nation
const hex = (c) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
const rgbKey = (c) => (c[0] << 16) | (c[1] << 8) | c[2];

async function mapLocationNames(fs, mapd) {
  const tree = parse(await fs.text(mapd + "/definitions.txt"));
  const names = [];
  function walk(node) {
    if (isDict(node)) {
      for (const [k, v] of node) {
        if (k === "__items__") {
          for (const item of v) typeof item === "string" ? names.push(item) : walk(item);
          continue;
        }
        if (Array.isArray(v)) {
          if (v.length && v.every((x) => typeof x === "string")) names.push(...v);
          else for (const item of v) walk(item);
        } else if (isDict(v)) walk(v);
        else if (typeof v === "string") names.push(v);
      }
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item);
    }
  }
  walk(tree);
  const out = new Map();
  names.forEach((nm, i) => out.set(i + 1, nm));
  return out;
}

async function mapLocationColors(fs, mapd) {
  const out = new Map();
  const dir = mapd + "/named_locations";
  const names = await fs.list(dir);
  if (!names) return out;
  for (const fn of pySort(names)) {
    if (!fn.endsWith(".txt")) continue;
    const txt = await fs.text(dir + "/" + fn);
    if (txt == null) continue;
    for (let line of txt.split(/\r\n|\r|\n/)) {
      line = line.split("#", 1)[0].trim();
      if (!line || !line.includes("=")) continue;
      const at = line.indexOf("=");
      const k = line.slice(0, at).trim();
      let v = line.slice(at + 1).trim();
      if (!/^[0-9a-fA-F]+$/.test(v)) continue;
      v = v.padStart(6, "0");
      out.set(k, [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]);
    }
  }
  return out;
}

async function mapTagSetup(fs, setupd) {
  const colornames = new Map(), color2 = new Map();
  const names = await fs.list(setupd);
  if (!names) return { colornames, color2 };
  for (const fn of pySort(names)) {
    if (!fn.endsWith(".txt")) continue;
    const txt = await fs.text(setupd + "/" + fn);
    if (txt == null) continue;
    for (const m of txt.matchAll(/^(\w+)\s*=\s*\{([\s\S]*?)^\}/gm)) {
      const [, tag, body] = m;
      const cm = body.match(/\bcolor\s*=\s*map_(\w+)/);
      if (cm) colornames.set(tag, cm[1]);
      const c2 = body.match(/\bcolor2\s*=\s*(rgb|hsv360|hsv)\s*\{([^}]*)\}/);
      if (c2) {
        const c = colorFrom(c2[1], c2[2]);
        if (c) color2.set(tag, c);
      }
    }
  }
  return { colornames, color2 };
}

function countryHeaderTags(ctext) {
  const idx = ctext.indexOf("database={");
  const header = idx !== -1 ? ctext.slice(0, idx) : ctext;
  const out = new Map();
  for (const m of header.matchAll(/\n\t\t(\d+)=([A-Za-z0-9_]+)/g)) out.set(m[1], m[2]);
  return out;
}

const MAP_VASSAL_RE = /dependency=\{\s*first=(\d+)\s*second=(\d+)\s*named_targets=\{\s*\{\s*flag="subject_type"\s*target=\{\s*type=subject_type\s*object=(\w+)/g;
const MAP_PU_RE = /scripted_mutual=\{\s*first=(\d+)\s*second=(\d+)\s*named_targets=\{\s*\{\s*flag="scripted_relation_type"\s*target=\{\s*type=relation_type\s*object=(\w+)/g;

/* subject country id -> [overlord tag, is_personal_union], for every
   dependency and personal union rooted at a tracked nation, walked
   transitively. is_personal_union is true only one direct PU hop from the
   root itself. */
async function mapSubjectOverlords(save, sections, cidToTag) {
  const out = new Map();
  if (!sections.has("diplomacy_manager")) return out;
  const dtext = await readSpan(save, ...sections.get("diplomacy_manager")[0]);
  const dep = new Map(), pu = new Map();
  const add = (m, a, b) => { if (!m.has(a)) m.set(a, new Set()); m.get(a).add(b); };
  for (const m of dtext.matchAll(MAP_VASSAL_RE)) add(dep, m[1], m[2]);
  for (const m of dtext.matchAll(MAP_PU_RE)) if (m[3] === "union_of_crowns_pact") add(pu, m[1], m[2]);

  for (const [rootCid, rootTag] of cidToTag) {
    const directPu = pu.get(rootCid) || new Set();
    const seen = new Set([rootCid]);
    let frontier = [rootCid];
    while (frontier.length) {
      const nxt = [];
      for (const cid of frontier) {
        for (const child of [...(dep.get(cid) || []), ...(pu.get(cid) || [])]) {
          if (seen.has(child)) continue;
          seen.add(child);
          if (!out.has(child)) out.set(child, [rootTag, directPu.has(child)]);
          nxt.push(child);
        }
      }
      frontier = nxt;
    }
  }
  return out;
}

/* Streaming decoder for an 8-bit, non-interlaced RGB/RGBA PNG. Calls
   onRow(y, row) with a Uint8Array of width*channels for every scanline,
   without ever holding the whole decoded image. */
async function decodePNGRows(file, onRow, onHeader) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!sig.every((v, i) => buf[i] === v)) throw new Error("not a PNG");
  let off = 8, width = 0, height = 0, ch = 0;
  const idat = [];
  while (off < buf.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = dv.getUint32(off + 8);
      height = dv.getUint32(off + 12);
      const depth = data[8], ctype = data[9], interlace = data[12];
      if (depth !== 8 || (ctype !== 2 && ctype !== 6) || interlace !== 0)
        throw new Error(`unsupported PNG layout (depth ${depth}, type ${ctype}, interlace ${interlace})`);
      ch = ctype === 2 ? 3 : 4;
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (onHeader) onHeader(width, height);
  const stream = new Blob(idat).stream().pipeThrough(new DecompressionStream("deflate"));
  const reader = stream.getReader();
  const stride = width * ch;
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  let filter = -1, fill = 0, y = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    let i = 0;
    while (i < value.length && y < height) {
      if (filter < 0) { filter = value[i++]; fill = 0; continue; }
      const take = Math.min(stride - fill, value.length - i);
      cur.set(value.subarray(i, i + take), fill);
      fill += take;
      i += take;
      if (fill < stride) break;
      switch (filter) {
        case 0: break;
        case 1: for (let x = ch; x < stride; x++) cur[x] = (cur[x] + cur[x - ch]) & 255; break;
        case 2: for (let x = 0; x < stride; x++) cur[x] = (cur[x] + prev[x]) & 255; break;
        case 3:
          for (let x = 0; x < stride; x++)
            cur[x] = (cur[x] + (((x >= ch ? cur[x - ch] : 0) + prev[x]) >> 1)) & 255;
          break;
        case 4:
          for (let x = 0; x < stride; x++) {
            const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
            const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
            cur[x] = (cur[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
          }
          break;
        default: throw new Error("bad PNG filter " + filter);
      }
      onRow(y, cur, ch);
      [prev, cur] = [cur, prev];
      y++;
      filter = -1;
    }
  }
  if (y < height) throw new Error("PNG ended early");
  return { width, height };
}

/* PIL-style resampling coefficients (ImagingResample precompute_coeffs). */
function lanczos(x) {
  const sinc = (v) => (v === 0 ? 1 : Math.sin(Math.PI * v) / (Math.PI * v));
  return x > -3 && x < 3 ? sinc(x) * sinc(x / 3) : 0;
}
function resampleCoeffs(inSize, outSize) {
  const scale = inSize / outSize;
  const filterscale = Math.max(scale, 1);
  const support = 3 * filterscale;
  const out = [];
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    const xmin = Math.max(0, Math.trunc(center - support + 0.5));
    const xmax = Math.min(inSize, Math.trunc(center + support + 0.5));
    const w = [];
    let ww = 0;
    for (let x = 0; x < xmax - xmin; x++) {
      const v = lanczos((x + xmin - center + 0.5) / filterscale);
      w.push(v);
      ww += v;
    }
    out.push({ min: xmin, w: new Float64Array(w.map((v) => (ww ? v / ww : v))) });
  }
  return out;
}
const clip8 = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

async function buildMapData(data, sections, save, fs) {
  const t0 = performance.now();
  const mapd = "in_game/map_data", setupd = "in_game/setup/countries";
  const locFile = await fs.file(mapd + "/locations.png");
  if (!(await fs.file(mapd + "/definitions.txt")) || !locFile) {
    log("map: map_data not found in " + fs.label + " - skipping");
    return null;
  }
  if (!sections.has("locations")) {
    log("map: save has no locations section - skipping");
    return null;
  }
  if (typeof DecompressionStream === "undefined" || typeof OffscreenCanvas === "undefined") {
    log("map: this browser is missing DecompressionStream/OffscreenCanvas - skipping");
    return null;
  }

  const idToName = await mapLocationNames(fs, mapd);
  const nameToRgb = await mapLocationColors(fs, mapd);
  const { colornames: tagToColorname, color2: tagColor2 } = await mapTagSetup(fs, setupd);
  const namedColors = await loadNamedColors(fs);

  const rows = data.rows;
  const cidToTag = new Map(rows.map((r) => [r.id, r.tag]));
  const tagRgb = new Map();
  for (const r of rows) {
    // The game's setup colour, else the colour the save itself records
    // (covers tags formed or released mid-game).
    const cn = tagToColorname.get(r.tag);
    let rgb = cn ? namedColors.get("map_" + cn) || null : null;
    if (!rgb && r.color) rgb = [1, 3, 5].map((i) => parseInt(r.color.slice(i, i + 2), 16));
    tagRgb.set(r.tag, rgb);
  }

  let ltext = await readSpan(save, ...sections.get("locations")[0]);
  const locOwner = new Map();
  for (const part of ltext.split(/\n\t\t(?=\d+=\{)/)) {
    const idm = part.match(/^(\d+)=\{/);
    if (!idm) continue;
    const o = part.match(/\n\t\t\towner=(\d+)/);
    if (o) locOwner.set(parseInt(idm[1], 10), o[1]);
  }
  ltext = null;

  const subjectOverlord = await mapSubjectOverlords(save, sections, cidToTag);
  const allCidToTag = countryHeaderTags(await readSpan(save, ...sections.get("countries")[0]));

  // Per source colour: [rgb, isSubject, secondaryRgb]. Anything absent is
  // background (water / unclassified).
  const WHITE = [255, 255, 255];
  const state = new Map();
  const topo = await fs.text(mapd + "/location_templates.txt");
  if (topo != null) {
    for (const m of topo.matchAll(/(\S+)\s*=\s*\{[^}]*?topography\s*=\s*(\w+)/g)) {
      if (MAP_WATER_TOPO.has(m[2])) continue;
      const rgb = nameToRgb.get(m[1]);
      if (rgb) state.set(rgbKey(rgb), [MAP_LAND, false, WHITE]);
    }
  }
  const at = (k) => state.get(k) || [MAP_BG, false, WHITE];

  let nOver = 0;
  for (const [lid, cid] of locOwner) {
    const tag = cidToTag.get(cid);
    const rgb = tag ? tagRgb.get(tag) : null;
    if (!rgb) continue;
    const name = idToName.get(lid);
    const src = name ? nameToRgb.get(name) : null;
    if (!src) continue;
    const k = rgbKey(src);
    const s = at(k);
    state.set(k, [rgb, s[1], s[2]]);
    nOver++;
  }
  if (nOver === 0) {
    log("map: no owned locations could be resolved to a color - skipping");
    return null;
  }

  let nSubj = 0, nPuSecondary = 0;
  for (const [lid, cid] of locOwner) {
    const ov = subjectOverlord.get(cid);
    if (!ov) continue;
    const [ovTag, isPu] = ov;
    const rgb = tagRgb.get(ovTag);
    if (!rgb) continue;
    const name = idToName.get(lid);
    const src = name ? nameToRgb.get(name) : null;
    if (!src) continue;
    const k = rgbKey(src);
    const s = at(k);
    let sec = s[2];
    if (isPu) {
      const ownTag = allCidToTag.get(cid);
      const ownC2 = ownTag ? tagColor2.get(ownTag) : null;
      if (ownC2) {
        sec = ownC2;
        nPuSecondary++;
      }
    }
    state.set(k, [rgb, true, sec]);
    nSubj++;
  }

  // Collapse to a small palette; class 0 is background.
  const playerColors = new Set();
  for (const v of tagRgb.values()) if (v) playerColors.add(rgbKey(v));
  const palette = [[MAP_BG, false, WHITE]];
  const palIndex = new Map([[`${rgbKey(MAP_BG)}|0|${rgbKey(WHITE)}`, 0]]);
  const lut = new Uint16Array(1 << 24);
  for (const [k, s] of state) {
    const pk = `${rgbKey(s[0])}|${s[1] ? 1 : 0}|${rgbKey(s[2])}`;
    let idx = palIndex.get(pk);
    if (idx === undefined) {
      idx = palette.length;
      palette.push(s);
      palIndex.set(pk, idx);
    }
    lut[k] = idx;
  }
  const nPal = palette.length;
  const tracked = new Uint8Array(nPal);
  palette.forEach((s, i) => { tracked[i] = playerColors.has(rgbKey(s[0])) ? 1 : 0; });

  // One streaming pass over locations.png: classify every pixel and find the
  // bounding box of tracked territory.
  stage("Painting the map…");
  let cls = null, W0 = 0;
  let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
  const onHeader = (w, h) => {
    W0 = w;
    fullRows = h;
    cls = nPal <= 256 ? new Uint8Array(w * h) : new Uint16Array(w * h);
  };
  let fullRows = 1;
  const { width: fullW, height: fullH } = await decodePNGRows(locFile, (y, row, ch) => {
    if ((y & 255) === 0) progress(0.78 + 0.17 * (y / fullRows));
    const w = W0;
    const base = y * w;
    let first = -1, last = -1;
    for (let x = 0, q = 0; x < w; x++, q += ch) {
      const c = lut[(row[q] << 16) | (row[q + 1] << 8) | row[q + 2]];
      cls[base + x] = c;
      if (tracked[c]) {
        if (first < 0) first = x;
        last = x;
      }
    }
    if (first >= 0) {
      if (first < minX) minX = first;
      if (last > maxX) maxX = last;
      if (y < minY) minY = y;
      maxY = y;
    }
  }, onHeader);
  if (maxX < 0) {
    log("map: no colored pixels after recoloring - skipping");
    return null;
  }

  const padX = Math.trunc((maxX - minX) * 0.14), padY = Math.trunc((maxY - minY) * 0.14);
  const x0 = Math.max(0, minX - padX), x1 = Math.min(fullW, maxX + padX);
  const y0 = Math.max(0, minY - padY), y1 = Math.min(fullH, maxY + padY);
  const cw = x1 - x0, chh = y1 - y0;
  const targetW = 1900;
  let tw = cw, th = chh;
  if (cw > targetW) {
    tw = targetW;
    th = pyRound(chh * targetW / cw);
  }

  // Lanczos resize (horizontal pass into uint8, then vertical), like PIL.
  progress(0.95);
  const out = new Uint8ClampedArray(tw * th * 4);
  const hc = resampleCoeffs(cw, tw), vc = resampleCoeffs(chh, th);
  const hRows = new Map();
  const hRow = (sy) => {
    let r = hRows.get(sy);
    if (r) return r;
    r = new Uint8Array(tw * 3);
    const base = (y0 + sy) * W0 + x0;
    for (let ox = 0; ox < tw; ox++) {
      const { min, w } = hc[ox];
      let sr = 0, sg = 0, sb = 0;
      for (let j = 0; j < w.length; j++) {
        const c = palette[cls[base + min + j]][0];
        sr += c[0] * w[j]; sg += c[1] * w[j]; sb += c[2] * w[j];
      }
      r[ox * 3] = clip8(sr); r[ox * 3 + 1] = clip8(sg); r[ox * 3 + 2] = clip8(sb);
    }
    hRows.set(sy, r);
    return r;
  };
  for (let oy = 0; oy < th; oy++) {
    const { min, w } = vc[oy];
    for (const k of hRows.keys()) if (k < min) hRows.delete(k);
    const acc = new Float64Array(tw * 3);
    for (let j = 0; j < w.length; j++) {
      const r = hRow(min + j), wj = w[j];
      for (let q = 0; q < tw * 3; q++) acc[q] += r[q] * wj;
    }
    for (let ox = 0; ox < tw; ox++) {
      const o = (oy * tw + ox) * 4;
      out[o] = clip8(acc[ox * 3]); out[o + 1] = clip8(acc[ox * 3 + 1]);
      out[o + 2] = clip8(acc[ox * 3 + 2]); out[o + 3] = 255;
    }
  }

  // Hatch dependency / personal-union territory with a diagonal stripe,
  // sampled from the full-res classes with nearest-neighbour.
  if (nSubj) {
    for (let oy = 0; oy < th; oy++) {
      const sy = y0 + Math.min(chh - 1, Math.floor((oy + 0.5) * chh / th));
      for (let ox = 0; ox < tw; ox++) {
        const sx = x0 + Math.min(cw - 1, Math.floor((ox + 0.5) * cw / tw));
        const s = palette[cls[sy * W0 + sx]];
        if (!s[1]) continue;
        if ((((Math.floor((ox - oy) / 5) % 2) + 2) % 2) !== 0) continue;
        const o = (oy * tw + ox) * 4;
        for (let k = 0; k < 3; k++)
          out[o + k] = Math.trunc(Math.fround(out[o + k] * 0.45 + s[2][k] * 0.55));
      }
    }
  }
  cls = null;

  const [oc, ox] = canvas(tw, th);
  ox.putImageData(new ImageData(out, tw, th), 0, 0);
  const uri = await canvasToDataURI(oc);

  const legend = [];
  for (const r of rows) {
    const rgb = tagRgb.get(r.tag);
    if (!rgb) continue;
    legend.push({
      tag: r.tag, name: r.name, player: r.player, is_player: r.is_player,
      color: hex(rgb), locations: r.locations,
    });
  }
  log(`map: rendered ${tw}x${th}, ${legend.length}/${rows.length} nations placed, ` +
      `${nSubj} subject locations hatched (${nPuSecondary} with a personal-union ` +
      `secondary color) (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
  return { image: uri, legend, has_subjects: nSubj > 0, bg: hex(MAP_BG), land: hex(MAP_LAND) };
}

// ==========================================================================
// Save file handling
// ==========================================================================
async function checkPlaintext(save) {
  const head = new Uint8Array(await save.slice(0, 32).arrayBuffer());
  const txt = String.fromCharCode(...head);
  if (!txt.startsWith("SAV")) throw new UserError(`${save.name} does not look like an EU5 save.`);
  if (txt.slice(5, 7) !== "00") {
    throw new UserError(
      `${save.name} is a packed save (header ${txt.slice(0, 9)}), and only debug-mode ` +
      "plaintext saves can be read. See “Making a readable save” below.", "packed");
  }
}
class UserError extends Error {
  constructor(msg, code) { super(msg); this.code = code || "user"; }
}

const isKeyStart = (b) => b >= 97 && b <= 122;
const isKeyChar = (b) => (b >= 97 && b <= 122) || (b >= 48 && b <= 57) || b === 95;
const isSpace = (b) => b === 32 || b === 9 || b === 13 || b === 11 || b === 12;

/* One pass over the file. Returns Map name -> [[start, end], ...] of byte
   offsets for every top-level `name={` block. */
async function scanSections(save) {
  const size = save.size;
  const CH = 64 << 20, WIN = 512;
  const marks = [];
  const test = (u8, i, atEof) => {
    if (!isKeyStart(u8[i])) return null;
    let j = i + 1;
    while (j < u8.length && isKeyChar(u8[j])) j++;
    if (u8[j] !== 61 || u8[j + 1] !== 123) return null;
    let k = j + 2;
    while (k < u8.length && isSpace(u8[k])) k++;
    if (k < u8.length ? u8[k] !== 10 : !atEof) return null;
    return String.fromCharCode(...u8.subarray(i, j));
  };
  const check = async (u8, i, abs) => {
    if (!isKeyStart(u8[i])) return;
    let name;
    if (i + WIN <= u8.length) name = test(u8, i, false);
    else {
      const w = new Uint8Array(await save.slice(abs, Math.min(size, abs + WIN)).arrayBuffer());
      name = test(w, 0, abs + w.length >= size);
    }
    if (name) marks.push([name, abs]);
  };
  let lineStart = true;
  for (let base = 0; base < size; base += CH) {
    const u8 = new Uint8Array(await save.slice(base, Math.min(size, base + CH)).arrayBuffer());
    if (lineStart) await check(u8, 0, base);
    let p = 0;
    for (;;) {
      const nl = u8.indexOf(10, p);
      if (nl < 0) break;
      p = nl + 1;
      if (p < u8.length) await check(u8, p, base + p);
    }
    lineStart = u8[u8.length - 1] === 10;
    const frac = Math.min(1, (base + CH) / size);
    stage(`Reading the save… ${Math.round(frac * 100)}%`);
    progress(0.35 * frac);
  }
  const out = new Map();
  marks.forEach(([name, start], idx) => {
    const end = idx + 1 < marks.length ? marks[idx + 1][1] : size;
    if (!out.has(name)) out.set(name, []);
    out.get(name).push([start, end]);
  });
  return out;
}

const readSpan = (save, start, end) => save.slice(start, end).text();

/* Split `<openKey>={ <id>={...} ... }` into Map id -> chunk text. */
function splitEntries(text, openKey) {
  let i = text.indexOf(openKey + "={");
  if (i < 0) return new Map();
  i += openKey.length + 2;
  const n = text.length;
  let depth = 1, inq = false, esc = false;
  const out = new Map();
  let cur = null, start = 0;
  const WS = (c) => c === 32 || c === 9 || c === 13 || c === 10;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (inq) {
      if (esc) esc = false;
      else if (c === 92) esc = true;
      else if (c === 34) inq = false;
      i++;
      continue;
    }
    if (c === 34) { inq = true; i++; continue; }
    if (c === 123) {
      if (depth === 1) {
        let j = i - 1;
        while (j > 0 && WS(text.charCodeAt(j))) j--;
        if (text[j] === "=") {
          let k = j - 1;
          while (k >= 0 && !(WS(text.charCodeAt(k)) || text[k] === "{" || text[k] === "}")) k--;
          cur = text.slice(k + 1, j);
          start = i + 1;
        }
      }
      depth++;
    } else if (c === 125) {
      depth--;
      if (depth === 1 && cur !== null) {
        out.set(cur, text.slice(start, i));
        cur = null;
      }
      if (depth === 0) break;
    }
    i++;
  }
  return out;
}

// ==========================================================================
// Extraction
// ==========================================================================
async function extract(save, sections, topAi = 0) {
  // ---- metadata: who is the local player -------------------------------
  const metaTxt = (await readSpan(save, ...sections.get("metadata")[0])).slice(0, 200000);
  let m = metaTxt.match(/flag="([A-Z0-9]{2,3})=\{/);
  const youTag = m ? m[1] : null;
  const date = (metaTxt.match(/\n\tdate=([\d.]+)/) || [null, "?"])[1];
  const version = (metaTxt.match(/\n\tversion="([^"]+)"/) || [null, "?"])[1];
  const playthrough = (metaTxt.match(/\n\tplaythrough_id="([^"]+)"/) || [null, null])[1];
  const mp = metaTxt.includes("multiplayer=yes");

  // ---- players ---------------------------------------------------------
  const players = new Map();
  for (const [start, end] of sections.get("played_country") || []) {
    const t = await readSpan(save, start, end);
    const cid = t.match(/\n\tcountry=(\d+)/);
    const nm = t.match(/\n\tname="([^"]*)"/);
    if (cid && !players.has(cid[1])) players.set(cid[1], nm ? nm[1] : "player");
  }

  // ---- countries -------------------------------------------------------
  stage("Reading countries…");
  progress(0.36);
  let ctext = await readSpan(save, ...sections.get("countries")[0]);
  const dbAt = ctext.indexOf("database={");
  if (dbAt < 0) throw new UserError("The save's countries section has no database.");
  const tags = new Map();
  for (const mm of ctext.slice(0, dbAt).matchAll(/\n\t\t(\d+)=([A-Za-z0-9_]+)/g)) tags.set(mm[1], mm[2]);
  let chunks = splitEntries(ctext, "database");
  ctext = null;

  const KEEP = ("country_type great_power_rank great_power_points capital " +
    "last_months_population last_months_tax_income last_months_subject_tax " +
    "last_months_foreign_building_income monthly_trade_balance " +
    "monthly_trade_value last_month_gold_income " +
    "total_produced max_manpower max_sailors researched_advances starting_technology_level").split(" ");
  const BLK = ("score currency_data economy counters last_month_produced historical_population " +
    "historical_tax_base historical_economical_base owned_locations provinces " +
    "variables").split(" ");

  const countries = new Map();
  for (const [cid, chunk] of chunks) {
    let d;
    try {
      d = parse(chunk);
    } catch (e) {
      continue;
    }
    if (!isDict(d)) continue;
    const r = new Map([["id", cid], ["tag", tags.get(cid) || "?"]]);
    // The country's current map colour, e.g. `color=rgb { 104 107 106 }`.
    const cm = chunk.match(/\n\tcolor=(rgb|hsv360|hsv)\s*\{([^}]*)\}/);
    const rgb = cm ? colorFrom(cm[1], cm[2]) : null;
    if (rgb) r.set("color", hex(rgb));
    for (const k of KEEP) if (d.has(k)) r.set(k, d.get(k));
    for (const k of BLK) if (d.has(k)) r.set(k, d.get(k));
    r.set("n_owned", asList(r.get("owned_locations")).length);
    r.set("n_prov", asList(r.get("provinces")).length);
    r.delete("owned_locations");
    r.delete("provinces");
    const v = r.get("variables");
    r.delete("variables");
    r.set("kills", 0.0);
    if (isDict(v)) {
      for (const it of asList(get(v, "data"))) {
        if (isDict(it) && get(it, "flag") === "land_units_killed")
          r.set("kills", num(get(or(get(it, "data"), new Map()), "identity")) / VAR_SCALE);
      }
    }
    countries.set(cid, r);
  }
  chunks = null;

  // ---- locations: raw materials, development, tax ----------------------
  stage("Reading locations…");
  progress(0.5);
  const own = new Counter();
  const raw = new Map();
  const dev = new Counter(), tax = new Counter(), ptax = new Counter();
  const ctlSum = new Counter(), ctlWsum = new Counter();
  if (sections.has("locations")) {
    let ltext = await readSpan(save, ...sections.get("locations")[0]);
    for (const part of ltext.split(/\n\t\t(?=\d+=\{)/)) {
      const o = part.match(/\n\t\t\towner=(\d+)/);
      if (!o) continue;
      const cid = o[1];
      own.add(cid, 1);
      const g = part.match(/\n\t\t\traw_material=(\w+)/);
      if (g) {
        if (!raw.has(cid)) raw.set(cid, new Counter());
        raw.get(cid).add(g[1], 1);
      }
      const dv = part.match(/\n\t\t\tdevelopment=([\d.]+)/);
      if (dv) dev.add(cid, parseFloat(dv[1]));
      const tx = part.match(/\n\t\t\ttax=([\d.]+)/);
      if (tx) tax.add(cid, parseFloat(tx[1]));
      const pt = part.match(/\n\t\t\tpossible_tax=([\d.]+)/);
      if (pt) ptax.add(cid, parseFloat(pt[1]));
      const ct = part.match(/\n\t\t\tcontrol=([\d.]+)/);
      if (ct) {
        ctlSum.add(cid, parseFloat(ct[1]));
        if (dv) ctlWsum.add(cid, parseFloat(ct[1]) * parseFloat(dv[1]));
      }
    }
    ltext = null;
  }

  // ---- subunits: standing army / navy ----------------------------------
  stage("Counting armies…");
  progress(0.55);
  const army = new Counter(), levies = new Counter(), regulars = new Counter();
  const mercs = new Counter(), navy = new Counter(), subs = new Counter();

  // Units belonging to a hired mercenary company. Available companies live
  // under mercenary_manager.pool; hired ones get a record in its database.
  const mercUnits = new Set();
  if (sections.has("mercenary_manager")) {
    const mtext = await readSpan(save, ...sections.get("mercenary_manager")[0]);
    const pAt = mtext.indexOf("\n\tpool={");
    const head = pAt >= 0 ? mtext.slice(0, pAt) : mtext;
    for (const ent of head.split(/\n(?=\d+=)/)) {
      if (ent.split("\n", 1)[0].includes("=none")) continue;
      for (const mm of ent.matchAll(/\b(?:unit|army|navy)=(\d+)/g)) mercUnits.add(mm[1]);
    }
  }

  if (sections.has("subunit_manager")) {
    const stext = await readSpan(save, ...sections.get("subunit_manager")[0]);
    for (const part of stext.split(/\n(?=\d+=\{)/)) {
      const o = part.match(/\n\towner=(\d+)/);
      const t = part.match(/\n\ttype=(\w+)/);
      if (!(o && t)) continue;
      const st = part.match(/\n\tstrength=([\d.]+)/);
      // strength=1 is never written: a missing value is a full-strength unit.
      const v = st ? parseFloat(st[1]) : 1.0;
      const cid = o[1];
      subs.add(cid, 1);
      if (t[1].startsWith("n_")) {
        navy.add(cid, v);
        continue;
      }
      army.add(cid, v);
      const u = part.match(/\n\tunit=(\d+)/);
      if (u && mercUnits.has(u[1])) mercs.add(cid, v);
      else if (part.includes("\n\tlevies=")) levies.add(cid, v);
      else regulars.add(cid, v);
    }
  }

  // ---- wars in progress: per-country losses ----------------------------
  const lost = new Map();
  let nWars = 0;
  if (sections.has("war_manager")) {
    const wtext = await readSpan(save, ...sections.get("war_manager")[0]);
    for (const mm of wtext.matchAll(/\n(\d+)=\{/g)) {
      const s = mm.index + mm[0].length;
      const nxt = wtext.indexOf("\n}", s);
      const body = wtext.slice(s, nxt > 0 ? nxt : wtext.length);
      if (!body.includes("all_history")) continue;
      let w;
      try {
        w = parse("{" + body);
      } catch (e) {
        continue;
      }
      if (!isDict(w) || !w.has("all")) continue;
      nWars++;
      for (const p of asList(w.get("all"))) {
        if (!isDict(p)) continue;
        const cid = get(p, "country");
        for (const h of asList(get(p, "all_history"))) {
          if (!isDict(h)) continue;
          let L = or(get(or(get(or(get(h, "joined"), new Map()), "losses"), new Map()), "losses"), new Map());
          if (!isDict(L)) continue;
          for (const [, vv] of L) {
            if (!isDict(vv)) continue;
            if (!lost.has(cid)) lost.set(cid, new Counter());
            for (const [cause, nn] of vv) lost.get(cid).add(cause, num(nn));
          }
        }
      }
    }
  }

  // ---- assemble rows ---------------------------------------------------
  const C = (cid) => countries.get(cid) || new Map();
  const cget = (c, k) => get(c, k);
  const dictOr = (x) => (isDict(x) && x.size ? x : new Map());
  function metric(cid, which) {
    const c = C(cid);
    const cd = dictOr(cget(c, "currency_data"));
    const ec = dictOr(cget(c, "economy"));
    switch (which) {
      case "pop": return num(cget(c, "last_months_population"));
      case "gold": return num(get(cd, "gold"));
      case "taxbase": return tax.val(cid);
      case "wealth": return ptax.val(cid);
      case "control": return own.val(cid) ? ctlSum.val(cid) / own.val(cid) : 0.0;
      case "dev": return dev.val(cid);
      case "econbase": {
        const h = or(cget(c, "historical_economical_base"), [0]);
        return num(Array.isArray(h) ? h[h.length - 1] : typeof h === "string" ? h[h.length - 1] : 0);
      }
      case "income": return num(get(ec, "income"));
      case "locations": return cget(c, "n_owned") || 0;
      case "produced": return num(cget(c, "total_produced"));
      case "trade": return num(cget(c, "monthly_trade_value"));
      case "army": return army.val(cid);
      case "levies": return levies.val(cid);
      case "regulars": return regulars.val(cid);
      case "mercs": return mercs.val(cid);
      case "kills": return cget(c, "kills") || 0;
    }
    throw new Error("unknown metric " + which);
  }

  const METRICS = ["pop", "gold", "taxbase", "wealth", "control", "dev", "econbase",
    "income", "locations", "produced", "trade", "army", "levies",
    "regulars", "mercs", "kills"];
  const live = [...countries.values()].filter(
    (c) => get(c, "country_type") === "Real" && num(get(c, "last_months_population")) > 0);
  const ranks = {};
  for (const mname of METRICS) {
    const vals = new Map(live.map((c) => [c.get("id"), metric(c.get("id"), mname)]));
    const order = [...live].sort((a, b) => vals.get(b.get("id")) - vals.get(a.get("id")));
    ranks[mname] = new Map(order.map((c, i) => [c.get("id"), i + 1]));
  }

  let chosen = [...players.keys()];
  if (topAi) {
    const devs = new Map(live.map((c) => [c.get("id"), metric(c.get("id"), "dev")]));
    const extra = [...live].sort((a, b) => devs.get(b.get("id")) - devs.get(a.get("id")))
      .map((c) => c.get("id")).filter((id) => !players.has(id)).slice(0, topAi);
    chosen = chosen.concat(extra);
  }

  const toObj = (d, f) => {
    const o = {};
    if (isDict(d)) for (const [k, v] of d) o[k] = f(v);
    return o;
  };
  const rows = [];
  for (const cid of chosen) {
    const c = countries.get(cid);
    if (!c) continue;
    const cd = dictOr(get(c, "currency_data"));
    const ec = dictOr(get(c, "economy"));
    const ct = dictOr(get(c, "counters"));
    const sc = dictOr(get(dictOr(get(c, "score")), "score_rating"));
    const wl = lost.get(cid) || new Counter();
    const tag = c.get("tag");
    let ph = asList(get(c, "historical_population")).map((x) => num(x));
    if (!ph.length) ph = [metric(cid, "pop")];
    const rk = {};
    for (const mname of METRICS) rk[mname] = ranks[mname].has(cid) ? ranks[mname].get(cid) : null;
    rows.push({
      id: cid, tag, name: NAMES[tag] || tag, color: get(c, "color") || null,
      player: players.has(cid) ? players.get(cid) : "AI", is_player: players.has(cid),
      pop: metric(cid, "pop"), gold: metric(cid, "gold"),
      taxbase: metric(cid, "taxbase"), dev: metric(cid, "dev"),
      econbase: metric(cid, "econbase"),
      wealth: metric(cid, "wealth"), control: metric(cid, "control"),
      control_wtd: dev.val(cid) ? ctlWsum.val(cid) / dev.val(cid) : 0.0,
      income: num(get(ec, "income")), expense: num(get(ec, "expense")),
      debt: num(get(ec, "total_debt")), loan_capacity: num(get(ec, "loan_capacity")),
      creditworthiness: num(get(ec, "creditworthiness")),
      coin_minting: num(get(ec, "coin_minting")),
      tax_income: num(get(c, "last_months_tax_income")),
      subject_tax_base: num(get(c, "last_months_subject_tax")),
      building_income: num(get(c, "last_months_foreign_building_income")),
      trade_value: num(get(c, "monthly_trade_value")),
      trade_balance: num(get(c, "monthly_trade_balance")),
      total_produced: num(get(c, "total_produced")),
      locations: Math.trunc(get(c, "n_owned") || 0), provinces: Math.trunc(get(c, "n_prov") || 0),
      _researched: isDict(get(c, "researched_advances"))
        ? [...get(c, "researched_advances")].filter(([k, v]) => v === "yes").map(([k]) => k) : null,
      _startLevel: c.has("starting_technology_level") ? num(get(c, "starting_technology_level"), null) : null,
      advances: Math.trunc(num(get(ct, "Advances"))), wars: Math.trunc(num(get(ct, "Wars"))),
      rebels: Math.trunc(num(get(ct, "Rebels"))),
      gp_rank: Math.trunc(num(get(c, "great_power_rank"), 999)),
      gp_points: num(get(c, "great_power_points")),
      score_place: Math.trunc(num(get(dictOr(get(c, "score")), "score_place"))),
      score: toObj(sc, (v) => num(v)),
      prestige: num(get(cd, "prestige")), stability: num(get(cd, "stability")),
      manpower: num(get(cd, "manpower")), max_manpower: num(get(c, "max_manpower")),
      army_tradition: num(get(cd, "army_tradition")),
      navy_tradition: num(get(cd, "navy_tradition")),
      govpower: num(get(cd, "government_power")), inflation: num(get(cd, "inflation")),
      army: army.val(cid), navy: navy.val(cid),
      levies: levies.val(cid), regulars: regulars.val(cid),
      mercs: mercs.val(cid),
      subunits: Math.trunc(subs.val(cid)), kills: get(c, "kills") || 0,
      war_battle: wl.val("Battle"), war_attrition: wl.val("Attrition"),
      goods: toObj(dictOr(get(c, "last_month_produced")), (v) => num(v)),
      raw: Object.fromEntries(raw.get(cid) || []),
      pop_hist: ph,
      tax_hist: asList(get(c, "historical_tax_base")).map((x) => num(x)),
      econ_hist: asList(get(c, "historical_economical_base")).map((x) => num(x)),
      ranks: rk,
    });
  }
  rows.sort((a, b) => a.gp_rank - b.gp_rank);

  let worldPop = 0;
  for (const c of countries.values()) worldPop += num(get(c, "last_months_population"));
  const world = {
    n_countries: live.length,
    world_pop: worldPop,
    world_locations: own.total(),
    date, version, multiplayer: mp, you: youTag, playthrough,
    n_players: players.size, wars_live: nWars,
    save: save.name,
  };
  return { rows, world };
}

// ==========================================================================

async function resolveGame(src) {
  if (!src) return null;
  const fs = new GameFS(src);
  if (!(await fs.list("main_menu/common/coat_of_arms/coat_of_arms"))) return null;
  return fs;
}

self.onmessage = async (e) => {
  const { save, game, opts } = e.data;
  const t0 = performance.now();
  try {
    stage("Checking the save…");
    await checkPlaintext(save);
    if (opts.peek) {
      // Just the in-game date and campaign, to put several saves in order.
      const head = await save.slice(0, 1 << 16).text();
      const date = (head.match(/\n\tdate=([\d.]+)/) || [null, null])[1];
      const playthrough = (head.match(/\n\tplaythrough_id="([^"]+)"/) || [null, null])[1];
      postMessage({ type: "done", data: { peek: true, date, playthrough } });
      return;
    }
    log(`reading ${save.name} (${Math.round(save.size / 1e6)} MB)`);
    const sections = await scanSections(save);
    const missing = ["metadata", "countries"].filter((k) => !sections.has(k));
    if (missing.length) throw new UserError(`Save is missing expected sections: ${missing.join(", ")}`);

    const data = await extract(save, sections, opts.top || 0);
    const w = data.world;
    log(`date ${w.date}  patch ${w.version}  ${w.n_players} player(s)  ` +
        `${w.n_countries} live countries  ${w.wars_live} wars in progress`);
    if (!data.rows.length) log("no player nations found in this save");

    const fs = await resolveGame(game);
    attachAdvanceGains(data.rows, (fs && (await loadStartingAdvances(fs))) || STARTING_ADVANCES);
    if (game && !fs) log("the linked folder doesn't look like an EU5 install - skipping flags and map");
    if (opts.flags && fs) {
      stage("Drawing coats of arms…");
      await attachFlags(data.rows, fs);
    } else if (opts.flags) {
      log("flags: no EU5 install linked - skipping");
    }
    if (opts.map && fs) {
      stage("Painting the map…");
      progress(0.75);
      data.map = await buildMapData(data, sections, save, fs);
    } else if (opts.map) {
      log("map: no EU5 install linked - skipping");
    }
    log(`done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    progress(1);
    postMessage({ type: "done", data });
  } catch (err) {
    postMessage({
      type: "error",
      code: err instanceof UserError ? err.code : "internal",
      message: err && err.message ? err.message : String(err),
    });
  }
};

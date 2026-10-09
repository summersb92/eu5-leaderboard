#!/usr/bin/env node
/* Builds gamedata/<version>/privateer.json - what the privateer page needs
   from the game files - from an EU5 install and the pack's proximity.json.

     node tools/build_privateer_data.js "<EU5 install>/game" 1.3.11

   What it holds:
     areas     every sea area (an area whose locations are all sea): key,
               English name, its sea zones (location ids)
     blockers  building types whose modifier has blocks_privateer_raids (their
               port can't be raided)
     sources   advances, policies and reforms that touch privateering:
               can_hire_privateers, privateer_durability, hire and maintenance
               cost modifiers, naval_range (+ _modifier)
     consts    the privateer defines, the opinion bias, the AI's weights,
               base durability and naval range, hire and upkeep prices      */
"use strict";
const fs = require("fs"), path = require("path");

const [game, version] = process.argv.slice(2);
if (!game || !version) {
  console.error('usage: node tools/build_privateer_data.js "<EU5 install>/game" <version>');
  process.exit(1);
}
const packDir = path.join(__dirname, "..", "gamedata", version);
const common = path.join(game, "in_game", "common");
const read = (p) => fs.readFileSync(p, "utf8").replace(/^﻿/, "");
const filesIn = (d) => fs.readdirSync(d).filter((f) => f.endsWith(".txt")).sort().map((f) => path.join(d, f));

/* Paradox script -> nested objects (same reader as build_rights_data.js). */
function parse(text) {
  const toks = text.replace(/#[^\n]*/g, " ").match(/"[^"]*"|[{}]|[<>!?]?=|[<>]|[^\s{}=<>"]+/g) || [];
  let i = 0;
  function block() {
    const obj = {}, list = [];
    while (i < toks.length && toks[i] !== "}") {
      const k = toks[i++];
      if (/^[<>!?]?=$|^[<>]$/.test(toks[i] || "")) {
        i++;
        let v;
        if (toks[i] === "{") { i++; v = block(); i++; }
        else {
          v = toks[i++];
          if (/^(rgb|hsv|hsv360)$/.test(v) && toks[i] === "{") { i++; block(); i++; }
        }
        if (k in obj) obj[k] = [].concat(obj[k], [v]); else obj[k] = v;
      } else if (k === "{") { list.push(block()); i++; }
      else list.push(k.replace(/^"|"$/g, ""));
    }
    return list.length && !Object.keys(obj).length ? list : Object.assign(obj, list.length ? { _list: list } : {});
  }
  return block();
}
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

const prox = JSON.parse(read(path.join(packDir, "proximity.json")));
const map = JSON.parse(read(path.join(packDir, "map.json")));
const idOf = new Map(map.names.map((n, i) => [n, i]));

// ---- English names --------------------------------------------------------
const loc = new Map();
const locRoot = path.join(game, "main_menu", "localization", "english");
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p);
    else if (f.name.endsWith(".yml"))
      for (const m of read(p).matchAll(/^\s*([\w.-]+):\d*\s*"(.*)"\s*$/gm)) if (!loc.has(m[1])) loc.set(m[1], m[2]);
  }
})(locRoot);
const pretty = (k) => k.replace(/_area$|_sea_zones$/, "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const nameOf = (k) => { const v = loc.get(k); return v && !/\$|\[/.test(v) ? v : pretty(k); };

// ---- sea areas --------------------------------------------------------------
/* definitions.txt nests continent > subcontinent > region > area > province
   > locations; areas are the blocks four deep. */
const defs = parse(read(path.join(game, "in_game", "map_data", "definitions.txt")));
const areas = [];
const leaves = (v, out) => {
  if (Array.isArray(v)) for (const x of v) typeof x === "string" ? out.push(x) : leaves(x, out);
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) k === "_list" ? leaves(x, out) : leaves(x, out);
  return out;
};
for (const cont of Object.values(defs)) if (isObj(cont)) for (const sub of Object.values(cont)) if (isObj(sub))
  for (const reg of Object.values(sub)) if (isObj(reg)) for (const [ak, area] of Object.entries(reg)) {
    if (ak === "_list") continue;
    const ids = leaves(area, []).map((n) => idOf.get(n)).filter((i) => i);
    if (!ids.length || !ids.every((i) => prox.kind[i] === 1)) continue;
    areas.push({ key: ak, name: nameOf(ak), zones: ids });
  }

// ---- buildings that block privateer raids ------------------------------------
const blockers = [];
for (const f of filesIn(path.join(common, "building_types"))) {
  for (const [k, b] of Object.entries(parse(read(f)))) {
    if (isObj(b) && isObj(b.modifier) && b.modifier.blocks_privateer_raids === "yes") blockers.push(k);
  }
}

// ---- what touches privateering -----------------------------------------------
const KEYS = ["can_hire_privateers", "privateer_durability", "hire_privateer_cost_modifier",
  "privateer_maintenance_cost_modifier", "naval_range", "naval_range_modifier"];
const pick = (m) => {
  if (!isObj(m)) return null;
  const o = {};
  for (const k of KEYS) if (k in m && !Array.isArray(m[k])) o[k] = m[k] === "yes" ? 1 : parseFloat(m[k]);
  return Object.keys(o).length ? o : null;
};
const sources = { advance: {}, policy: {}, reform: {} };
for (const f of filesIn(path.join(common, "advances")))
  for (const [k, a] of Object.entries(parse(read(f)))) { const o = pick(a); if (o) sources.advance[k] = o; }
for (const f of filesIn(path.join(common, "laws")))
  for (const law of Object.values(parse(read(f)))) if (isObj(law))
    for (const [k, p] of Object.entries(law)) { const o = isObj(p) && pick(p.country_modifier); if (o) sources.policy[k] = o; }
for (const f of filesIn(path.join(common, "government_reforms")))
  for (const [k, r] of Object.entries(parse(read(f)))) { const o = isObj(r) && pick(r.country_modifier); if (o) sources.reform[k] = o; }
const names = {};
for (const kind of Object.values(sources)) for (const k of Object.keys(kind)) names[k] = nameOf(k);

// ---- constants ------------------------------------------------------------------
const defines = read(path.join(game, "loading_screen", "common", "defines", "00_defines.txt"));
const def = (k) => { const m = defines.match(new RegExp("\\b" + k + "\\s*=\\s*(-?[\\d.]+)")); if (!m) throw new Error("no define " + k); return parseFloat(m[1]); };
const auto = parse(read(path.join(common, "auto_modifiers", "country.txt")));
const autoVal = (k) => { for (const b of Object.values(auto)) if (isObj(b) && k in b) return parseFloat(b[k]); return 0; };
const bias = parse(read(path.join(common, "biases", "00_opinion_hardcoded.txt"))).opinion_placed_privateers;
const prices = parse(read(path.join(common, "prices", "00_hardcoded.txt")));
const consts = {
  stealFactor: def("PRIVATEER_STEAL_MONEY_FACTOR"),
  maritimeImpact: def("PRIVATEER_MARITIME_IMPACT"),
  harassmentImpact: def("PRIVATEER_HARASSMENT_IMPACT"),
  noSailorsDecay: def("PRIVATEER_NO_SAILORS_DECAY"),
  opinionIncomeFloor: def("PRIVATEER_OPINION_INCOME_FLOOR"),
  opinionFullFraction: def("PRIVATEER_OPINION_FULL_IMPACT_FRACTION"),
  opinion: { value: parseFloat(bias.value), min: parseFloat(bias.min), yearlyDecay: parseFloat(bias.yearly_decay) },
  ai: { rivals: def("HOW_MUCH_WE_CARE_ABOUT_PRIVATEERING_RIVALS"), enemies: def("HOW_MUCH_WE_CARE_ABOUT_PRIVATEERING_ENEMIES"),
    neutrals: def("HOW_MUCH_WE_CARE_ABOUT_PRIVATEERING_NEUTRALS"), friends: def("HOW_MUCH_WE_CARE_ABOUT_PRIVATEERING_FRIENDS") },
  baseDurability: autoVal("privateer_durability"),
  baseNavalRange: autoVal("naval_range"),
  hireSailors: parseFloat(prices.hire_privateer.sailors),
  upkeepSailors: parseFloat(prices.privateer_maintenance.sailors),
};

const out = { version, consts, areas, blockers, sources, names };
fs.writeFileSync(path.join(packDir, "privateer.json"), JSON.stringify(out));
console.log(`privateer.json: ${areas.length} sea areas, blockers ${blockers.join(", ")}, ` +
  `${Object.keys(sources.advance).length} advances / ${Object.keys(sources.policy).length} policies / ` +
  `${Object.keys(sources.reform).length} reforms`);
console.log(consts);

#!/usr/bin/env node
/* Builds gamedata/<version>/rights.json - what the urban rights page needs
   from the game files - from an EU5 install.

     node tools/build_rights_data.js "<EU5 install>/game" 1.3.11

   What it holds:
     rights     every urban right: English name, the advance that unlocks it,
                its location modifiers (goods output, production efficiency,
                RGO size), whether it needs a port or a particular raw material,
                and which other rights it can't sit beside
     buildings  every building that makes goods: name, pop type, employment
                per level, which location ranks may have it, the advances that
                unlock it, and its production methods (inputs per level, good
                made, output per level, unlocking advance if any)
     goods      default price, category, English name
     slots      urban rights per location rank (town 1, city 2, megalopolis 3) */
"use strict";
const fs = require("fs"), path = require("path");

const [game, version] = process.argv.slice(2);
if (!game || !version) {
  console.error('usage: node tools/build_rights_data.js "<EU5 install>/game" <version>');
  process.exit(1);
}
const packDir = path.join(__dirname, "..", "gamedata", version);
const common = path.join(game, "in_game", "common");
const read = (p) => fs.readFileSync(p, "utf8").replace(/^﻿/, "");
const filesIn = (d) => fs.readdirSync(d).filter((f) => f.endsWith(".txt")).sort().map((f) => path.join(d, f));

/* Paradox script -> nested objects. Repeated keys become arrays; `a ?= b`,
   `a < b` and friends keep only the value; bare lists become arrays. */
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
const all = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// ---- script values (plain numbers only) ----------------------------------
const values = {};
for (const d of [path.join(game, "main_menu", "common", "script_values"), path.join(common, "script_values")])
  for (const f of filesIn(d))
    for (const m of read(f).replace(/#[^\n]*/g, "").matchAll(/^(\w+)\s*=\s*(-?[\d.]+)\s*$/gm)) values[m[1]] = parseFloat(m[2]);
const val = (v) => (v === undefined ? undefined : /^-?[\d.]+$/.test(v) ? parseFloat(v) : values[v]);

// ---- English names --------------------------------------------------------
const loc = {};
const locDir = path.join(game, "main_menu", "localization", "english");
for (const f of ["town_rights_l_english.yml", "buildings_l_english.yml", "goods_l_english.yml", "advances_l_english.yml", "location_names/location_names_l_english.yml"]) {
  const p = path.join(locDir, f);
  if (!fs.existsSync(p)) continue;
  for (const m of read(p).matchAll(/^\s*([\w.]+):\d*\s*"(.*)"\s*$/gm)) loc[m[1]] = m[2];
}
const english = (k) => {
  let s = loc[k];
  if (!s) return k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  for (let n = 0; n < 4 && /\$(\w+)\$/.test(s); n++) s = s.replace(/\$(\w+)\$/g, (_, r) => loc[r] || r);
  return s.replace(/\[ShowLocationNameWithNoTooltip\('(\w+)'\)\]/g, (_, l) => loc[l] || l)
    .replace(/\[Show\w+NameWithNoTooltip\('(\w+)'\)\]/g, (_, l) => loc[l] || english(l))
    .replace(/\[[^\]]*\]/g, "").replace(/#\w+ ?|#!/g, "").trim();
};

// ---- goods ----------------------------------------------------------------
const goods = {};
for (const f of filesIn(path.join(common, "goods"))) {
  const p = parse(read(f));
  for (const [k, g] of Object.entries(p)) {
    if (typeof g !== "object" || Array.isArray(g)) continue;
    goods[k] = { name: english(k), price: val(g.default_market_price) || 1, category: g.category || "", method: g.method || "" };
  }
}

// ---- which advance unlocks each right --------------------------------------
const unlockedBy = {}, buildingBy = {}, methodBy = {};
for (const f of filesIn(path.join(common, "advances"))) {
  const p = parse(read(f));
  for (const [k, a] of Object.entries(p)) {
    if (typeof a !== "object") continue;
    for (const r of all(a.unlock_town_rights)) unlockedBy[r] = { advance: k, name: english(k), age: a.age || "" };
    for (const b of all(a.unlock_building)) (buildingBy[b] = buildingBy[b] || []).push(k);
    for (const m of all(a.unlock_production_method)) (methodBy[m] = methodBy[m] || []).push(k);
  }
}

// ---- urban rights ---------------------------------------------------------
const rights = {};
for (const f of filesIn(path.join(common, "town_rights"))) {
  const p = parse(read(f));
  for (const [k, r] of Object.entries(p)) {
    if (typeof r !== "object" || Array.isArray(r)) continue;
    const lm = r.location_modifier || {};
    const output = {};
    let efficiency = 0, rgoSize = 0;
    const other = {};
    for (const [mk, mv] of Object.entries(lm)) {
      const v = val(Array.isArray(mv) ? mv[0] : mv);
      if (v === undefined) continue;
      const om = mk.match(/^local_(\w+)_output_modifier$/);
      if (om && goods[om[1]]) output[om[1]] = v;
      else if (mk === "local_production_efficiency") efficiency += v;
      else if (mk === "local_max_rgo_size_modifier") rgoSize += v;
      else other[mk] = v;
    }
    const allowText = JSON.stringify(r.allow || {});
    const raws = [...allowText.matchAll(/goods:(\w+)/g)].map((m) => m[1]);
    const excludes = [...allowText.matchAll(/town_rights_type:(\w+)/g)].map((m) => m[1]);
    const ranks = [...allowText.matchAll(/location_rank:(\w+)/g)].map((m) => m[1]);
    rights[k] = {
      name: english(k), file: path.basename(f, ".txt"),
      advance: unlockedBy[k] || null,
      potential: r.potential ? true : false,
      output, efficiency, rgoSize, other,
      port: /is_port","yes"|"is_port":"yes"/.test(allowText) ? true : /"is_port":"no"/.test(allowText) && !raws.length ? false : null,
      mining: /is_mining_rgo/.test(allowText),
      raws: [...new Set(raws)], ranks: [...new Set(ranks)], excludes: [...new Set(excludes)],
      keptAtConquest: r.kept_at_conquest !== "no",
    };
  }
}

// ---- production methods -----------------------------------------------------
function pmOf(name, b) {
  const inputs = {};
  for (const [k, v] of Object.entries(b)) if (goods[k]) inputs[k] = val(v);
  return { name, produced: b.produced || null, output: val(b.output) || 0, inputs };
}
const sharedPM = {};
for (const f of filesIn(path.join(common, "production_methods"))) {
  const p = parse(read(f));
  for (const [k, b] of Object.entries(p)) if (b && typeof b === "object" && !Array.isArray(b)) sharedPM[k] = pmOf(k, b);
}

const buildings = {};
for (const f of filesIn(path.join(common, "building_types"))) {
  const p = parse(read(f));
  for (const [k, b] of Object.entries(p)) {
    if (!b || typeof b !== "object" || Array.isArray(b)) continue;
    const pms = [];
    for (const u of all(b.unique_production_methods))
      for (const [pk, pb] of Object.entries(u)) if (pb && typeof pb === "object") pms.push(pmOf(pk, pb));
    for (const slot of all(b.possible_production_methods))
      for (const pk of Array.isArray(slot) ? slot : slot._list || []) if (sharedPM[pk]) pms.push(sharedPM[pk]);
    if (!pms.some((m) => m.produced)) continue;
    buildings[k] = {
      name: english(k), pop: b.pop_type || "", emp: val(b.employment_size) || 0,
      ranks: ["rural_settlement", "town", "city", "megalopolis"].filter((r) => b[r] === "yes"),
      obsolete: b.obsolete || null, foreign: b.is_foreign === "yes",
      // any one of these advances unlocks it (none listed: no advance needed)
      advances: buildingBy[k] || [],
      pms: pms.map((m) => ({ name: m.name, produced: m.produced, output: m.output, inputs: m.inputs,
        ...(methodBy[m.name] ? { advances: methodBy[m.name] } : {}) })),
    };
  }
}

const out = {
  version, built: new Date().toISOString().slice(0, 10),
  penalty: values.town_right_efficiency_penalty,
  slots: { rural_settlement: 0, town: 1, city: 2, megalopolis: 3 },
  goods, rights, buildings,
};
fs.writeFileSync(path.join(packDir, "rights.json"), JSON.stringify(out));
const prod = Object.values(rights).filter((r) => Object.keys(r.output).length);
console.log(`${Object.keys(rights).length} rights (${prod.length} with goods output), ${Object.keys(buildings).length} producing buildings, ` +
  `${Object.keys(goods).length} goods -> ${path.join(packDir, "rights.json")}`);

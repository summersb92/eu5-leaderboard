#!/usr/bin/env node
/* Builds gamedata/<version>/loans.json - what the loan & build advisor needs
   from the game files, on top of rights.json - from an EU5 install.

     node tools/build_loan_data.js "<EU5 install>/game" 1.3.11

   What it holds:
     buildings  every building that makes goods: its base gold price (from the
                age of the advance that unlocks it, or its own `price`, and
                `expensive = yes` for the dearer table) and its level cap
                (a number, or the name of a cap in `caps`)
     caps       the level-cap script values that are a sum of base, development,
                population, RGO size and river terms, plus a bonus for cities and
                megalopolises and the low market access penalty
     rgo        RGO expansion: base gold per method and the price scaling
     loans      loan, bond and creditworthiness defines */
"use strict";
const fs = require("fs"), path = require("path");

const [game, version] = process.argv.slice(2);
if (!game || !version) {
  console.error('usage: node tools/build_loan_data.js "<EU5 install>/game" <version>');
  process.exit(1);
}
const packDir = path.join(__dirname, "..", "gamedata", version);
const common = path.join(game, "in_game", "common");
const read = (p) => fs.readFileSync(p, "utf8").replace(/^﻿/, "");
const filesIn = (d) => fs.readdirSync(d).filter((f) => f.endsWith(".txt")).sort().map((f) => path.join(d, f));

/* Paradox script -> nested objects (as in build_rights_data.js). */
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

// ---- plain-number script values ---------------------------------------------
const values = {};
for (const d of [path.join(game, "main_menu", "common", "script_values"), path.join(common, "script_values")])
  for (const f of filesIn(d))
    for (const m of read(f).replace(/#[^\n]*/g, "").matchAll(/^(\w+)\s*=\s*(-?[\d.]+)\s*$/gm)) values[m[1]] = parseFloat(m[2]);
const val = (v) => (v === undefined ? undefined : /^-?[\d.]+$/.test(v) ? parseFloat(v) : values[v]);

// ---- prices: gold of every price entry ----------------------------------------
const prices = {};
for (const f of filesIn(path.join(common, "prices"))) {
  for (const [k, p] of Object.entries(parse(read(f)))) {
    if (!p || typeof p !== "object" || Array.isArray(p)) continue;
    const g = val(p.gold);
    if (g !== undefined) prices[k] = g;
  }
}

// ---- the age of every advance, and which unlock each building ------------------
const AGES = ["age_1_traditions", "age_2_renaissance", "age_3_discovery", "age_4_reformation", "age_5_absolutism", "age_6_revolutions"];
const unlockAge = {};
for (const f of filesIn(path.join(common, "advances"))) {
  for (const [k, a] of Object.entries(parse(read(f)))) {
    if (!a || typeof a !== "object" || !a.age) continue;
    const n = AGES.indexOf(a.age);
    if (n < 0) continue;
    for (const b of all(a.unlock_building)) unlockAge[b] = Math.min(unlockAge[b] ?? 99, n);
  }
}

// ---- level caps: base + development, population, RGO size, river; rank bonus ------
function capOf(block) {
  const c = { base: 0, dev: 0, pop: 0, rgo: 0, river: 0, city: 0, megalopolis: 0, access: false, min: val(block.min) ?? 0 };
  for (const a of all(block.add)) {
    const v = a.value, m = val(a.multiply) ?? 1;
    if (/^-?[\d.]+$/.test(v)) c.base += +v * m;
    else if (v === "development") c.dev += m;
    else if (v === "population") c.pop += m;
    else if (v === "max_rgo_workers") c.rgo += m;
    else return null;
  }
  for (const x of all(block.if)) {
    const lim = JSON.stringify(x.limit || {});
    const add = x.add && val(x.add.value);
    if (/location_rank:megalopolis/.test(lim) && add !== undefined) c.megalopolis += add;
    else if (/location_rank:city/.test(lim) && add !== undefined) c.city += add;
    else if (/has_river/.test(lim) && add !== undefined) c.river += add;
    else if (/market_access/.test(lim) && x.multiply) c.access = true;
    else if (/has_variable/.test(lim)) continue; // mission bonuses: ignored
    else return null;
  }
  return c;
}
const caps = {};
for (const f of filesIn(path.join(common, "script_values"))) {
  for (const [k, b] of Object.entries(parse(read(f)))) {
    if (!/_max_level$|_cap$/.test(k) || !b || typeof b !== "object" || Array.isArray(b)) continue;
    const c = capOf(b);
    if (c) caps[k] = c;
  }
}

// ---- buildings that make goods ------------------------------------------------
const buildings = {};
for (const f of filesIn(path.join(common, "building_types"))) {
  for (const [k, b] of Object.entries(parse(read(f)))) {
    if (!b || typeof b !== "object" || Array.isArray(b)) continue;
    const ml = b.max_levels;
    const cap = ml === undefined ? null : /^\d+$/.test(ml) ? +ml : values[ml] !== undefined ? values[ml] : caps[ml] ? ml : null;
    const age = unlockAge[k] ?? 0;
    const priceKey = b.price || `p_${b.expensive === "yes" ? "expensive_" : ""}building_${AGES[age].replace(/^age_(\d)_/, "age_$1_")}`;
    const gold = prices[priceKey];
    buildings[k] = { price: priceKey, gold: gold ?? null, age: age + 1, expensive: b.expensive === "yes", cap,
      estate: /estate/.test(b.category || "") || b.estate !== undefined };
  }
}

const D = (k) => { const m = read(path.join(game, "loading_screen", "common", "defines", "00_defines.txt")).match(new RegExp("\\b" + k + "\\s*=\\s*(-?[\\d.]+)")); return m ? +m[1] : null; };
const out = {
  version, built: new Date().toISOString().slice(0, 10),
  prices: Object.fromEntries(Object.entries(prices).filter(([k]) => /^p_|^expand_rgo_|^build_/.test(k))),
  caps, buildings,
  rgo: {
    gold: Object.fromEntries(Object.entries(prices).filter(([k]) => k.startsWith("expand_rgo_")).map(([k, v]) => [k.slice(11), v])),
    baseCost: D("GOODS_RGO_BASE_COST"), priceScale: D("GOODS_RGO_PRICE_SCALE"),
  },
  loans: Object.fromEntries(["LOAN_MIN_INTEREST", "LOAN_MAX_INTEREST", "LOAN_MIN_DURATION", "LOAN_MAX_DURATION", "LOAN_MIN_AMOUNT",
    "ESTATE_LOAN_DURATION_IN_MONTHS", "BOND_SIZE", "MIN_BOND_SIZE", "CREDITWORTHINESS_REPAY_BONUS", "CREDITWORTHINESS_ORIGINATION_PENALTY",
    "CREDITWORTHINESS_EXTENSION_PENALTY", "CREDITWORTHINESS_BANKRUPTCY_DRAIN", "CREDITWORTHINESS_BANKRUPTCY_YEARLY_RECOVERY",
    "BANKRUPTCY_STAB_LOSS", "BANKRUPTCY_DURATION_IN_MONTHS", "BANKRUPTCY_CONTROL_CHANGE_PERCENT"].map((k) => [k, D(k)])),
};
fs.writeFileSync(path.join(packDir, "loans.json"), JSON.stringify(out));
const capped = Object.values(buildings).filter((b) => typeof b.cap === "string").length;
console.log(`${Object.keys(buildings).length} buildings (${capped} with a scripted level cap), ${Object.keys(caps).length} caps, ` +
  `${Object.keys(out.prices).length} prices -> ${path.join(packDir, "loans.json")}`);

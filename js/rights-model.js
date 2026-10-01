/* EU5 urban rights model - reads what a save says each location produces and
   values every urban right there. No DOM; loads in the rights worker and in
   Node for testing (module.exports).

   Output a right changes:
     - its goods output bonus (e.g. Printing Rights +20% paper, books, dyes)
       raises that good wherever the location makes it: the RGO and buildings
     - its production efficiency penalty (-5%) lowers every building's output
       in the location; production efficiency is a building figure, so the
       RGO is untouched (its own modifier is raw material output)
   Output is valued at the location's market price. Building inputs don't
   change, so the change in output value is the change in profit.

   How much a location makes is calibrated against its market: the save
   records each market's monthly supply of every good from raw materials and
   from buildings, so each location's share is scaled to match. */
"use strict";
(function (root) {
  const RANKS = { rural_settlement: "Rural", town: "Town", city: "City", megalopolis: "Megalopolis" };

  // ---- save readers (text of one section each) ---------------------------
  function readLocations(text, onEach) {
    const out = new Map();
    for (const part of text.split(/\n\t\t(?=\d+=\{)/)) {
      const id = part.match(/^(\d+)=\{/), o = part.match(/\n\t\t\towner=(\d+)/);
      if (!id || !o) continue;
      const f = (k) => { const m = part.match(new RegExp("\\n\\t\\t\\t" + k + "=([\\d.]+)")); return m ? parseFloat(m[1]) : 0; };
      let rgoWorkers = 0;
      for (const m of part.matchAll(/\n\t\t\t\t\t\temployed_in_rgo=([\d.]+)/g)) rgoWorkers += parseFloat(m[1]);
      out.set(+id[1], {
        owner: +o[1],
        rank: (part.match(/\n\t\t\trank=(\w+)/) || [])[1] || "",
        raw: (part.match(/\n\t\t\traw_material=(\w+)/) || [])[1] || "",
        market: +((part.match(/\n\t\t\tmarket=(\d+)/) || [])[1] ?? -1),
        province: +((part.match(/\n\t\t\tprovince=(\d+)/) || [])[1] ?? -1),
        rgoWorkers, rgoMax: f("max_raw_material_workers"),
        dev: f("development"), control: f("control"), tax: f("tax"), ptax: f("possible_tax"),
        prosperity: f("prosperity"),
      });
      if (onEach) onEach();
    }
    return out;
  }

  /* building_manager -> [{type, level, employed, loc, owner, pms: [keys]}].
     A building's production methods are the sub-blocks named after them. */
  function readBuildings(text, pmNames) {
    const out = [];
    for (const part of text.split(/\n(?=\d+=\{\n\ttype=)/)) {
      const t = part.match(/^\d+=\{\n\ttype=(\w+)/);
      if (!t) continue;
      const g = (k) => (part.match(new RegExp("\\n\\t" + k + "=([\\w.]+)")) || [])[1];
      const pms = [];
      for (const m of part.matchAll(/\n\t(\w+)=\{/g)) if (pmNames.has(m[1])) pms.push(m[1]);
      out.push({ type: t[1], level: +(g("level") || 1), employed: parseFloat(g("employed") || 0),
        loc: +(g("location") || -1), owner: +(g("owner") || -1), pms });
    }
    return out;
  }

  /* market_manager -> Map(market id -> {center, price: {good: p}, raw: {good: supply}, bld: {good: supply}}) */
  function readMarkets(text) {
    const out = new Map();
    const db = text.indexOf("\n\tdatabase={");
    const body = db >= 0 ? text.slice(db) : text;
    for (const part of body.split(/\n(?=\d+=\{\n\tcenter=)/)) {
      const id = part.match(/^(\d+)=\{\n\tcenter=(\d+)/);
      if (!id) continue;
      const mk = { center: +id[2], price: {}, raw: {}, bld: {} };
      const gi = part.indexOf("\n\tgoods={");
      if (gi >= 0) {
        for (const gm of part.slice(gi).split(/\n\t\t(?=\w+=\{\n\t\t\tprice=)/)) {
          const h = gm.match(/^(\w+)=\{\n\t\t\tprice=([\d.]+)/);
          if (!h) continue;
          mk.price[h[1]] = parseFloat(h[2]);
          const ps = gm.match(/\n\t\t\tproduction_supplied=\{([^}]*)\}/);
          if (ps) {
            const r = ps[1].match(/RawMaterials=([\d.]+)/), b = ps[1].match(/Buildings=([\d.]+)/);
            if (r) mk.raw[h[1]] = parseFloat(r[1]);
            if (b) mk.bld[h[1]] = parseFloat(b[1]);
          }
        }
      }
      out.set(+id[1], mk);
    }
    return out;
  }

  /* townrights_manager -> Map(location -> [right types]) */
  function readTownRights(text) {
    const out = new Map();
    for (const m of text.matchAll(/\n\tlocation=(\d+)\n\ttype=(\w+)/g)) {
      const l = +m[1];
      (out.get(l) || out.set(l, []).get(l)).push(m[2]);
    }
    return out;
  }

  // ---- production --------------------------------------------------------
  /* Every location's output by good, from its RGO and its buildings,
     calibrated to its market's recorded supply. Returns
     Map(loc -> {rgo: {good, amount} | null, blds: [{type, level, good, amount, pm}]}) */
  function production(D, locs, buildings, markets) {
    const B = D.buildings;
    const pmIndex = new Map();
    for (const [bk, b] of Object.entries(B)) for (const pm of b.pms) pmIndex.set(bk + ":" + pm.name, pm);
    // raw (uncalibrated) outputs
    const out = new Map();
    const rawSum = new Map(), bldSum = new Map(); // "market:good" -> modelled total
    const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
    for (const [l, L] of locs) {
      const o = { rgo: null, blds: [] };
      if (L.raw && L.rgoWorkers > 0) {
        o.rgo = { good: L.raw, model: L.rgoWorkers };
        add(rawSum, L.market + ":" + L.raw, L.rgoWorkers);
      }
      out.set(l, o);
    }
    for (const b of buildings) {
      const bt = B[b.type], o = out.get(b.loc);
      if (!bt || !o) continue;
      // the producing method in use (first one the save names that makes something)
      const pm = b.pms.map((p) => pmIndex.get(b.type + ":" + p)).find((p) => p && p.produced);
      if (!pm) continue;
      const cap = bt.emp > 0 ? bt.emp * b.level : 0;
      const util = cap > 0 ? Math.min(1, b.employed / cap) : 1;
      const model = pm.output * b.level * util;
      if (model <= 0) { o.blds.push({ type: b.type, level: b.level, good: pm.produced, pm: pm.name, model: 0, amount: 0, idle: true }); continue; }
      o.blds.push({ type: b.type, level: b.level, good: pm.produced, pm: pm.name, model });
      add(bldSum, locs.get(b.loc).market + ":" + pm.produced, model);
    }
    // calibrate to the market
    const scale = { raw: [], bld: [] };
    for (const [l, o] of out) {
      const L = locs.get(l), mk = markets.get(L.market);
      if (o.rgo) {
        const k = L.market + ":" + o.rgo.good, s = rawSum.get(k);
        const sup = mk && mk.raw[o.rgo.good];
        o.rgo.amount = sup && s ? o.rgo.model * sup / s : 0;
      }
      for (const b of o.blds) {
        if (b.idle) continue;
        const k = L.market + ":" + b.good, s = bldSum.get(k);
        const sup = mk && mk.bld[b.good];
        b.amount = sup && s ? b.model * sup / s : b.model;
      }
    }
    // market-wide factors, for reporting: supply per RGO worker (thousand) and per modelled building unit
    for (const [k, s] of rawSum) { const [m, g] = k.split(":"); const sup = markets.get(+m)?.raw[g]; if (sup) scale.raw.push(sup / s); }
    for (const [k, s] of bldSum) { const [m, g] = k.split(":"); const sup = markets.get(+m)?.bld[g]; if (sup) scale.bld.push(sup / s); }
    return { out, scale };
  }

  const priceAt = (D, markets, L, g) => {
    const mk = markets.get(L.market);
    return (mk && mk.price[g]) || (D.goods[g] && D.goods[g].price) || 0;
  };

  /* Can a right go in a location? -> null (yes) or the reason it can't. */
  function blocked(D, rk, L, loc, have, isPort) {
    const r = D.rights[rk];
    if (have.includes(rk)) return "has it";
    if (!D.slots[L.rank]) return "rural";
    for (const h of have) {
      if (r.excludes.includes(h) || (D.rights[h] && D.rights[h].excludes.includes(rk))) return "clashes with " + D.rights[h]?.name;
    }
    if (r.port === true && !isPort) return "needs a port";
    if (r.raws.length && !r.raws.includes(L.raw) && !r.mining) return "needs " + r.raws.join("/");
    if (r.ranks.length && !r.ranks.includes(L.rank)) return "needs a " + r.ranks.map((x) => RANKS[x] || x).join("/");
    return null;
  }

  /* Value one right in one location from what it makes now.
     -> {net, rgo, bld, pen, lines: [{what, good, amount, price, pct, value}]} */
  function valueRight(D, markets, rk, L, prod, rgoPenalty) {
    const r = D.rights[rk], pen = r.efficiency || 0;
    const lines = [];
    let rgo = 0, bld = 0, penV = 0;
    if (prod.rgo && prod.rgo.amount > 0) {
      const g = prod.rgo.good, pct = r.output[g] || 0;
      if (rgoPenalty) penV += prod.rgo.amount * priceAt(D, markets, L, g) * pen;
      if (pct) {
        const p = priceAt(D, markets, L, g), v = prod.rgo.amount * p * pct;
        rgo += v;
        lines.push({ what: "RGO", good: g, amount: prod.rgo.amount, price: p, pct, value: v });
      }
    }
    for (const b of prod.blds) {
      if (!b.amount) continue;
      const p = priceAt(D, markets, L, b.good), base = b.amount * p;
      const pct = r.output[b.good] || 0;
      if (pct) { bld += base * pct; lines.push({ what: D.buildings[b.type]?.name || b.type, type: b.type, level: b.level, good: b.good, amount: b.amount, price: p, pct, value: base * pct }); }
      penV += base * pen;
    }
    return { net: rgo + bld + penV, rgo, bld, pen: penV, lines };
  }

  /* Best way to add output of a right's goods here: for each of its goods,
     the building that makes it with the best margin per level once the right
     applies, using this market's prices. */
  function buildAdvice(D, markets, rk, L, researched, sourcedFn) {
    const r = D.rights[rk], rank = L.rank === "rural_settlement" ? "town" : L.rank;
    const out = [];
    for (const g of Object.keys(r.output)) {
      let best = null;
      for (const [bk, b] of Object.entries(D.buildings)) {
        if (!b.ranks.includes(rank) || b.foreign) continue;
        const unlocked = !b.advances.length || (researched && b.advances.some((a) => researched.has(a)));
        for (const pm of b.pms) {
          if (pm.produced !== g) continue;
          const pmOk = !pm.advances || (researched && pm.advances.some((a) => researched.has(a)));
          const p = priceAt(D, markets, L, g);
          let cost = 0;
          for (const [ig, q] of Object.entries(pm.inputs)) cost += q * priceAt(D, markets, L, ig);
          const gross = pm.output * p;
          const withRight = gross * (1 + r.output[g] + (r.efficiency || 0)) - cost;
          const cand = { building: bk, name: b.name, pm: pm.name, good: g, output: pm.output, gross, cost,
            margin: gross - cost, marginWith: withRight, unlocked: unlocked && pmOk,
            local: sourcedFn(pm.inputs) };
          const better = !best || (cand.unlocked && !best.unlocked) ||
            (cand.unlocked === best.unlocked && cand.marginWith > best.marginWith);
          if (better) best = cand;
        }
      }
      // the RGO itself makes this good
      if (L.raw === g) out.push({ good: g, rgo: true });
      if (best) out.push(best);
    }
    return out;
  }

  /* A guild that turns all of this location's raw material into one of a
     right's goods: how many levels it takes, its margin, and what the right
     adds to its output. -> the best per right, best first. */
  const CHAIN_MAX_LEVELS = 10;
  function chainValue(D, markets, L, prod, feeds) {
    const amt = prod.rgo ? prod.rgo.amount || 0 : 0;
    if (!amt) return [];
    const best = new Map();
    for (const f of feeds) {
      if (!f.town || !f.unlocked) continue;
      const r = D.rights[f.right], p = priceAt(D, markets, L, f.good);
      let cost = 0;
      for (const [ig, q] of Object.entries(f.inputs)) cost += q * priceAt(D, markets, L, ig);
      // only guilds this raw material is the main input of
      if (f.perLevel * priceAt(D, markets, L, L.raw) < 0.5 * cost) continue;
      const levels = Math.min(CHAIN_MAX_LEVELS, amt / f.perLevel);
      const margin = f.output * p - cost;
      const gain = levels * f.output * p * ((r.output[f.good] || 0) + (r.efficiency || 0));
      const c = { right: f.right, building: f.building, good: f.good, levels, margin, gain, uses: Math.min(1, levels * f.perLevel / amt) };
      const o = best.get(f.right);
      if (!o || c.gain > o.gain) best.set(f.right, c);
    }
    return [...best.values()].sort((a, b) => b.gain - a.gain);
  }

  /* The whole country: every location, every right with an output bonus. */
  function analyzeCountry(D, S, cid, opts = {}) {
    const rightKeys = Object.keys(D.rights).filter((k) => {
      const r = D.rights[k];
      if (!Object.keys(r.output).length) return false;
      if (opts.boroughOnly) return r.advance && r.advance.advance === "town_rights_enable";
      return true;
    });
    const researched = S.researched.get(cid) || null;
    // raw material -> the rights whose goods it's an input for, and the building that uses it
    const feedsOf = new Map();
    for (const rk of rightKeys) {
      for (const [bk, b] of Object.entries(D.buildings)) {
        if (b.foreign) continue;
        for (const pm of b.pms) {
          if (!pm.produced || !(pm.produced in D.rights[rk].output)) continue;
          for (const [ig, q] of Object.entries(pm.inputs)) {
            if (!q) continue;
            const list = feedsOf.get(ig) || feedsOf.set(ig, []).get(ig);
            const unlocked = (!b.advances.length || (researched && b.advances.some((a) => researched.has(a)))) &&
              (!pm.advances || (researched && pm.advances.some((a) => researched.has(a))));
            list.push({ right: rk, building: bk, pm: pm.name, good: pm.produced, perLevel: q, output: pm.output, inputs: pm.inputs,
              town: b.ranks.includes("town"), unlocked });
          }
        }
      }
    }
    const rows = [];
    // province -> Map(raw good -> [locations with it as their RGO]): buildings
    // whose inputs come from an RGO in their own province are more efficient
    const provRaw = new Map();
    for (const [l, L] of S.locs) {
      if (!L.raw || L.province < 0) continue;
      const m = provRaw.get(L.province) || provRaw.set(L.province, new Map()).get(L.province);
      (m.get(L.raw) || m.set(L.raw, []).get(L.raw)).push(l);
    }
    const pmOf = (type, name) => (D.buildings[type]?.pms || []).find((p) => p.name === name);
    /* inputs of a production method an RGO in the province makes -> [{good, locs}] */
    const sourced = (inputs, prov) => {
      const m = provRaw.get(prov);
      if (!m || !inputs) return [];
      return Object.keys(inputs).filter((g) => m.has(g)).map((g) => ({ good: g, locs: m.get(g) }));
    };
    for (const [l, L] of S.locs) {
      if (L.owner !== cid) continue;
      const prod = S.prod.get(l) || { rgo: null, blds: [] };
      const srcOf = new Map(); // building type -> its inputs made by an RGO in the province
      for (const b of prod.blds) srcOf.set(b.type, sourced(pmOf(b.type, b.pm)?.inputs, L.province));
      const have = S.rights.get(l) || [];
      const slots = D.slots[L.rank] ?? 0;
      const vals = [];
      for (const rk of rightKeys) {
        const why = blocked(D, rk, L, l, have, S.isPort(l));
        const v = valueRight(D, S.markets, rk, L, prod, opts.rgoPenalty);
        for (const ln of v.lines) if (ln.type && srcOf.get(ln.type)?.length) ln.src = srcOf.get(ln.type);
        vals.push({ right: rk, ...v, blocked: why });
      }
      vals.sort((a, b) => b.net - a.net);
      // best right here; for a rural location, the best once it's a town
      const ok = vals.filter((v) => !v.blocked || v.blocked === "rural");
      const best = ok[0] || null;
      // the best set for the free slots (rights here can stack)
      const pick = [];
      for (const v of ok) {
        if (pick.length >= Math.max(1, slots - have.length) || v.net <= 0) break;
        if (pick.some((p) => D.rights[p.right].excludes.includes(v.right) || D.rights[v.right].excludes.includes(p.right))) continue;
        pick.push(v);
      }
      // RGO-only view: what the right would be worth with no buildings (for spotting new towns)
      const rgoOnly = {};
      for (const v of vals) rgoOnly[v.right] = v.rgo;
      let rgoValue = 0, bldValue = 0;
      if (prod.rgo && prod.rgo.amount) rgoValue = prod.rgo.amount * priceAt(D, S.markets, L, prod.rgo.good);
      for (const b of prod.blds) if (b.amount) bldValue += b.amount * priceAt(D, S.markets, L, b.good);
      rows.push({
        loc: l, rank: L.rank, raw: L.raw, rgoAmount: prod.rgo ? prod.rgo.amount || 0 : 0,
        rgoWorkers: L.rgoWorkers, rgoMax: L.rgoMax, rawPrice: L.raw ? priceAt(D, S.markets, L, L.raw) : 0,
        dev: L.dev, control: L.control, ptax: L.ptax, market: L.market, province: L.province,
        have, slots, free: Math.max(0, slots - have.length), port: S.isPort(l),
        rgoValue, bldValue,
        blds: prod.blds.filter((b) => b.amount > 0).map((b) => ({ type: b.type, level: b.level, good: b.good, amount: b.amount,
          value: b.amount * priceAt(D, S.markets, L, b.good), src: srcOf.get(b.type) || [] })).sort((a, b) => b.value - a.value),
        values: vals.map((v) => ({ right: v.right, net: v.net, rgo: v.rgo, bld: v.bld, pen: v.pen, blocked: v.blocked, lines: v.lines })),
        best: best ? best.right : null, bestNet: best ? best.net : 0,
        picks: pick.map((p) => ({ right: p.right, net: p.net })),
        rgoOnly, feeds: L.raw ? (feedsOf.get(L.raw) || []).map((f) => ({ right: f.right, building: f.building, good: f.good })) : [],
        chain: chainValue(D, S.markets, L, prod, feedsOf.get(L.raw) || []),
        advice: best ? buildAdvice(D, S.markets, best.right, L, researched, (inputs) => sourced(inputs, L.province)) : [],
      });
    }
    rows.sort((a, b) => b.bestNet - a.bestNet);
    return { rights: rightKeys, rows, hasBorough: researched ? researched.has("town_rights_enable") : null };
  }

  const api = { RANKS, readLocations, readBuildings, readMarkets, readTownRights, production, valueRight, blocked, buildAdvice, analyzeCountry, priceAt };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.EU5Rights = api;
})(typeof self !== "undefined" ? self : this);

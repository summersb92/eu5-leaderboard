/* EU5 privateer model - ranks the sea areas a nation could send privateers
   to. Pure functions over the pack (privateer.json + proximity.json) and the
   save data the worker reads; loads in a worker (self.EU5Priv) or in Node
   (module.exports) for testing.

   What the game files say (1.3.11):
   - A privateer is hired for a whole sea area, one per country per area.
     It needs can_hire_privateers (Privateers / Letters of Marque advances,
     the state piracy policy, a few reforms); the area must be within naval
     range and border a port whose owner we have no anti-piracy agreement
     with (generic_actions/privateers.txt).
   - Gold comes from the ports beside the area, location by location; a port
     with a coastal fort or naval battery (blocks_privateer_raids) gives
     nothing. How much each port gives is in the engine; the only number in
     the files is PRIVATEER_STEAL_MONEY_FACTOR = 0.01. The page multiplies it
     by a per-port base the user picks and can calibrate against the game's
     own tooltip.
   - Privateers harass the maritime presence of others in the area. The AI
     values that by relation: rivals 1, enemies 1, neutrals 0.2, friends 0
     (HOW_MUCH_WE_CARE_ABOUT_PRIVATEERING_*); we use the same weights.
   - Navies hunting pirates wear privateer power down: the save keeps each
     area's last month of harassment, and power changes by
     PRIVATEER_HARASSMENT_IMPACT (-0.005) per point.
   - Each port owner's opinion drops by 250 x (gold stolen from it /
     (10% of its monthly income, at least 5)), up to the bias's floor of
     -100, recovering 10 a year. */
"use strict";
(function (root) {
  const BASES = {
    flow: { label: "Trade through the port", short: "trade", of: (S, i) => S.flow[i] },
    tax: { label: "Port's tax", short: "tax", of: (S, i) => S.tax[i] },
    ptax: { label: "Port's possible tax", short: "possible tax", of: (S, i) => S.ptax[i] },
  };

  /* Static lookups from the pack: which area each sea zone is in, and the
     ports along each area. */
  function prepare(D, prox) {
    const zoneArea = new Int32Array(prox.n).fill(-1);
    D.areas.forEach((a, k) => { for (const z of a.zones) zoneArea[z] = k; });
    const ports = D.areas.map(() => []);
    const portZones = new Map(); // land -> [zones]
    for (let i = 0; i < prox.port.length; i += 2) {
      const land = prox.port[i], zone = prox.port[i + 1], k = zoneArea[zone];
      if (k >= 0 && !ports[k].some((p) => p.loc === land)) ports[k].push({ loc: land, zone });
      (portZones.get(land) || portZones.set(land, []).get(land)).push(zone);
    }
    const centre = D.areas.map((a) => {
      let x = 0, y = 0;
      for (const z of a.zones) { x += prox.xy[2 * z]; y += prox.xy[2 * z + 1]; }
      return [x / a.zones.length, y / a.zones.length];
    });
    // sea-to-sea borders, weighted by the distance between zone centres in
    // full-size map pixels (xy is half size); the map wraps east-west
    const W = 2 * Math.max(...prox.xy.filter((_, i) => i % 2 === 0)) + 2;
    const sea = new Map();
    const len = (a, b) => {
      let dx = Math.abs(prox.xy[2 * a] - prox.xy[2 * b]) * 2;
      dx = Math.min(dx, W - dx);
      return Math.hypot(dx, (prox.xy[2 * a + 1] - prox.xy[2 * b + 1]) * 2);
    };
    for (let i = 0; i < prox.adj.length; i += 2) {
      const a = prox.adj[i], b = prox.adj[i + 1];
      if (prox.kind[a] !== 1 || prox.kind[b] !== 1) continue;
      const l = len(a, b);
      (sea.get(a) || sea.set(a, []).get(a)).push([b, l]);
      (sea.get(b) || sea.set(b, []).get(b)).push([a, l]);
    }
    return { zoneArea, ports, portZones, centre, sea, n: prox.n };
  }

  /* Distance by sea from a set of zones to every zone (Dijkstra). */
  function seaDistance(P, starts) {
    const dist = new Float64Array(P.n).fill(Infinity);
    const heap = [];
    const push = (d, z) => {
      heap.push([d, z]);
      let i = heap.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
        }
      }
      return top;
    };
    for (const z of starts) if (dist[z] > 0) { dist[z] = 0; push(0, z); }
    while (heap.length) {
      const [d, z] = pop();
      if (d > dist[z]) continue;
      for (const [y, l] of P.sea.get(z) || []) if (d + l < dist[y]) { dist[y] = d + l; push(d + l, y); }
    }
    return dist;
  }

  /* What a nation has that matters: can it hire, its durability, cost
     modifiers and naval range, and where they come from. */
  function nationStats(D, c) {
    const out = { canHire: false, durability: D.consts.baseDurability, hireMod: 0, upkeepMod: 0,
      range: D.consts.baseNavalRange, rangeMod: 0, sources: [] };
    const add = (kind, key) => {
      const s = D.sources[kind] && D.sources[kind][key];
      if (!s) return;
      if (s.can_hire_privateers) out.canHire = true;
      out.durability += s.privateer_durability || 0;
      out.hireMod += s.hire_privateer_cost_modifier || 0;
      out.upkeepMod += s.privateer_maintenance_cost_modifier || 0;
      out.range += s.naval_range || 0;
      out.rangeMod += s.naval_range_modifier || 0;
      out.sources.push({ kind, key, name: D.names[key] || key, ...s });
    };
    for (const a of c.advances) add("advance", a);
    for (const p of c.policies) add("policy", p);
    for (const r of c.reforms) add("reform", r);
    out.range *= 1 + out.rangeMod;
    return out;
  }

  /* The nation's relation to every other country: "self", "friend" (its
     subjects, overlord, allies), "enemy" (at war), "rival", or "neutral". */
  function relations(S, cid) {
    const rel = new Map([[cid, "self"]]);
    // subjects and overlords, walked both ways transitively
    const seen = new Set([cid]);
    let frontier = [cid];
    while (frontier.length) {
      const nxt = [];
      for (const x of frontier) for (const y of [...(S.subjects.get(x) || []), ...(S.overlords.get(x) || [])])
        if (!seen.has(y)) { seen.add(y); nxt.push(y); }
      frontier = nxt;
    }
    const family = new Set(seen);
    family.delete(cid);
    for (const x of family) rel.set(x, "family");
    for (const x of S.allies.get(cid) || []) if (!rel.has(x)) rel.set(x, "friend");
    for (const x of S.enemies.get(cid) || []) rel.set(x, "enemy");
    for (const x of S.rivals.get(cid) || []) if (rel.get(x) !== "enemy") rel.set(x, "rival");
    return (x) => rel.get(x) || "neutral";
  }

  const WEIGHT = (D, r) => ({ enemy: D.consts.ai.enemies, rival: D.consts.ai.rivals, neutral: D.consts.ai.neutrals })[r] || 0;

  /* Ranks every sea area for nation `cid`. opts: base (key of BASES), factor
     (gold per unit of base at full power), power (privateer power assumed). */
  function rank(D, prox, P, S, cid, opts = {}) {
    const base = BASES[opts.base] || BASES.flow;
    const factor = opts.factor != null ? opts.factor : D.consts.stealFactor;
    const power = opts.power != null ? opts.power : 1;
    const c = S.countries.get(cid);
    const st = nationStats(D, c);
    const relOf = relations(S, cid);
    const partners = S.antiPiracy.get(cid) || new Set();

    // naval range: sailing distance from the sea zones off our ports (or our
    // subjects'), in full-size map pixels
    const starts = [];
    for (const [land, zones] of P.portZones) {
      const o = S.owner[land];
      if (o === cid || relOf(o) === "family") starts.push(...zones);
    }
    const seaDist = seaDistance(P, starts);
    const dist = (z) => seaDist[z];

    const rows = [];
    D.areas.forEach((a, k) => {
      const ports = P.ports[k];
      if (!ports.length) return;
      let gold = 0, flowAll = 0, open = 0, blockedN = 0, ownN = 0;
      let eligible = false;
      const victims = new Map();
      const portRows = [];
      for (const p of ports) {
        const o = S.owner[p.loc];
        const r = o >= 0 ? relOf(o) : "none";
        if (o < 0 || !partners.has(o)) eligible = true;
        const blocked = S.blocked.has(p.loc);
        const v = base.of(S, p.loc) || 0;
        flowAll += v;
        const mine = r === "self" || r === "family";
        const raidable = o >= 0 && !mine && !blocked && !partners.has(o);
        const g = raidable ? factor * power * v : 0;
        if (mine) ownN++;
        if (blocked) blockedN++;
        if (raidable) {
          open++;
          gold += g;
          const vv = victims.get(o) || { cid: o, gold: 0, ports: 0, rel: r };
          vv.gold += g; vv.ports++;
          victims.set(o, vv);
        }
        portRows.push({ loc: p.loc, zone: p.zone, owner: o, rel: r, value: v, gold: g, blocked, raidable });
      }
      // presence of others in the area's zones, weighted the AI's way
      let hurt = 0, presAll = 0, presMine = 0;
      const byCountry = new Map();
      for (const z of a.zones) {
        const m = S.presence.get(z);
        if (!m) continue;
        for (const [o, pw] of m) {
          const r = relOf(o);
          if (r === "self" || r === "family") { presMine += pw; continue; }
          presAll += pw;
          const w = WEIGHT(D, r);
          hurt += w * pw;
          byCountry.set(o, (byCountry.get(o) || 0) + pw);
        }
      }
      const nz = a.zones.length;
      // opinion: every victim's hit from this one placement
      let opinion = 0;
      for (const v of victims.values()) {
        const inc = Math.max(D.consts.opinionIncomeFloor, (S.countries.get(v.cid) || {}).income || 0);
        const frac = v.gold / inc;
        v.opinion = Math.max(D.consts.opinion.min, D.consts.opinion.value * Math.min(1, frac / D.consts.opinionFullFraction));
        v.share = frac;
        opinion += v.opinion;
      }
      const harass = S.harassment.get(a.key) || 0;
      const mineHere = S.privateers.find((p) => p.country === cid && p.area === a.key) || null;
      const others = S.privateers.filter((p) => p.area === a.key && p.country !== cid);
      const d = Math.min(...a.zones.map(dist));
      rows.push({
        k, key: a.key, name: a.name, zones: a.zones, centre: P.centre[k],
        gold, open, ports: ports.length, blocked: blockedN, own: ownN, eligible, base: flowAll,
        hurt: hurt / nz, presence: presAll / nz, presenceMine: presMine / nz,
        top: [...byCountry].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([o, pw]) => ({ cid: o, rel: relOf(o), presence: pw / nz })),
        victims: [...victims.values()].sort((x, y) => y.gold - x.gold),
        opinion, harass, powerDrift: D.consts.harassmentImpact * harass,
        distance: d, inRange: d <= st.range,
        hired: mineHere, others,
        portRows: portRows.sort((x, y) => y.value - x.value),
      });
    });
    return { stats: st, rows, base: opts.base in BASES ? opts.base : "flow", factor, power };
  }

  /* One score per area from the user's weights; each part is scaled to the
     best area so weights compare like with like. */
  function score(rows, w) {
    const max = (f) => Math.max(1e-9, ...rows.map(f));
    const mg = max((r) => r.gold), mh = max((r) => r.hurt), mr = max((r) => r.harass), mo = max((r) => -r.opinion);
    for (const r of rows)
      r.score = 100 * (w.gold * r.gold / mg + w.hurt * r.hurt / mh - w.risk * r.harass / mr - w.opinion * -r.opinion / mo) /
        Math.max(1e-9, w.gold + w.hurt);
    return rows;
  }

  /* Calibration: given the gold the game shows for some ports, the factor
     each base implies (least squares through 0) and how well it fits. */
  function calibrate(S, obs) {
    const out = {};
    for (const [k, b] of Object.entries(BASES)) {
      let sxy = 0, sxx = 0;
      for (const o of obs) { const x = b.of(S, o.loc) || 0; sxy += x * o.gold; sxx += x * x; }
      const f = sxx ? sxy / sxx : 0;
      let err = 0, tot = 0;
      for (const o of obs) { const x = b.of(S, o.loc) || 0; err += Math.abs(f * x - o.gold); tot += Math.abs(o.gold); }
      out[k] = { factor: f, error: tot ? err / tot : 0 };
    }
    return out;
  }

  const api = { BASES, prepare, seaDistance, nationStats, relations, rank, score, calibrate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.EU5Priv = api;
})(typeof self !== "undefined" ? self : this);

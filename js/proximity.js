/* EU5 proximity model and capital / local-governor placement search.
   Pure functions: loaded by js/placement-worker.js, and by Node for tests.

   Proximity spreads out from each source (the capital at 100, a local
   governor at 80) and loses a cost at every hop between locations; a
   location's proximity is the best it gets from any source. Hop costs:
     land -> land   40, or the road's cost (20, less 5/10/15 for paved,
                    modern, rail), or 12 along a river; times (1 + terrain
                    of the location being left) and (1 - up to 20% for its
                    development)
     sea -> sea     30 blending to 5 with maritime presence; lakes 5
     land <-> sea   35, less up to half with the natural harbour (ports only)
   and everything divided by a per-country factor fitted to the save, which
   stands in for the country's own proximity modifiers.

   Max control is 0.75% per point of proximity, so a location's settled tax
   is roughly its possible tax x proximity x 0.0075.                      */
(function (root) {
  "use strict";

  /* Graph from proximity.json: CSR neighbours plus edge flags. */
  function buildGraph(pj) {
    const n = pj.n;
    const deg = new Int32Array(n + 1);
    const pairs = pj.adj;
    for (let i = 0; i < pairs.length; i += 2) { deg[pairs[i]]++; deg[pairs[i + 1]]++; }
    const start = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) start[i + 1] = start[i] + deg[i];
    const to = new Int32Array(start[n]), fill = start.slice(0, n);
    for (let i = 0; i < pairs.length; i += 2) {
      const a = pairs[i], b = pairs[i + 1];
      to[fill[a]++] = b; to[fill[b]++] = a;
    }
    const key = (a, b) => a * 65536 + b;
    const river = new Set(), port = new Set();
    for (let i = 0; i < pj.river.length; i += 2) { river.add(key(pj.river[i], pj.river[i + 1])); river.add(key(pj.river[i + 1], pj.river[i])); }
    for (let i = 0; i < pj.port.length; i += 2) { port.add(key(pj.port[i], pj.port[i + 1])); port.add(key(pj.port[i + 1], pj.port[i])); }
    return { n, start, to, river, port, key, kind: pj.kind, terr: pj.terr, harbor: pj.harbor, xy: pj.xy, names: pj.names, c: pj.consts };
  }

  /* One country's view of the graph: the locations it owns plus all water,
     with each usable hop's cost (before the country factor).
     save: {owner: Int32Array, dev: Float64Array, roads: Map key->type,
            presence: Map seaId -> Map cid -> power} */
  function countryGraph(g, save, cid) {
    const { n, start, to, kind, terr, harbor, c } = g;
    const owned = (i) => kind[i] === 0 && save.owner[i] === cid;
    const usable = (i) => owned(i) || kind[i] === 1 || kind[i] === 2;
    const pres = (i) => { const m = save.presence.get(i); return (m && m.get(cid)) || 0; };
    const eStart = new Int32Array(n + 1), eTo = [], eCost = [];
    for (let u = 0; u < n; u++) {
      eStart[u] = eTo.length;
      if (!usable(u)) continue;
      for (let e = start[u]; e < start[u + 1]; e++) {
        const v = to[e];
        if (!usable(v)) continue;
        const wu = kind[u] !== 0, wv = kind[v] !== 0;
        let cost;
        if (!wu && !wv) {
          const rt = save.roads.get(g.key(u, v));
          cost = rt ? c.road - (c.roads[rt] || 0) : c.land;
          if (g.river.has(g.key(u, v)) && c.river < cost) cost = c.river;
          cost *= (1 + terr[u]) * (1 - Math.min(c.devCap, save.dev[u] * c.devCut));
        } else if (wu && wv) {
          if (kind[u] === 2 || kind[v] === 2) cost = c.maritime;
          else cost = c.sea - (c.sea - c.maritime) * Math.min(1, Math.max(pres(u), pres(v)) / 100);
        } else {
          const land = wu ? v : u, sea = wu ? u : v;
          if (!g.port.has(g.key(land, sea))) continue;
          cost = c.port * (1 - harbor[land] * c.harborCut);
        }
        eTo.push(v); eCost.push(cost);
      }
    }
    eStart[n] = eTo.length;
    const locs = [];
    for (let i = 1; i < n; i++) if (owned(i)) locs.push(i);
    return { cid, n, eStart, eTo: Int32Array.from(eTo), eCost: Float64Array.from(eCost), locs, scale: 1 };
  }

  /* Best proximity from sources [[loc, value], ...] -> Float32Array(n)
     (or into `out`). Works in doubles: a float32 copy of a value compares
     unequal to the heap's own copy. */
  function spread(cg, sources, out) {
    const { n, eStart, eTo, eCost } = cg, k = cg.scale;
    const best = cg._work || (cg._work = new Float64Array(n));
    best.fill(0);
    // binary max-heap of (value, node)
    let hv = new Float64Array(256), hn = new Int32Array(256), size = 0;
    const push = (p, i) => {
      if (size === hv.length) { const v2 = new Float64Array(size * 2), n2 = new Int32Array(size * 2); v2.set(hv); n2.set(hn); hv = v2; hn = n2; }
      let j = size++;
      while (j) { const q = (j - 1) >> 1; if (hv[q] >= p) break; hv[j] = hv[q]; hn[j] = hn[q]; j = q; }
      hv[j] = p; hn[j] = i;
    };
    for (const [i, p] of sources) if (p > best[i]) { best[i] = p; push(p, i); }
    while (size) {
      const p = hv[0], u = hn[0];
      const lp = hv[--size], ln = hn[size];
      let j = 0;
      for (;;) {
        const l = 2 * j + 1; if (l >= size) break;
        const m = l + 1 < size && hv[l + 1] > hv[l] ? l + 1 : l;
        if (hv[m] <= lp) break;
        hv[j] = hv[m]; hn[j] = hn[m]; j = m;
      }
      hv[j] = lp; hn[j] = ln;
      if (p < best[u]) continue;
      for (let e = eStart[u]; e < eStart[u + 1]; e++) {
        const v = eTo[e], q = p - eCost[e] / k;
        if (q > best[v] + 1e-9) { best[v] = q; push(q, v); }
      }
    }
    const res = out || new Float32Array(n);
    res.set(best);
    return res;
  }

  /* Fit the country factor to the proximity the save records. */
  function calibrate(cg, sources, saved) {
    const buf = new Float32Array(cg.n);
    const sse = (k) => {
      cg.scale = k;
      spread(cg, sources, buf);
      let e = 0;
      for (const i of cg.locs) e += (buf[i] - saved[i]) ** 2;
      return e;
    };
    let lo = 0.4, hi = 4;
    for (let it = 0; it < 30; it++) {
      const m1 = lo + (hi - lo) * 0.382, m2 = lo + (hi - lo) * 0.618;
      if (sse(m1) < sse(m2)) hi = m2; else lo = m1;
    }
    cg.scale = (lo + hi) / 2;
    spread(cg, sources, buf);
    let abs = 0, w5 = 0;
    for (const i of cg.locs) { const d = Math.abs(buf[i] - saved[i]); abs += d; if (d < 5) w5++; }
    const m = cg.locs.length || 1;
    return { scale: cg.scale, mae: abs / m, within5: w5 / m, model: buf };
  }

  /* Settled tax base of a proximity field: sum of possible tax x max control. */
  function score(cg, field, weight, cpp) {
    let s = 0;
    for (const i of cg.locs) s += weight[i] * Math.min(1, field[i] * cpp);
    return s;
  }

  /* Owned locations joined to `from` by an unbroken chain of roads. */
  function roadReach(cg, save, g, from) {
    const seen = new Set([from]), q = [from];
    const own = new Set(cg.locs);
    while (q.length) {
      const u = q.pop();
      for (const v of save.roadNb.get(u) || []) if (own.has(v) && !seen.has(v)) { seen.add(v); q.push(v); }
    }
    return seen;
  }

  root.EU5Prox = { buildGraph, countryGraph, spread, calibrate, score, roadReach };
  if (typeof module !== "undefined") module.exports = root.EU5Prox;
})(typeof self !== "undefined" ? self : globalThis);

/* EU5 loan & build advisor model - what a nation owes, what each building
   project in its locations would return to the treasury, and which of them a
   loan or a government bond would pay for. No DOM; loads in the loans worker
   and in Node for testing (module.exports).

   How the game moves gold, as the save shows it:
     - A loan is paid as monthly interest only (amount x yearly rate / 12);
       the whole amount falls due at the end of its term, or the loan is
       extended (-0.03 creditworthiness). A government bond is interest only
       for ever: it is never repaid unless you redeem it.
     - A building's profit (`last_months_profit`) and its RGO's output are
       wealth in the location (fitted per save: about 1.06 and 0.77 of
       possible tax per gold). The part under control is tax base, split
       between the estates by their share of the location's wealth, and each
       estate pays its tax rate to the treasury. So the treasury sees
       new wealth x control x the location's estate-weighted tax rate. That
       rebuilds the save's own tax income to within about 1%.
     - Construction is paid in gold up front: the building's base price (by the
       age of the advance that unlocks it) times the nation's own cost factor,
       read from what its constructions in progress actually cost.

   A project is one more level of something: an existing building (at the
   profit per level it makes now), a building the location doesn't have yet
   (at what that building makes per level elsewhere in the same market), or
   one more RGO worker slot (at what each RGO worker makes now). */
"use strict";
(function (root) {
  const POP_OF_RGO = "laborers";
  const STAFFED = 0.9;  // a building this full or more can use another level

  // ---- save readers ---------------------------------------------------------
  const num = (s, re) => { const m = s.match(re); return m ? parseFloat(m[1]) : 0; };
  const block = (s, k) => (s.match(new RegExp("\\n\\t\\t\\t" + k + "=\\{([^}]*)\\}")) || [])[1] || "";
  const pairs = (s) => { const o = {}; for (const m of s.matchAll(/(\w+?)(?:_estate)?=([-\d.]+)/g)) o[m[1]] = parseFloat(m[2]); return o; };

  /* locations -> Map(id -> {owner, rank, raw, market, control, tax, ptax,
     estateTax, estatePossible, access, dev, rgoMax, rgoWorkers, unemployed, pops}) */
  function readLocations(text) {
    const out = new Map();
    for (const part of text.split(/\n\t\t(?=\d+=\{)/)) {
      const id = part.match(/^(\d+)=\{/), o = part.match(/\n\t\t\towner=(\d+)/);
      if (!id || !o) continue;
      const unemployed = {};
      let rgoWorkers = 0;
      for (const m of part.matchAll(/\n\t\t\t\t\t(\w+)=\{\n([\s\S]*?)\n\t\t\t\t\t\}/g)) {
        const u = m[2].match(/\n?\t\t\t\t\t\tunemployed=([\d.]+)/), r = m[2].match(/\n?\t\t\t\t\t\temployed_in_rgo=([\d.]+)/);
        if (u) unemployed[m[1]] = parseFloat(u[1]);
        if (r) rgoWorkers += parseFloat(r[1]);
      }
      const pp = part.match(/\n\t\t\t\tpops=\{([^}]*)\}/);
      out.set(+id[1], {
        owner: +o[1],
        rank: (part.match(/\n\t\t\trank=(\w+)/) || [])[1] || "",
        raw: (part.match(/\n\t\t\traw_material=(\w+)/) || [])[1] || "",
        market: +((part.match(/\n\t\t\tmarket=(\d+)/) || [])[1] ?? -1),
        control: num(part, /\n\t\t\tcontrol=([\d.]+)/), tax: num(part, /\n\t\t\ttax=([\d.]+)/),
        ptax: num(part, /\n\t\t\tpossible_tax=([\d.]+)/), access: num(part, /\n\t\t\tmarket_access=([\d.]+)/),
        dev: num(part, /\n\t\t\tdevelopment=([\d.]+)/), rgoMax: num(part, /\n\t\t\tmax_raw_material_workers=([\d.]+)/),
        estateTax: pairs(block(part, "estate_tax")), estatePossible: pairs(block(part, "estate_possible_tax")),
        rgoWorkers, unemployed, pops: pp ? pp[1].trim().split(/\s+/) : [],
      });
    }
    return out;
  }

  /* population -> Map(pop id -> size, thousands) */
  function readPopSizes(text) {
    const out = new Map();
    for (const m of text.matchAll(/\n(\d+)=\{\n\ttype=\w+[^}]*?\n\tsize=([\d.]+)/g)) out.set(m[1], parseFloat(m[2]));
    return out;
  }

  /* building_manager -> [{type, level, employed, loc, owner, profit|null, laying}]
     A building laying off workers (`employment_requirement_status=LayingOff`)
     is unprofitable; one with no workers records no profit at all. */
  function readBuildings(text) {
    const out = [];
    for (const part of text.split(/\n(?=\d+=\{\n\ttype=)/)) {
      const t = part.match(/^\d+=\{\n\ttype=(\w+)/);
      if (!t) continue;
      const g = (k) => (part.match(new RegExp("\\n\\t" + k + "=([-\\w.]+)")) || [])[1];
      const p = g("last_months_profit");
      out.push({ type: t[1], level: +(g("level") || 1), employed: parseFloat(g("employed") || 0),
        loc: +(g("location") || -1), owner: +(g("owner") || -1), profit: p === undefined ? null : parseFloat(p),
        laying: g("employment_requirement_status") === "LayingOff" });
    }
    return out;
  }

  /* loan_manager -> [{amount, rate, months, borrower, lender, bond}] (rate yearly) */
  function readLoans(text) {
    const out = [];
    for (const part of text.split(/\n(?=\d+=\{)/)) {
      const a = part.match(/\n\tamount=([\d.]+)/), b = part.match(/\n\tborrower=(\d+)/);
      if (!a || !b) continue;
      const l = part.match(/\n\tlender=(\d+)/), m = part.match(/\n\tloan_original_months=(\d+)/);
      out.push({ amount: parseFloat(a[1]), rate: num(part, /\n\tinterest=([\d.]+)/), months: m ? +m[1] : null,
        borrower: +b[1], lender: l ? +l[1] : null, bond: /\n\tkey="government_bond"/.test(part) || !m });
    }
    return out;
  }

  /* construction_manager -> [{country, price, priceMod, gold}] for those with gold paid */
  function readConstructions(text) {
    const out = [];
    for (const part of text.split(/\n(?=\d+=\{)/)) {
      const c = part.match(/\n\tcountry=(\d+)/), p = part.match(/\n\tprice=(\w+)/), g = part.match(/\n\t\tgold=([\d.]+)/);
      if (!c || !p || !g) continue;
      const pm = part.match(/\n\tprice_modifier=([\d.]+)/);
      out.push({ country: +c[1], price: p[1], priceMod: pm ? parseFloat(pm[1]) : 1, gold: parseFloat(g[1]) });
    }
    return out;
  }

  /* one country's chunk -> treasury, income, debt and tax rates */
  function readEconomy(chunk) {
    const f = (k) => num(chunk, new RegExp("\\n\\t+" + k + "=(-?[\\d.]+)"));
    const tr = (chunk.match(/\n\t\ttax_rates=\{([^}]*)\}/) || [])[1] || "";
    return {
      gold: f("gold"), income: f("income"), expense: f("expense"), taxIncome: f("last_months_tax_income"),
      debt: f("total_debt"), foreignDebt: f("foreign_debt"), bondDebt: f("bond_debt"), estateDebt: f("estate_debt"),
      credit: f("creditworthiness"), loanCapacity: f("loan_capacity"), rates: pairs(tr),
    };
  }

  // ---- helpers ----------------------------------------------------------------
  const median = (a) => { const s = a.filter((x) => isFinite(x)).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

  /* the location's level cap for a building, or Infinity when unknown */
  function levelCap(LD, cap, L) {
    if (typeof cap === "number") return cap;
    const c = cap && LD.caps[cap];
    if (!c) return Infinity;
    let v = c.base + c.dev * L.dev + c.pop * L.pop + c.rgo * L.rgoMax;
    if (L.rank === "city") v += c.city;
    if (L.rank === "megalopolis") v += c.megalopolis;
    if (c.access && L.access < 0.75) v *= L.access + 0.25;
    return Math.max(c.min || 0, Math.floor(v));
  }

  /* share of a gold of new wealth in this location that reaches the treasury */
  function captureAt(L, rates) {
    const base = Object.keys(L.estatePossible).length ? L.estatePossible : L.estateTax;
    let tot = 0, got = 0;
    for (const [e, v] of Object.entries(base)) { tot += v; got += v * (rates[e] || 0); }
    return tot > 0 ? got / tot : 0;
  }

  /* cost factor: gold paid / base price, for buildings and for RGO expansion */
  function costFactors(LD, cons, cid) {
    const f = (list) => {
      const b = [], r = [];
      for (const c of list) {
        const base = LD.prices[c.price];
        if (!base) continue;
        if (c.price.startsWith("expand_rgo_")) r.push(c.gold / (base * c.priceMod));
        else if (c.price.startsWith("p_")) b.push(c.gold / base);
      }
      return { building: median(b), rgo: median(r), nb: b.length, nr: r.length };
    };
    const own = f(cons.filter((c) => c.country === cid)), all = f(cons);
    return {
      building: own.building ?? all.building ?? 1, rgo: own.rgo ?? all.rgo ?? 1,
      ownBuilding: own.nb, ownRgo: own.nr, from: { building: own.building != null ? "own" : "world", rgo: own.rgo != null ? "own" : "world" },
    };
  }

  /* How much location wealth (possible tax) a gold of building profit and a
     gold of RGO output make, fitted over every location in the save:
     possible_tax = building x profit + rgo x RGO output value (least squares
     through the origin). On a 1372 save: building 1.06, RGO 0.77. */
  function wealthFit(D, S) {
    const prof = new Map();
    for (const b of S.buildings) if (b.profit !== null) prof.set(b.loc, (prof.get(b.loc) || 0) + b.profit);
    let A = 0, B = 0, C = 0, Y1 = 0, Y2 = 0;
    for (const [l, L] of S.locs) {
      if (!(L.ptax > 0)) continue;
      const P = S.prod.get(l), mk = S.markets.get(L.market);
      const rv = P && P.rgo && P.rgo.amount ? P.rgo.amount * ((mk && mk.price[P.rgo.good]) || 0) : 0;
      const bp = prof.get(l) || 0;
      A += bp * bp; B += bp * rv; C += rv * rv; Y1 += bp * L.ptax; Y2 += rv * L.ptax;
    }
    const det = A * C - B * B;
    if (!(det > 0)) return { building: 1, rgo: 1, fitted: false };
    const clamp = (v) => Math.max(0.2, Math.min(1.5, v));
    return { building: clamp((Y1 * C - Y2 * B) / det), rgo: clamp((A * Y2 - B * Y1) / det), fitted: true };
  }

  /* What one level costs and returns under a financing choice.
     fin = {mode: "loan"|"bond", rate (yearly fraction), term (months)} */
  function finance(P, R, fin) {
    const interest = P * fin.rate / 12;
    const need = fin.mode === "bond" ? interest : interest + P / fin.term;
    const cover = need > 0 ? R / need : Infinity;
    // the yearly rate at which the return just covers the interest, and (for a loan) repays it by the end
    const rateInterest = P > 0 ? 12 * R / P : 0;
    const rateRepay = P > 0 && fin.mode === "loan" ? 12 * (R - P / fin.term) / P : rateInterest;
    const verdict = R >= need ? "self" : R >= interest ? "interest" : R > 0 ? "loss" : "none";
    return { interest, need, cover, payback: R > 0 ? P / R : Infinity, rateInterest, rateRepay, verdict };
  }

  // ---- the whole country ------------------------------------------------------
  /* D: rights.json, LD: loans.json,
     S: {locs, buildings, markets (rights-model readMarkets), econ: Map(cid -> readEconomy),
         loans, cons, researched: Map(cid -> Set), names: Map(cid -> name)}
     opts: {mode, rate, term, budget} */
  function analyzeCountry(D, LD, S, cid, opts) {
    const E = S.econ.get(cid);
    const fin = { mode: opts.mode, rate: opts.rate, term: opts.term };
    const cf = costFactors(LD, S.cons, cid);
    const researched = S.researched.get(cid) || null;
    const price = (L, g) => { const mk = S.markets.get(L.market); return (mk && mk.price[g]) || (D.goods[g] && D.goods[g].price) || 0; };

    const W = S.wealth || (S.wealth = wealthFit(D, S));
    // every building type in every market: its levels, total profit (idle ones make 0) and whether any is laying off
    const inMarket = new Map(); // "type:market" -> {levels, profit, n, laying}
    const present = new Map();  // loc -> Map(type -> building)
    for (const b of S.buildings) {
      const L = S.locs.get(b.loc);
      if (!L) continue;
      (present.get(b.loc) || present.set(b.loc, new Map()).get(b.loc)).set(b.type, b);
      if (!D.buildings[b.type] || !(b.level > 0)) continue;
      const k = b.type + ":" + L.market;
      const t = inMarket.get(k) || inMarket.set(k, { levels: 0, profit: 0, n: 0, laying: 0 }).get(k);
      t.levels += b.level; t.profit += b.profit || 0; t.n++; if (b.laying) t.laying++;
    }
    // RGO output per worker in each location, at its market price
    const rgoValue = new Map();
    for (const [l, P] of S.prod) {
      const L = S.locs.get(l);
      if (L && L.owner === cid && P.rgo && P.rgo.amount > 0 && L.rgoWorkers > 0) rgoValue.set(l, P.rgo.amount * price(L, P.rgo.good) / L.rgoWorkers);
    }

    const unlocked = (B) => !B.advances.length || (researched && B.advances.some((a) => researched.has(a)));
    const projects = [];
    let taxBase = 0, captured = 0;
    for (const [l, L] of S.locs) {
      if (L.owner !== cid) continue;
      const cap = captureAt(L, E.rates);
      taxBase += L.tax; captured += L.tax * cap;
      const g = L.control * cap; // treasury gold per gold of new wealth
      const have = present.get(l) || new Map();
      const add = (p) => {
        const P = p.cost, R = p.profit * p.wealth * g;
        projects.push({ loc: l, rank: L.rank, market: L.market, control: L.control, capture: cap, ...p, toTreasury: R, ...finance(P, R, fin) });
      };
      const free = (pop, emp) => (emp > 0 ? Math.floor(((L.unemployed[pop] || 0) + 1e-9) / emp) : 99);

      // one more level of what's here
      for (const [type, b] of have) {
        const B = D.buildings[type], LB = LD.buildings[type];
        if (!B || !LB || LB.gold == null || b.owner !== cid || !(b.level > 0)) continue;
        const per = (b.profit || 0) / b.level, staff = B.emp > 0 ? b.employed / (B.emp * b.level) : 1;
        const capL = levelCap(LD, LB.cap, L), room = capL - b.level, workers = free(B.pop, B.emp);
        const levels = Math.max(0, Math.min(room, workers));
        const mk = inMarket.get(type + ":" + L.market);
        const blocked = b.laying || b.profit === null ? "laying off: unprofitable" : per <= 0 ? "makes a loss"
          : staff < STAFFED ? `only ${Math.round(staff * 100)}% staffed` : room <= 0 ? `at its level cap (${capL})`
          : workers <= 0 ? `no unemployed ${B.pop}` : null;
        add({ kind: "expand", type, level: b.level, levels, cap: capL, pop: B.pop, staff, cost: LB.gold * cf.building,
          profit: per, wealth: W.building, basis: "its own profit per level",
          crowded: mk && mk.laying ? mk.laying : 0, marketLevels: mk ? mk.levels : 0, blocked });
      }
      // a building it doesn't have, at what that building makes per level across the same market
      for (const [type, B] of Object.entries(D.buildings)) {
        const LB = LD.buildings[type];
        if (have.has(type) || !LB || LB.gold == null || LB.estate || B.foreign || !B.ranks.includes(L.rank) || !unlocked(B)) continue;
        const mk = inMarket.get(type + ":" + L.market);
        if (!mk || !mk.levels) continue;
        // rural buildings work the location's own raw material: only where one in the market shares it
        if (!B.ranks.some((r) => r !== "rural_settlement") &&
          !S.buildings.some((x) => x.type === type && S.locs.get(x.loc)?.raw === L.raw && S.locs.get(x.loc)?.market === L.market)) continue;
        const per = mk.profit / mk.levels;
        if (!(per > 0)) continue;
        const capL = levelCap(LD, LB.cap, L), workers = free(B.pop, B.emp);
        const levels = Math.max(0, Math.min(capL, workers));
        add({ kind: "new", type, level: 0, levels, cap: capL, pop: B.pop, staff: 1, cost: LB.gold * cf.building, profit: per,
          wealth: W.building, basis: `market average: ${mk.levels} levels in ${mk.n} buildings`, crowded: mk.laying, marketLevels: mk.levels,
          blocked: mk.laying ? `${mk.laying} in this market laying off` : workers <= 0 ? `no unemployed ${B.pop}` : capL <= 0 ? "no room" : null });
      }
      // one more RGO worker slot
      const rv = rgoValue.get(l);
      if (rv && L.raw) {
        const method = (D.goods[L.raw] && D.goods[L.raw].method) || "farming";
        const px = price(L, L.raw);
        const cost = (LD.rgo.gold[method] || 100) * (LD.rgo.baseCost + LD.rgo.priceScale * px) * cf.rgo;
        // laborers work RGOs; unemployed peasants promote into the new slots over time
        const full = L.rgoWorkers >= L.rgoMax - 0.05, lab = L.unemployed[POP_OF_RGO] || 0;
        // the RGO's own size cap isn't in the save: offer at most as many slots again as it has
        const workers = Math.min(Math.max(1, L.rgoMax), Math.floor(lab + (L.unemployed.peasants || 0) + 1e-9));
        add({ kind: "rgo", type: L.raw, method, level: L.rgoMax, levels: full ? workers : 0, pop: POP_OF_RGO, staff: L.rgoMax ? L.rgoWorkers / L.rgoMax : 0,
          cost, profit: rv, wealth: W.rgo, crowded: 0,
          basis: "output per RGO worker in its market" + (lab < 1 ? "; fills from peasants over time" : ""),
          blocked: !full ? `RGO not full (${L.rgoWorkers.toFixed(1)} of ${L.rgoMax})` : workers <= 0 ? "no unemployed laborers or peasants" : null });
      }
    }

    // the plan: best treasury return per gold first, among projects that pay for their financing,
    // adding at most as many levels of a building to a market as it already has there, and none
    // to a market where that building is already laying off workers
    const order = projects.filter((p) => !p.blocked && p.levels > 0 && p.toTreasury > 0)
      .sort((a, b) => b.toTreasury / b.cost - a.toTreasury / a.cost);
    const plan = [], added = new Map();
    let spent = 0, crowdedSkipped = 0;
    for (const p of order) {
      if (p.verdict !== "self") continue;
      if (p.crowded) { crowdedSkipped++; continue; }
      const k = p.type + ":" + p.market;
      const room = p.kind === "rgo" ? Infinity : Math.max(1, p.marketLevels) - (added.get(k) || 0);
      const n = Math.min(p.levels, room, Math.floor((opts.budget - spent) / p.cost + 1e-9));
      if (n <= 0) continue;
      plan.push({ ...p, take: n });
      added.set(k, (added.get(k) || 0) + n);
      spent += n * p.cost;
    }
    const sum = (k) => plan.reduce((s, p) => s + p.take * p[k], 0);
    const P = spent, R = sum("toTreasury"), I = P * fin.rate / 12;

    // what the nation owes now
    const owed = S.loans.filter((x) => x.borrower === cid).map((x) => ({ ...x, monthly: x.amount * x.rate / 12,
      lenderName: x.lender === null ? null : (S.names.get(x.lender) || "#" + x.lender) }));
    const lent = S.loans.filter((x) => x.lender === cid);

    return {
      econ: E, costFactor: cf, wealth: W, capture: taxBase > 0 ? captured / taxBase : 0, taxBase, modelTax: captured,
      fin, projects,
      best: order.slice(0, 10),
      plan, planTotals: { principal: P, monthly: R, interest: I, net: R - I, crowdedSkipped,
        need: fin.mode === "bond" ? I : I + P / fin.term, repayMonths: R - I > 0 ? P / (R - I) : Infinity },
      owed, lent: { count: lent.length, amount: lent.reduce((s, x) => s + x.amount, 0), monthly: lent.reduce((s, x) => s + x.amount * x.rate / 12, 0) },
    };
  }

  /* default rates: the lowest the nation pays now, else what the world pays */
  function defaultRates(S, cid) {
    const own = S.loans.filter((x) => x.borrower === cid);
    const loan = own.filter((x) => !x.bond).map((x) => x.rate), bond = own.filter((x) => x.bond).map((x) => x.rate);
    const all = S.loans.filter((x) => !x.bond).map((x) => x.rate), allB = S.loans.filter((x) => x.bond).map((x) => x.rate);
    return {
      loan: loan.length ? Math.min(...loan) : median(all) ?? 0.1, loanFrom: loan.length ? "own" : "world",
      bond: bond.length ? Math.min(...bond) : median(allB) ?? 0.05, bondFrom: bond.length ? "own" : "world",
    };
  }

  const api = { readLocations, readPopSizes, readBuildings, readLoans, readConstructions, readEconomy,
    levelCap, captureAt, costFactors, wealthFit, finance, analyzeCountry, defaultRates, median };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.EU5Loans = api;
})(typeof self !== "undefined" ? self : this);

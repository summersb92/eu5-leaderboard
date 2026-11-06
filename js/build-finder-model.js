/* EU5 build finder - what the build finder page shows for one nation, from the loan & build
   advisor's analysis (js/loans-model.js analyzeCountry). No DOM; loads in js/loans-worker.js
   (the page, from a dropped save) and in Node (tools/build-finder.js, a page with the data built in).

   On top of the advisor's projects it works out:
     - the nation's loan and bond interest, the way the game builds it (interestOf)
     - its court, diplomatic and stability spending per gold of new tax base (spendOf) */
"use strict";
(function (root) {
  const r4 = (v) => (typeof v === "number" && isFinite(v) ? Math.round(v * 1e4) / 1e4 : v);

  /* bank_interest = base 0.10 + slope x (creditworthiness - 0.5) + every bank_interest from researched
     advances, implemented policies, privileges and reforms, timed modifiers (x size) and the societal
     values (left side below 0, right side above, x |value| / 100); bonds the same with bond_interest.
     Clamped to LOAN_MIN/MAX_INTEREST. T = loans.json `interest` (tools/interest-sources.js).
     Checked on Milan 1472: 10 - 0.29 - 2 (banking) - 1 (treasury rights) - 2.15 (capital economy -72)
     - 1 (generous terms) = 3.56%; the Ottomans' and Pomerania's real loans within ~0.2%. */
  function interestOf(inp, credit, T, defines) {
    const parts = [], add = (what, bank, bond) => { if (bank || bond) parts.push({ what, bank: r4(bank || 0), bond: r4(bond || 0) }); };
    const base = (T && T.base) || { bank: 0.10, bond: 0.05 }, slope = (T && T.credit) || { bank: -0.05, bond: -0.04 };
    add("base", base.bank, base.bond);
    add(`creditworthiness ${Math.round(credit * 100)}%`, slope.bank * (credit - 0.5), slope.bond * (credit - 0.5));
    if (T && inp) {
      const one = (map, names) => { for (const n of names || []) { const v = map[n]; if (v) add(n, v.bank, v.bond); } };
      one(T.advance, inp.advances); one(T.policy, inp.policies); one(T.privilege, inp.privileges); one(T.reform, inp.reforms);
      for (const [n, size] of inp.timed || []) { const v = T.modifier[n]; if (v) add(n, (v.bank || 0) * size, (v.bond || 0) * size); }
      for (const [n, v] of Object.entries(T.societal || {})) {
        const x = inp.societal && inp.societal[n]; if (x == null) continue;
        const side = x < 0 ? "left_modifier" : "right_modifier", s = Math.abs(x) / 100;
        add(`${n} ${Math.round(x)}`, (v[side + ":bank"] || 0) * s, (v[side + ":bond"] || 0) * s);
      }
    }
    const lo = (defines && defines.LOAN_MIN_INTEREST) || 0.01, hi = (defines && defines.LOAN_MAX_INTEREST) || 0.25;
    const clamp = (v) => Math.min(hi, Math.max(lo, v));
    return { loan: clamp(parts.reduce((s, p) => s + p.bank, 0)), bond: clamp(parts.reduce((s, p) => s + p.bond, 0)), parts, exact: !!T };
  }

  /* Court, diplomatic and stability spending are each 0.1 x tax base x slider x the nation's cost
     modifier (defines COURT_SPENDING_FRACTON, DIPLOMATIC_SPENDING_FRACTION, STABILIY_EXPENSE_FACTOR).
     The modifier k is read back from last month's spending; the game's tax base is the last entry of
     the save's historical_tax_base (larger than the sum of location tax). */
  function spendOf(E, taxBaseModel) {
    const TB = E.taxBaseGame || taxBaseModel;
    const line = (setting, spent) => ({ setting, spent, k: setting > 0 && TB > 0 && spent != null ? spent / (0.1 * setting * TB) : 1 });
    return { taxBase: TB,
      court: line((E.settings || {}).CourtMaintenance || 0, (E.spent || {}).CourtMaintenance),
      diplo: line((E.settings || {}).DiplomaticMaintenance || 0, (E.spent || {}).DiplomaticMaintenance),
      stab: line(E.stabilityInvestment || 0, null) };
  }

  /* res: analyzeCountry's result. o: {tag, name, player, locName(id), marketOf(id) -> market name, interestTable, defines} */
  function nationData(res, o) {
    const E = res.econ;
    const projects = res.projects.filter((p) => p.levels > 0 || p.blocked).map((p) => ({
      loc: o.locName(p.loc), rank: p.rank, market: o.marketOf(p.loc), kind: p.kind, type: p.type, what: o.label(p),
      level: p.level, levels: p.levels, cap: isFinite(p.cap) ? p.cap : null, pop: p.pop, staff: r4(p.staff), cost: r4(p.cost), profit: r4(p.profit),
      control: r4(p.control), capture: r4(p.capture), wealth: r4(p.kind === "rgo" ? res.wealth.rgo : res.wealth.building),
      basis: p.basis, blocked: p.blocked, crowded: p.crowded || 0, marketLevels: p.marketLevels || 0 }));
    const d = { tag: o.tag, name: o.name,
      econ: { gold: E.gold, income: E.income, expense: E.expense, debt: E.debt, credit: E.credit, taxIncome: E.taxIncome },
      spend: spendOf(E, res.taxBase), capture: res.capture, wealth: res.wealth, costFactor: res.costFactor.building,
      interest: interestOf(E.interestIn, E.credit, o.interestTable, o.defines),
      owed: res.owed.map((x) => ({ amount: x.amount, rate: x.rate, bond: !!x.bond })), projects };
    if (o.player) d.player = o.player;
    return d;
  }

  const api = { interestOf, spendOf, nationData };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.EU5Build = api;
})(typeof self !== "undefined" ? self : this);

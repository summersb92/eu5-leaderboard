/* Every source of loan (bank_interest) and bond (bond_interest) modifiers in an EU5 install,
   by the name a save uses for it. Used by tools/build_loan_data.js (the `interest` table in
   loans.json) and read by js/build-finder-model.js.

     require("./interest-sources")("<EU5 install>/game")
       -> { advance: {name: {bank, bond}}, policy, privilege, reform, modifier,
            societal: {name: {"left_modifier:bank": v, "right_modifier:bank": v, ...}} }

   advance   in_game/common/advances            researched_advances (name=yes)
   policy    in_game/common/laws (2nd level)    implemented_laws (object=policy)
   privilege in_game/common/estate_privileges   implemented_privileges (object=)
   reform    in_game/common/government_reforms  implemented_reforms (object=)
   modifier  main_menu/common/static_modifiers  timed_modifiers (modifier=, x size)
   societal  in_game/common/societal_values     the value (-100..100): left side below 0
   Each is looked for in the base game and every dlc folder. Only the first value inside an object
   counts (later ones are usually alternatives under other conditions). */
"use strict";
const fs = require("fs"), path = require("path");

module.exports = function interestSources(game) {
  const T = { advance: {}, policy: {}, privilege: {}, reform: {}, modifier: {}, societal: {} };
  function scan(file, kind, depth) {
    let text; try { text = fs.readFileSync(file, "utf8"); } catch (e) { return; }
    const stack = [];
    for (let line of text.split("\n")) {
      line = line.replace(/#.*/, "");
      const open = line.match(/^\s*([A-Za-z_0-9]+)\s*=\s*\{/);
      const opens = line.split("{").length - 1, closes = line.split("}").length - 1;
      const scope = open ? [...stack, open[1]] : stack; // an inline "x = { ... }" block counts while we read it
      const m = line.match(/\b(bank_interest|bond_interest)\s*=\s*(-?[\d.]+)/);
      if (m && scope.length >= depth) {
        const name = scope[depth - 1], key = m[1] === "bank_interest" ? "bank" : "bond";
        const v = T[kind][name] || (T[kind][name] = {});
        if (kind === "societal") { const k = (scope[1] || "") + ":" + key; v[k] = (v[k] || 0) + +m[2]; }
        else if (v[key] === undefined) v[key] = +m[2];
      }
      if (opens > closes) { stack.push(open ? open[1] : "?"); for (let i = 1; i < opens - closes; i++) stack.push("?"); }
      else for (let i = 0; i < closes - opens; i++) stack.pop();
    }
  }
  const walk = (dir, fn) => {
    let e = []; try { e = fs.readdirSync(dir, { withFileTypes: true }); } catch (x) { return; }
    for (const d of e) { const p = path.join(dir, d.name); if (d.isDirectory()) walk(p, fn); else if (d.name.endsWith(".txt")) fn(p); }
  };
  let dlc = []; try { dlc = fs.readdirSync(path.join(game, "dlc")).map((d) => path.join(game, "dlc", d)); } catch (e) {}
  for (const r of [game, ...dlc]) {
    walk(path.join(r, "in_game/common/advances"), (f) => scan(f, "advance", 1));
    walk(path.join(r, "in_game/common/laws"), (f) => scan(f, "policy", 2));
    walk(path.join(r, "in_game/common/estate_privileges"), (f) => scan(f, "privilege", 1));
    walk(path.join(r, "in_game/common/government_reforms"), (f) => scan(f, "reform", 1));
    walk(path.join(r, "main_menu/common/static_modifiers"), (f) => scan(f, "modifier", 1));
    walk(path.join(r, "in_game/common/societal_values"), (f) => scan(f, "societal", 1));
  }
  // base values and the creditworthiness slope (in_game/common/auto_modifiers/country.txt)
  const auto = (() => { try { return fs.readFileSync(path.join(game, "in_game/common/auto_modifiers/country.txt"), "utf8"); } catch (e) { return ""; } })();
  const top = (k) => { const m = auto.match(new RegExp("^\\t" + k + "\\s*=\\s*(-?[\\d.]+)", "m")); return m ? +m[1] : null; };
  const cw = (auto.match(/creditworthiness_interest_impact\s*=\s*\{[\s\S]*?\n\}/) || [""])[0];
  const slope = (k) => { const m = cw.match(new RegExp("\\b" + k + "\\s*=\\s*(-?[\\d.]+)")); return m ? +m[1] : null; };
  T.base = { bank: top("bank_interest") ?? 0.10, bond: top("bond_interest") ?? 0.05 };
  T.credit = { bank: slope("bank_interest") ?? -0.05, bond: slope("bond_interest") ?? -0.04 }; // per (creditworthiness - 0.5)
  return T;
};

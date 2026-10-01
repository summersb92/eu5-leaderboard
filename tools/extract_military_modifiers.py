"""Build the modifier source tables used by js/worker.js.

The save doesn't store a country's discipline, levy combat ability, military
tactics, estate power or peasant enfranchisement; the page estimates them by adding up the
bonuses from sources the save does record. This script reads those bonuses
from an EU5 install and prints the JS table to paste over MIL_SOURCES (or,
with --estates, ESTATE_SOURCES) in js/worker.js after a game patch.

    py tools/extract_military_modifiers.py "C:/.../Europa Universalis V/game"
    py tools/extract_military_modifiers.py --estates "C:/.../game"
    py tools/extract_military_modifiers.py --units "C:/.../game"

--units prints UNIT_STATS instead: each army unit type's combat power and
damage modifiers, for the military power score.

Needs eu5_leaderboard.py (for its Clausewitz parser) next to this repo.
"""
import importlib.util
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    "lb", os.path.join(HERE, "..", "..", "eu5_leaderboard.py"))
lb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lb)

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
UNIT_CATS = {"light_infantry": "li", "heavy_infantry": "hi", "light_cavalry": "lc",
             "heavy_cavalry": "hc", "artillery": "art", "auxiliary": "aux"}
ESTATES = "--estates" in sys.argv
UNITS = "--units" in sys.argv
GAME = ARGS[0] if ARGS else \
    r"C:\Program Files (x86)\Steam\steamapps\common\Europa Universalis V\game"
ESTATE_TYPES = {"crown": "cr", "nobles": "n", "clergy": "c", "burghers": "b",
                "peasants": "p", "dhimmi": "dh", "tribes": "t", "cossacks": "co"}
if ESTATES:
    KEYS = {"global_%s_estate_power" % e: s for e, s in ESTATE_TYPES.items()}
    KEYS.update({"global_estate_power": "e", "crown_power_from_population": "cp",
                 "global_peasant_enfranchisment": "pe"})
    # the same bonuses when a building or location rank gives them locally
    LOCAL = {"local_%s_estate_power" % e: s for e, s in ESTATE_TYPES.items()}
    LOCAL["local_peasant_enfranchisment"] = "pe"
else:
    KEYS = {"discipline": "d", "levy_combat_efficiency_modifier": "l",
            "military_tactics": "t"}
    # combat power bonus for each unit category (li = light infantry, ...)
    KEYS.update({"army_%s_power" % c: UNIT_CATS[c] for c in UNIT_CATS})


def load(rel, keys=None):
    """Parsed top-level blocks of every .txt under rel (a dir) or rel (a file)."""
    keys = keys or KEYS
    path = os.path.join(GAME, rel)
    files = [path] if path.endswith(".txt") else sorted(
        os.path.join(path, f) for f in os.listdir(path) if f.endswith(".txt"))
    out = {}
    for p in files:
        t = open(p, encoding="utf-8-sig", errors="replace").read()
        if not any(k in t for k in keys):
            continue
        d = lb.parse(re.sub(r"#[^\n]*", "", t))
        if isinstance(d, dict):
            out.update({k: v for k, v in d.items() if isinstance(v, dict)})
    return out


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def direct(block, keys=None):
    """{short: value} for the keys set directly in block."""
    o = {}
    for k, short in (keys or KEYS).items():
        v = num(block.get(k)) if isinstance(block, dict) else None
        if v:
            o[short] = v
    return o


def blocks(block, key):
    """Modifier entries under block[key]; each may carry a has_reform
    condition. Blocks with any other condition are skipped - we can't check
    them from the save."""
    out = []
    for b in lb.as_list(block.get(key)) if isinstance(block, dict) else []:
        if not isinstance(b, dict):
            continue
        mods = direct(b)
        if not mods:
            continue
        cond = b.get("potential_trigger")
        if cond is not None:
            s = str(cond)
            m = re.fullmatch(r"\{'has_reform': 'government_reform:(\w+)'\}", s)
            n = re.fullmatch(r"\{'NOT': \{'has_reform': 'government_reform:(\w+)'\}\}", s)
            if m:
                mods["reform"] = m.group(1)
            elif n:
                mods["not_reform"] = n.group(1)
            else:
                continue
        out.append(mods)
    return out


def unit_stats():
    """{type: [combat power, damage done x, damage taken x, category]} for every
    army unit type, after copy_from, plus the age templates' stats for
    levies that haven't been raised yet. Damage done/taken average the
    strength and morale modifiers of the unit and its category."""
    cats = load("in_game/common/unit_categories", ["is_army"])
    types = load("in_game/common/unit_types", ["copy_from", "category"])

    def resolve(k, depth=0):
        b = types.get(k)
        if not isinstance(b, dict) or depth > 10:
            return {}
        base = resolve(b["copy_from"], depth + 1) if b.get("copy_from") else {}
        return {**base, **b}

    def f(b, k):
        return num(b.get(k)) or 0.0

    out = {}
    for k in types:
        u = resolve(k)
        cat = cats.get(u.get("category"))
        cp = num(u.get("combat_power"))
        if not cat or cat.get("is_army") != "yes" or cp is None:
            continue
        done = 1 + (f(u, "strength_damage_done") + f(cat, "strength_damage_done")
                    + f(u, "morale_damage_done") + f(cat, "morale_damage_done")) / 2
        taken = (num(cat.get("damage_taken")) or 1.0) * (
            1 + (f(u, "strength_damage_taken") + f(cat, "strength_damage_taken")
                 + f(u, "morale_damage_taken") + f(cat, "morale_damage_taken")) / 2)
        cls = UNIT_CATS.get(u["category"].replace("army_", ""), "hi")
        out[k] = [round(cp, 3), round(done, 3), round(taken, 3), cls]
    return out


if UNITS:
    print("const UNIT_STATS = " + json.dumps(unit_stats(), separators=(",", ":")) + ";")
    sys.exit(0)

table = {"advance": {}, "policy": {}, "privilege": {}, "reform": {},
         "societal": {}, "modifier": {}, "trait": {}}

for name, b in load("in_game/common/advances").items():
    if direct(b):
        table["advance"][name] = direct(b)
for law in load("in_game/common/laws").values():
    for pname, p in law.items():
        if isinstance(p, dict):
            got = blocks(p, "country_modifier")
            if got:
                table["policy"][pname] = got
for name, b in load("in_game/common/estate_privileges").items():
    got = blocks(b, "country_modifier")
    if got:
        table["privilege"][name] = got
for name, b in load("in_game/common/government_reforms").items():
    got = blocks(b, "country_modifier")
    if got:
        table["reform"][name] = got
for name, b in load("in_game/common/societal_values").items():
    sides = {s: direct(b.get(s + "_modifier") or {}) for s in ("left", "right")}
    sides = {s: v for s, v in sides.items() if v}
    if sides:
        table["societal"][name] = sides
# Static modifiers can be applied to a country as timed modifiers.
for rel in ("main_menu/common/static_modifiers/country.txt",
            "main_menu/common/static_modifiers/religion.txt",
            "main_menu/common/static_modifiers/D008_fate_of_the_phoenix_modifiers.txt"):
    for name, b in load(rel).items():
        if direct(b) and not name.startswith(("qa_", "difficulty_")):
            table["modifier"][name] = direct(b)
for name, b in load("in_game/common/traits/00_ruler.txt").items():
    got = direct(b.get("modifier") or {})
    if got:
        table["trait"][name] = got

if ESTATES:
    # Location bonuses: per building level, and per location rank.
    table["building"] = {}
    for name, b in load("in_game/common/building_types", LOCAL).items():
        got = direct(b.get("modifier") or {}, LOCAL)
        if got:
            table["building"][name] = got
    table["rank"] = {}
    for name, b in load("in_game/common/location_ranks", LOCAL).items():
        got = direct(b.get("rank_modifier") or b.get("modifier") or b, LOCAL)
        if got:
            table["rank"][name] = got
    print("const ESTATE_SOURCES = " + json.dumps(table, separators=(",", ":")) + ";")
else:
    print("const MIL_SOURCES = " + json.dumps(table, separators=(",", ":")) + ";")

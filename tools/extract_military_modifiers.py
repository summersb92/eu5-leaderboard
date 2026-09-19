"""Build the discipline / levy-combat source table used by js/worker.js.

The save doesn't store a country's discipline or levy combat ability; the
page estimates them by adding up the bonuses from sources the save does
record. This script reads those bonuses from an EU5 install and prints the
JS table to paste over MIL_SOURCES in js/worker.js after a game patch.

    py tools/extract_military_modifiers.py "C:/.../Europa Universalis V/game"

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

GAME = sys.argv[1] if len(sys.argv) > 1 else \
    r"C:\Program Files (x86)\Steam\steamapps\common\Europa Universalis V\game"
KEYS = {"discipline": "d", "levy_combat_efficiency_modifier": "l"}


def load(rel):
    """Parsed top-level blocks of every .txt under rel (a dir) or rel (a file)."""
    path = os.path.join(GAME, rel)
    files = [path] if path.endswith(".txt") else sorted(
        os.path.join(path, f) for f in os.listdir(path) if f.endswith(".txt"))
    out = {}
    for p in files:
        t = open(p, encoding="utf-8-sig", errors="replace").read()
        if not any(k in t for k in KEYS):
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


def direct(block):
    """{d, l} for discipline / levy keys set directly in block."""
    o = {}
    for k, short in KEYS.items():
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

print("const MIL_SOURCES = " + json.dumps(table, separators=(",", ":")) + ";")

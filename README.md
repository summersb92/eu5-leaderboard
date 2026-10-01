# EU5 Leaderboard (web)

A static web page that builds a standings report from a Europa Universalis V
save — the player nations' population, tax base, armies, coats of arms, a
political map and a blood ledger. It's the browser version of
`eu5_leaderboard.py`: everything runs client-side in a Web Worker, so saves
are never uploaded and the site needs no server.

## Using it

1. Make a readable save: add `-debug_mode` to the game's Steam launch
   options, load your save and save again.
2. Open the page and drop the `.eu5` file on it. In Chrome and Edge, saves
   you pick or drop appear under **Recent saves** for one-click rebuilds on
   later visits (the browser keeps a file handle, not the file or a path).
3. Coats of arms and the map are built in, from a hosted game-data pack
   (see below), so a save is all anyone needs. The report's map is
   interactive: the whole world, scroll or pinch to zoom, drag to move,
   hover or tap any location for its owner, population, development,
   control and tax, and map modes for players, all nations, development,
   population, control, tax and prosperity.
4. *(Optional)* Compare saves over time: give it two or more saves from
   the same campaign (pick or drop them together, tick them under **Recent
   saves**, or use **Add a save to compare** on a built report). The newest
   save becomes the report; an **Over time** section charts each figure per
   nation and tabulates what changed between any two saves, and the
   standings can show each figure's change. Nations are matched by the
   save's country id, so tag changes (Castile → Spain) are followed.
5. **Download report** saves a self-contained HTML file to share.
   **Download data** saves the numbers as JSON; drop that back on the page to
   rebuild the report without the save.

## How it works

| File | Role |
| --- | --- |
| `index.html`, `css/app.css`, `js/app.js` | Page, file picking, report assembly |
| `js/worker.js` | Save parsing, stats, coat-of-arms rendering, map painting |
| `js/dds.js` | BC1/BC3/BC7 texture decoding for the coat-of-arms `.dds` files |
| `report-template.html` | The report page (same template as the Python script) |

Output matches the Python script: extracted numbers are identical, and the
map is within one colour level per pixel. Flags differ only by resampling
filter.

## Share links

**Generate link** stores the report (with the sharer's column layout) as a
secret gist on the sharer's GitHub account, via a token with only the `gist`
scope, and gives a link like `…/eu5-leaderboard/?view=<gist id>&u=<owner>`.
That opens the page in viewer mode: the report only, no upload controls.
Each report has a key: a SHA-256 of what its saves contain (each save's
campaign and date, and every player nation's id, population, tax base and
locations), stored in the gist's description. Sharing the same saves again -
in any order, from save files or a data file, on any computer - finds that
gist and reuses its link instead of making another. Different saves get a
new link, with an option to put them behind the campaign's earlier link. Viewers read the gist through the GitHub API (60 requests an hour
per viewer) and fall back to the raw gist file.

## Game-data packs

`gamedata/<version>/` holds what reports need from the game, so nobody has
to link an install: `flags/tag-<TAG>.png` (every country's coat of arms,
pre-rendered with the page's own renderer; the `tag-` prefix keeps names
like `AUX` and `CON` legal on Windows), `locations.png` (the game's own map
image), `locations_half.png` (a half-resolution copy whose pixels hold
location ids, for the interactive map), `map.json` (each location's colour,
name and land/water, each tag's map and secondary colours), `advances.json`
(each advance's age, research cost multiplier, institution and starting
level) and `pack.json` (game version, version name, Steam
build). `gamedata/index.json` lists the packs. A report uses the pack for
the version its save records, else the newest, and says which it used.

Current pack: **EU5 1.3.11 "Pavia"**, Steam build 24187685, 1,937 flags.
The page doesn't link a game folder any more; the worker still can, and the
pack builder uses that.

After a game patch, open `tools/build-pack.html` (served over HTTP), point it
at the install, enter the version, name and Steam build id (from
`steamapps/appmanifest_3450310.acf`), build, and unzip the result into the
repository root.

Coat-of-arms and map images are from Europa Universalis V (c) Paradox
Interactive, included for non-commercial fan use.

## Military estimates

Saves don't record discipline, levy combat ability or potential levies, so
the page estimates them. Discipline and levy combat add up the bonuses from
what the save does record (advances, laws, privileges, reforms, societal
values, event modifiers, ruler traits), using a table built from the game
files; potential levies sum the levy figures the save keeps for each
location's pops. After a game patch, regenerate the table with
`py tools/extract_military_modifiers.py` and paste it over `MIL_SOURCES` in
`js/worker.js`.

## Capital & governor finder

`placement.html` uses the same save reading and game-data pack to find where
a nation's capital and local governors would spread the most proximity. Pick
a nation (players first) and it tries every owned location as a new local
governor and as the capital, then the best few capitals each with their own
governors, and ranks them by the settled tax base they add: each location's
possible tax times the max control its proximity gives (0.75% per point).
Governors are placed one after another, each where it adds the most on top
of the last. By default it only suggests cities with a road to the capital;
untick that to see where to build towards. A governor still being built
counts as finished unless you untick that too.

| File | Role |
| --- | --- |
| `placement.html`, `css/placement.css`, `js/placement.js` | Page, results, proximity map |
| `js/placement-worker.js` | Reads the save (via `worker.js`) and runs the searches |
| `js/proximity.js` | The proximity model; also loads in Node for testing |
| `tools/build_proximity_graph.js` | Builds `gamedata/<version>/proximity.json` |

### Placement model

Proximity starts at 100 in the capital and 80 at a local governor; each hop
to a neighbouring location costs, from the game files: 40 overland, the
road's cost along a road (20, less 5/10/15 for paved, modern and rail), 12
along a river, 30 at sea blending to 5 with the country's maritime presence,
5 on lakes. Overland hops are raised by the terrain of the location being
left (mountains +50%, forest +25%, ...) and cut by up to 20% for its
development. Moving between land and sea costs 35, less up to half with the
natural harbour, through ports only; those two numbers were fitted to real
saves rather than read from the game.

Everything else that changes proximity costs for a country (advances,
laws, societal values) is folded into one factor per nation, fitted to the
proximity the save records for each of its locations; the page reports how
close the fit is. Against a 1385 multiplayer save the mean error was 0.7 to 6
proximity per location depending on the nation; sea and lagoon routes are
the weakest part.

`proximity.json` holds each location's borders (from `locations.png` and
`adjacencies.csv`), river links (`rivers.png`), ports (`ports.csv`),
terrain, natural harbour, English name and centre, plus the base costs.
After a game patch, rebuild it next to the pack's `map.json`:

```
node tools/build_proximity_graph.js "<EU5 install>/game" 1.3.11
```

## Urban rights advisor

`rights.html` values every urban right in every location of a nation, from
what the save says each location makes. It's built around the nine
**Borough Privileges** rights (Printing, Textile, Tooling, Weaponry,
Artisan, Spirituous, Masonry, Jewelry, Naval Supplies): each adds 20-30%
output of two or three goods in the location and costs 5% production
efficiency there. Untick *Borough Privileges rights only* to include the
regional rights with goods bonuses too (Tjärprivilegier, Bergslag...).

For each location it reads the RGO's workers, and every building's level,
staffing and production method, scales them so the location's share
matches its market's recorded supply of each good (from raw materials and
from buildings), and prices them at that market. A right's value is the
change in output value: its bonus on the goods it boosts (RGO and
buildings alike) less 5% of every building's output. Production efficiency
is a building modifier, so the RGO doesn't pay the penalty unless you tick
the pessimistic option. Building inputs don't change, so the gain is all
profit.

It lists the best grant for each town and city with a free slot (a town
holds one right, a city two, a megalopolis three), the full breakdown for
any location, the guilds worth growing for its best right, and **future
towns**: rural locations and towns whose RGO a right boosts, or whose raw
material is the main input of a guild a right boosts. For those it sizes
a guild to use all the RGO's output (up to 10 levels, among the buildings
the nation has unlocked) and shows its margin per level and what the
right would add. The map shows the best right, that town potential, or
one right's value everywhere.

| File | Role |
| --- | --- |
| `rights.html`, `css/rights.css`, `js/rights.js` | Page, tables, map |
| `js/rights-worker.js` | Reads the save (via `worker.js`) |
| `js/rights-model.js` | Save readers and the valuation; also loads in Node |
| `tools/build_rights_data.js` | Builds `gamedata/<version>/rights.json` |

`rights.json` holds every urban right (modifiers, unlocking advance,
port/raw-material/rank conditions, exclusions), every building that makes
goods (employment per level, ranks, unlocking advances, production
methods) and every good's default price. After a game patch:

```
node tools/build_rights_data.js "<EU5 install>/game" 1.3.11
```

## Institutions

The report shows which institutions each nation has embraced and, for each
one that has appeared somewhere but it hasn't embraced, the share of its
people exposed to it: the save keeps each location's exposure, weighted here
by population. 20% exposure is enough to embrace one. With several saves, a
table shows what each nation embraced between one save and the next, and
**Over time** charts the count.

Each embraced institution also shows the advances gained from it since the
game began (those it unlocks, directly or through the advances they require)
and the research they cost, and each nation its total advances gained and
research paid. Advances gained are the ones the save has, less those the
nation started with (from the game files' starting technology levels). The save doesn't record research costs, so
they're estimated from the game's cost rules: a base of 25 research, 15% more
each age, times the advance's own `research_cost` multiplier. The game makes
advances from an earlier age cheaper, so the estimate can run high. Which
institution each advance belongs to, its age and its multiplier come from
`advances.json` in the game-data pack.

## Running locally

The page fetches its report template, so serve it over HTTP rather than
opening the file directly:

```
python -m http.server
```

then open http://localhost:8000.

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

## Saves shared between pages

The save follows you from page to page. `js/saves.js` keeps one *current
save* for every page: the File itself, stored in IndexedDB, so any page can
load it without a permission prompt, in any browser. Whichever page last
opened a save sets it: the leaderboard its newest save after a build, a tool
page the save dropped, picked or reopened there. The change is announced on
a `BroadcastChannel`, and pages also check when they come back into view
(switching tabs, back/forward).

- The tool pages load the current save as they open and reload when another
  page makes a different save current. The box above the drop zone names it
  and the page it came from, beside the recent list.
- The leaderboard keeps its last report in IndexedDB and shows it again at
  once when you come back. If a different save became current since that
  report was built, it builds that save instead.
- The nation picked on any page (by tag, in `localStorage`) is the one the
  other pages open on, when the save has it.

Remembered saves (file handles, Chrome and Edge) are shared by every page
too; saves opened on any page join the recent list.

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

Current packs: **EU5 1.4.5 "Río Salado"**, Steam build 26211608, 1,955 flags,
28,573 locations (1.4 renamed or reordered about 5,000 of them, so 1.4 saves
need this pack; 1.4.0-1.4.4 saves fall back to it as the newest), and
**EU5 1.3.11 "Pavia"**, Steam
build 24187685, 1,937 flags, for older saves.
The page doesn't link a game folder any more; the worker still can, and the
pack builder uses that.

After a game patch, open `tools/build-pack.html` (served over HTTP), point it
at the install, enter the version, name and Steam build id (from
`steamapps/appmanifest_3450310.acf`), build, and unzip the result into the
repository root.

Coat-of-arms and map images are from Europa Universalis V (c) Paradox
Interactive, included for non-commercial fan use.

## Military estimates

Saves don't record discipline, levy combat ability, military tactics,
unit-type combat bonuses or potential levies, so the page estimates them.
The modifiers add up the bonuses from what the save does record (advances,
laws, privileges, reforms, societal values, event modifiers, ruler traits,
the state religion, religious school and chosen religious aspects), using a
table built from the game files. After a game patch, regenerate the table with
`py tools/extract_military_modifiers.py` and paste it over `MIL_SOURCES` in
`js/worker.js`.

## Levies

**Levies** counts every levy a nation has, raised and unraised (hover or
open a nation for the split and the full pool). 1.4 saves keep a levy pool
per province, `army_levies={<country>={current max}}`: *current* is what is
still at home, *max* the whole pool when recovered (levies take 20 years
to come back after being called up, or killed). Only provinces whose levies
have been drawn on have one. Elsewhere the pool is estimated from the pops:
2% of peasants, laborers, soldiers and tribesmen (burghers from the Age of
Discovery) and 10% of nobles (`levy_generic_*_size`), times the ratio of
real pools to that figure in the nation's own drawn provinces, or the
world's (0.79 in a 1442 save). The ratio swings a lot between provinces, so
those parts are rough. Older saves keep a levy figure per pop type and
location instead, only for pops drawn on; the others get the same estimate.

## Population growth

**Natural growth** is what last month's births less starvation and disease
(each location's `pop_stats.<type>.changes`: `Reproduction`, `Starvation`,
`Disease`) would add in a year, as a share of the population. Migration is
counted apart, and conquest isn't in it at all, unlike the yearly population
history.

## Tax from RGOs and buildings

Each location's tax to the treasury (its tax times its estates' tax rates)
is split between its RGO and its buildings in proportion to RGO output
value and building profit, each weighted by how much location wealth a
gold of it makes across the whole save (`wealthFit` in `js/loans-model.js`,
about 0.77 and 1.06). The parts are scaled to the save's tax income. It
reads the buildings and markets with the loan advisor's readers and needs
`rights.json` from the game-data pack.

## Military strength

The **Military strength** section ranks the nations by one number, their
military power, in thousands of plain regular infantry (combat power 1, no
discipline, military tactics 1): 10,000 such men score 10. It's built from
the game's own combat rules:

- **Damage dealt** by each regiment: its unit type's combat power (from
  `unit_types`, after `copy_from`: infantry 1, cavalry 4, artillery 2-7.5,
  support 0.25) x (1 + the nation's bonus for that unit category, e.g.
  `army_heavy_infantry_power` +10% from an advance) x men x (1 +
  discipline) x the type's damage-done modifiers. Levies deal 75% of that (`LAND_LEVY_COMBAT_IMPACT`) x (1 +
  levy combat ability), with 10% less discipline (`is_army_levy`).
- **Damage it can take**: men x military tactics x (1 + discipline) over
  its category's and type's damage-taken modifiers, raised by experience
  (up to half less damage, `LAND_EXPERIENCE_DAMAGE_REDUCTION`).
- **Power** = sqrt(dealt x taken) summed over the army - Lanchester's
  square law, so it grows in step with army size.

The table shows the modifiers behind each score: discipline (and what
levies get after their -10%), military tactics, levy combat (and the
damage multiplier levies end up with), and the combat power bonus for each
unit category with the men of that category beneath it. Hover any of them
for the advances, laws, privileges and so on that make it up.

*Power* counts every regiment plus the levies that haven't been raised yet
(nobles' levies as the current age's heavy cavalry, everyone else's as its
light infantry); *in field* counts only what is under arms now; *per 1k
men* shows quality. Military tactics is estimated like discipline (base 1
plus advances, laws, societal values...). Unraised levies are those still
at home (see Levies), so a nation that has just fought a war can show few.
Estate power, favoured gods, generals, morale, terrain, supply, combined
arms, forts and navies are left out.

The unit table (`UNIT_STATS` in `js/worker.js`) comes from
`py tools/extract_military_modifiers.py --units`; rerun it after a patch.

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

Both tables sort by clicking a column header (the # column keeps each
location's place in the model's ranking) and filter by minimum tax base
gained, location, rank, and whether a governor can be built there or the
capital's average proximity; they list every location, not just the top
few. The table code is shared with the rights advisor in `js/grid.js`.

### Map

The map colours the nation by proximity: as the save records it, as the
model rebuilds it today, with the suggested governors, with the suggested
capital and governors, or the proximity those governors add. Hover a
location for all of those at once.

**One location** shows a single candidate on its own. Pick a location and
whether it's a new governor (with today's capital and governors) or the
capital (keeping the governors you have), then show either the proximity
it would give or the proximity it would gain over today. Moving the
capital usually costs proximity somewhere, so losses show in blue and gains
in orange. The line above the map gives the settled tax base it adds and
the average proximity, the same figures as its row in the tables. Clicking
a location on the map picks it; clicking a row in the governor table picks
it as a governor, and in the capital table as the capital. The worker
works out each candidate's proximity on request from the analysis it
already holds, so picking one is quick.

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

Every list sorts by clicking a column header, and the three main lists
filter by minimum gold a month, location name, rank, right and (for towns
and cities) a free slot. Sorts and filters are remembered in the browser.

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

## Privateer finder

`privateers.html` ranks the sea areas a nation could send privateers to. A
privateer is hired for a whole sea area (one per country per area), needs
`can_hire_privateers` (the Privateers or Letters of Marque advance, the state
piracy policy, a few reforms), and the area must be within naval range and
border a port whose owner you haven't given an anti-piracy agreement. For each
area it adds up:

- **Plunder**: gold from every port along the area that can be raided: not
  yours, your subjects' or overlord's, not behind a coastal fort or naval
  battery (`blocks_privateer_raids`), not an anti-piracy partner's. The game
  works out each port's take in its engine; the files only give
  `PRIVATEER_STEAL_MONEY_FACTOR = 0.01`. The page uses 0.01 × the trade
  flowing through the port (`value_flow`) at full power by default.
  **Unverified**: the *Calibrate* box under an area takes the per-location
  gold the game's Privateering tooltip shows, fits the factor for trade, tax
  and possible tax, and remembers the choice.
- **Rivals' shipping**: others' average maritime presence in the area's sea
  zones, weighted like the AI's `HOW_MUCH_WE_CARE_ABOUT_PRIVATEERING_*`
  defines (enemies at war and rivals 1, neutrals 0.2, allies, subjects and
  overlords 0).
- **Pirate hunters**: last month's anti-piracy harassment the save keeps per
  area (`privateer_manager.pirate_harassment`); each point costs about 0.5%
  power a month (`PRIVATEER_HARASSMENT_IMPACT`).
- **Opinion**: each robbed owner's hit from `opinion_placed_privateers`:
  −250 × (gold taken ÷ 10% of its monthly income, at least 5 gold), floored
  at −100.
- **Distance**: sailing distance (Dijkstra over sea-zone centres, full-size
  map pixels) from the sea zones off your and your subjects' ports, against
  naval range (base 1,000 from `auto_modifiers`, plus naval advances). The
  game's own measure may differ, so the range box is editable.

The score is the weighted sum of those, each scaled to the best area. The
weights, the per-port base and its factor are controls on the page.

The page opens on a **game-start view** with no save needed:
`gamedata/<version>/privateer-start.json`, a 0.6 MB snapshot of what the
model reads (owners, port tax and trade, maritime presence, relations,
privateering advances; player names dropped). Dropping a save replaces it,
and *Back to the game-start view* returns to it. The snapshot is the world on
**1337.4.1**, from a multiplayer hotjoin save: when someone joins a game in
progress the game writes the whole state as plaintext to
`Documents/Paradox Interactive/Europa Universalis V/oos/<id>/hotjoinsave_*.txt`
(desync dumps there, `savegame_oos_*.oos`, are plaintext saves too), so a
hotjoin on day one is a true start save. No month has passed at 1337.4.1, so
countries' income is 0; the opinion estimate then stands in each country's
tax base. To rebuild it:

```
node tools/privateers.js start "<oos folder>/hotjoinsave_8.txt" 1.3.11 --you=TEU
```

The 1.4.5 pack has no game-start view yet: 1.4 renamed or reordered about
5,000 locations, so the 1.3.11 snapshot doesn't fit it. On 1.4 the page asks
for a save until a 1.4 day-one hotjoin save is turned into one.

`--you` picks the nation the page opens on (hotjoin saves don't name one).
Any page that reads saves accepts these header-less plaintext files.

The same tool tests the model from the command line, on a save or the
snapshot (`--all` adds areas out of range):

```
node tools/privateers.js rank "<save>.eu5" TEU
node tools/privateers.js rank start TEU
```

| File | Role |
| --- | --- |
| `privateers.html`, `css/privateers.css`, `js/privateers.js` | Page, scoring, tables, map |
| `js/privateer-worker.js` | Reads the save (via `worker.js`) |
| `js/privateer-model.js` | The model; also loads in Node for testing |
| `tools/build_privateer_data.js` | Builds `gamedata/<version>/privateer.json` |
| `tools/privateers.js` | Command line: rank areas from a save, or build `privateer-start.json` |

`privateer.json` holds every sea area and its zones, the raid-blocking
buildings, the advances, policies and reforms that touch privateering, and
the defines above. After a game patch (needs `proximity.json` first):

```
node tools/build_privateer_data.js "<EU5 install>/game" 1.3.11
```

## Loan & build advisor

`loans.html` prices every building project of a nation and says which of
them a loan or a government bond would pay for, and where. It reads what
the nation owes (`loan_manager`), its treasury, income, creditworthiness
and estate tax rates, and for each owned location what one more level of
something would add to the treasury:

- **Expand** a building it has, at the profit per level that building makes
  now (`last_months_profit`). Not if it is laying off workers, under 90%
  staffed, at its level cap, or there are no unemployed pops of its type.
- **Build** one it doesn't have, at that building's profit per level across
  the same market (all its profit there over all its levels, idle ones
  counting as zero). Not if any of them in the market is laying off workers.
- **RGO**: one more worker slot, at what each RGO worker of that good makes
  in the market. Unemployed laborers and peasants (who promote) fill it.

A building's profit is location wealth, not treasury gold. The part under
control is tax base, split between the estates by their share of the
location's wealth (`estate_possible_tax`); each pays its rate
(`economy.tax_rates`). So the treasury gets profit x control x the
location's estate-weighted tax rate. Summed over the nation's tax base this
rebuilds the save's `last_months_tax_income` to within about 1% (19.59
against 19.71 for Milan in a 1372 save). How much wealth a gold of building
profit and of RGO output makes is fitted per save over every location
(`possible_tax` against both; 1.06 and 0.77 in that save).

Costs are the building's base price (`p_building_age_N` by the age of the
advance that unlocks it, `p_expensive_...` for `expensive = yes`, or its
own `price`) times the nation's cost factor: what its constructions in
`construction_manager` actually paid over that base (about 0.72 for Milan:
36 gold for a 50-gold building), or the world's if it isn't building. RGO
expansion is 100 x (0.5 + 0.25 x price) x the same kind of factor. Level
caps evaluate the game's `*_max_level` script values (base, development,
population, RGO size, city/megalopolis bonus, low market access penalty).

Loans in EU5 are interest only: amount x yearly rate / 12 a month, with the
principal due at the end of the term (or extended, -0.03 creditworthiness).
So a level pays for a loan if it returns its interest plus principal / term
a month; a bond, which never falls due, only has to return its interest.
The page shows each project's break-even, how much of it the return covers,
the rate up to which it covers its interest, and its cash payback. The
**plan** takes the projects that pay for themselves, best return per gold
first, up to a budget, adding no more levels of a building to a market than
it already has there and none where that building is laying off workers.
Rates start at the lowest the nation pays now (else the world's median).

Not counted: building upkeep, price changes as supply grows, and what
buildings do besides make goods.

| File | Role |
| --- | --- |
| `loans.html`, `css/loans.css`, `js/loans.js` | Page, tables, map |
| `js/loans-worker.js` | Reads the save (via `worker.js` and `rights-model.js`) |
| `js/loans-model.js` | Save readers, the treasury model and the plan; also loads in Node |
| `tools/build_loan_data.js` | Builds `gamedata/<version>/loans.json` |
| `tools/loans.js` | Command line: price a nation's projects from a save |

`loans.json` holds each building's base price and level cap, the cap
formulas, RGO expansion prices and the loan defines. It needs `rights.json`
beside it. After a game patch:

```
node tools/build_loan_data.js "<EU5 install>/game" 1.3.11
node tools/loans.js "<save>.eu5" MLO --bond --budget=500
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

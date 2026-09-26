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

## Institutions

The report shows which institutions each nation has embraced and, for each
one that has appeared somewhere but it hasn't embraced, the share of its
people exposed to it: the save keeps each location's exposure, weighted here
by population. 20% exposure is enough to embrace one. With several saves, a
table shows what each nation embraced between one save and the next, and
**Over time** charts the count.

Each embraced institution also shows the advances learned from it (those
it unlocks, directly or through the advances they require) and the research
they cost, and each nation its total advances and research paid, leaving out
the advances it started with. The save doesn't record research costs, so
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

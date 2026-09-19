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
3. *(Optional)* Link your `Europa Universalis V` install so the report gets
   coats of arms and the map; the game's files are read locally and never
   redistributed. **Choose game folder** uses Chrome/Edge's folder picker,
   and the folder is remembered for later visits. That picker refuses
   anything under `Program Files` (the Steam default), so either drag the
   folder onto the page (works, but only for that visit) or give it a
   junction outside `Program Files` once (the page shows the command) and
   pick that. Firefox and Safari use a plain folder input with no such
   restriction and no memory.
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

## Military estimates

Saves don't record discipline, levy combat ability or potential levies, so
the page estimates them. Discipline and levy combat add up the bonuses from
what the save does record (advances, laws, privileges, reforms, societal
values, event modifiers, ruler traits), using a table built from the game
files; potential levies sum the levy figures the save keeps for each
location's pops. After a game patch, regenerate the table with
`py tools/extract_military_modifiers.py` and paste it over `MIL_SOURCES` in
`js/worker.js`.

## Running locally

The page fetches its report template, so serve it over HTTP rather than
opening the file directly:

```
python -m http.server
```

then open http://localhost:8000.

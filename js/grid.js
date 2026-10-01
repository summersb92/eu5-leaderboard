/* Sortable, filterable tables, shared by the capital finder and the urban
   rights advisor.

     const g = EU5Grid("<storage key>");
     g.grid(id, cols, rows, opts)

   Draws <table id> from row objects.
     cols  [{key, label, num, sort: (row) => value, cell: (row) => html, cls}]
           a column with `sort` gets a clickable header; numbers sort
           largest first on the first click
     rows  objects; `loc` makes the row clickable (class "click", data-loc)
           unless opts.click === false; `cls` adds row classes
     opts  sort     the column key sorted by at first
           empty    text when there are no rows at all
           filters  [{type: "min"|"q"|"select"|"check", key, label, ...}]
                    min    row[key] >= value        (step)
                    q      row[key] contains text   (placeholder)
                    select row[key] === value       (options: [[value, text]],
                           or omitted to list the values the rows have,
                           labelled by text(value))
                    check  row[key] is truthy
                    Their bar goes in #<id>-f, with a "shown" count.
   Sorts and filters are kept per table in localStorage. */
"use strict";
function EU5Grid(storeKey) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const byId = (id) => document.getElementById(id);
  const state = (() => { try { return JSON.parse(localStorage.getItem(storeKey)) || {}; } catch (e) { return {}; } })();
  const save = () => { try { localStorage.setItem(storeKey, JSON.stringify(state)); } catch (e) {} };
  const data = {};

  function grid(id, cols, rows, opts = {}) {
    if (!state[id]) state[id] = { sort: opts.sort || null, desc: true, f: {} };
    if (!state[id].f) state[id].f = {};
    data[id] = { cols, rows, opts };
    if (opts.filters && opts.filters.length) bar(id);
    draw(id);
  }

  function bar(id) {
    const box = byId(id + "-f");
    if (!box) return;
    const { rows, opts } = data[id], st = state[id].f;
    box.innerHTML = opts.filters.map((f) => {
      const v = st[f.key];
      if (f.type === "min")
        return `<label class="fl"><span>${esc(f.label)}</span><input type="number" step="${f.step || 0.5}" data-k="${f.key}" data-t="min" ` +
          `value="${v ?? ""}" placeholder="any"></label>`;
      if (f.type === "q")
        return `<label class="fl"><span>${esc(f.label)}</span><input type="search" data-k="${f.key}" data-t="q" value="${esc(v || "")}" ` +
          `placeholder="${esc(f.placeholder || "name…")}"></label>`;
      if (f.type === "select") {
        let options = f.options;
        if (!options) {
          const seen = [...new Set(rows.map((r) => r[f.key]).filter((x) => x != null && x !== ""))];
          options = seen.map((x) => [x, f.text ? f.text(x) : x]);
          if (f.order) options.sort((a, b) => f.order(a[0]) - f.order(b[0]));
          else options.sort((a, b) => String(a[1]).localeCompare(String(b[1])));
        }
        return `<label class="fl"><span>${esc(f.label)}</span><select data-k="${f.key}" data-t="select"><option value="">all</option>` +
          options.map(([val, text]) => `<option value="${esc(val)}"${String(v) === String(val) ? " selected" : ""}>${esc(text)}</option>`).join("") +
          `</select></label>`;
      }
      if (f.type === "check")
        return `<label class="chk fl"><input type="checkbox" data-k="${f.key}" data-t="check"${v ? " checked" : ""}> ${esc(f.label)}</label>`;
      return "";
    }).join("") + `<button type="button" class="linkbtn" data-reset>Clear filters</button><span class="flcount" id="${id}-n"></span>`;
    box.oninput = box.onchange = (e) => {
      const el = e.target, k = el.dataset.k;
      if (!k) return;
      st[k] = el.type === "checkbox" ? el.checked : el.type === "number" ? (el.value === "" ? null : +el.value) : el.value;
      save();
      draw(id);
    };
    box.querySelector("[data-reset]").onclick = () => { state[id].f = {}; save(); bar(id); draw(id); };
  }

  function draw(id) {
    const { cols, rows, opts } = data[id], st = state[id], f = st.f;
    const filters = opts.filters || [];
    let list = rows.filter((r) => filters.every((fl) => {
      const v = f[fl.key];
      if (v == null || v === "" || v === false) return true;
      if (fl.type === "min") return (r[fl.key] ?? -Infinity) >= v;
      if (fl.type === "q") return String(r[fl.key] || "").toLowerCase().includes(String(v).trim().toLowerCase());
      if (fl.type === "select") return String(r[fl.key]) === String(v);
      if (fl.type === "check") return !!r[fl.key];
      return true;
    }));
    const col = cols.find((c) => c.key === st.sort);
    if (col && col.sort) {
      const dir = st.desc ? -1 : 1;
      list = [...list].sort((a, b) => {
        const x = col.sort(a), y = col.sort(b);
        if (x == null || x === "") return y == null || y === "" ? 0 : 1;
        if (y == null || y === "") return -1;
        return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * dir;
      });
    }
    const t = byId(id);
    const clickable = (r) => r.loc != null && opts.click !== false;
    t.innerHTML = "<thead><tr>" + cols.map((c) => {
      const on = c.key === st.sort, arrow = on ? (st.desc ? " ▼" : " ▲") : "";
      return `<th class="${c.num ? "n" : ""}${c.sort ? " sortable" : ""}" data-key="${c.key}"` +
        (c.sort ? ` aria-sort="${on ? (st.desc ? "descending" : "ascending") : "none"}" title="Sort by ${esc(c.label || "this")}"` : "") +
        `>${c.label}${arrow}</th>`;
    }).join("") + "</tr></thead><tbody>" +
      (list.length ? list.map((r, i) => `<tr class="${r.cls || ""}${clickable(r) ? " click" : ""}"${clickable(r) ? ` data-loc="${r.loc}"` : ""}>` +
        cols.map((c) => `<td class="${c.num ? "n " : ""}${c.cls ? (typeof c.cls === "function" ? c.cls(r) : c.cls) : ""}">${c.cell(r, i)}</td>`).join("") +
        "</tr>").join("")
        : `<tr><td colspan="${cols.length}" class="dim">${rows.length ? "Nothing matches the filters." : esc(opts.empty || "Nothing here.")}</td></tr>`) +
      "</tbody>";
    t.querySelectorAll("th.sortable").forEach((th) => th.addEventListener("click", () => {
      const k = th.dataset.key, c = cols.find((x) => x.key === k);
      if (st.sort === k) st.desc = !st.desc;
      else { st.sort = k; st.desc = !!c.num; }
      save();
      draw(id);
    }));
    const n = byId(id + "-n");
    if (n) n.textContent = list.length === rows.length ? `${rows.length} shown` : `${list.length} of ${rows.length} shown`;
  }

  return { grid, redraw: draw };
}

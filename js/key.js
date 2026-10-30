// The period bar's artist key (a chip per artist in the rolling chart) and the search that pins artists.
import { focusArtist, showArtists } from "./charts.js";
import { dur, flip, GROW_MS, EASE_OUT } from "./motion.js";
import { $, state, noun } from "./state.js";
import { mixArgs, MAX_PINS, pin } from "./rollingview.js";

// The hovered artist lights everything that belongs to them, as pinning does: their chip in the period bar's
// key (the mix bar is lit in mix.js)
let listFocus = null;
export function paintFocus(name = listFocus) {
  listFocus = name;
  for (const item of document.querySelectorAll("#artist-key [data-artist]")) {
    item.classList.toggle("focus", name != null && item.dataset.artist === name);
  }
}

// The artist key in the period bar, for every graph: a chip per artist in the rolling chart, in its order and
// colors. The box shows or hides the artist everywhere, clicking the name pins or unpins them, and hovering lights
// them everywhere. Pinned chips are tinted and outlined. It's led by a box that shows or hides every
// unpinned artist at once. Chips that stay glide to their new places when the artists change.
export function paintArtistKey() {
  if (!mixArgs) return;
  const [artists, , , pins] = mixArgs;
  // mixArgs can lag a render behind the colors, so leave out any artist without a slot yet
  const keyed = artists.filter((a) => state.colorSlots.has(a));
  const hover = (name) => focusArtist($("chart-rolling"), name);
  const key = $("artist-key");
  const chips = (root) => new Map([...root.querySelectorAll("[data-artist]")].map((el) => [el.dataset.artist, el]));
  const before = new Map([...chips(key)].map(([n, el]) => [n, el.getBoundingClientRect()]));
  // The chips are rebuilt, so a CSS transition can't run: a chip whose outline or tint changes (pinned or
  // unpinned, shown or hidden) fades from how it looked to how it looks now
  const looks = (el) => {
    const cs = getComputedStyle(el);
    return { borderColor: cs.borderColor, backgroundColor: cs.backgroundColor, opacity: cs.opacity };
  };
  const looked = new Map([...chips(key)].map(([n, el]) => [n, looks(el)]));
  // The boxes' fill (and the all box's plus) fades the same way. The box under the
  // pointer is rebuilt too, and a new element can miss :hover until the pointer moves, so .hover stands in
  const boxes = (root) => [...chips(root), ["\u0000all", root.querySelector(".legend-all")]].filter(([, el]) => el);
  const boxOf = (unit) => unit.querySelector(".swatch") ?? unit;
  const marked = new Map(boxes(key).map(([n, el]) => [n, { parts: markLooks(el), hover: boxOf(el).matches(":hover, .hover") }]));
  // The chip under the pointer is rebuilt as well, and it misses :hover the same way, so .hover stands in for it too
  const under = key.querySelector("[data-artist]:hover")?.dataset.artist;
  // Rebuilding drops keyboard focus, so it goes back to the same control in the new chip
  const focused = key.contains(document.activeElement) ? document.activeElement : null;
  const refocus = focused && [focused.closest("[data-artist]")?.dataset.artist, focused.className];

  const items = keyed.map((n) => {
    const off = state.hidden.includes(n);
    const pinned = !off && pins.has(n);
    const item = document.createElement("span");
    item.className = "legend-item mix-legend-item pinnable" + (pinned ? " pinned" : "") + (off ? " hidden-artist" : "");
    item.style.setProperty("--c", `var(--series-${state.colorSlots.get(n) + 1})`);
    item.dataset.artist = n;
    item.title = off ? `Show ${n}` : pinned ? `Unpin ${n}` : `Pin ${n}`;
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "swatch";
    sw.setAttribute("aria-pressed", !off);
    sw.title = off ? `Show ${n}` : `Hide ${n}`;
    sw.setAttribute("aria-label", sw.title);
    sw.addEventListener("click", (e) => {
      e.stopPropagation();
      hover(null);
      pins.hide(n);
    });
    const label = document.createElement("button");
    label.type = "button";
    label.className = "name";
    label.textContent = n; // artist names come from user files
    label.dataset.text = n; // read by the CSS that reserves the bold width
    label.setAttribute("aria-label", item.title);
    item.append(sw, label);
    item.addEventListener("pointerenter", () => hover(n));
    item.addEventListener("pointerleave", () => hover(null));
    item.addEventListener("click", () => (off ? pins.hide(n) : pins.toggle(n)));
    return item;
  });
  // Everyone else comes last, in gray, like its band on top of the stack. It isn't an artist, so it can't be
  // pinned: a click anywhere on it shows or hides it, and it's dimmed while hidden, like a hidden artist
  const otherOn = $("include-other").checked;
  const rest = document.createElement("span");
  rest.className = "legend-item mix-legend-item pinnable other-chip" + (otherOn ? "" : " hidden-artist");
  rest.style.setProperty("--c", "var(--other)");
  rest.dataset.artist = "Everyone else";
  const restSw = document.createElement("button");
  restSw.type = "button";
  restSw.className = "swatch";
  restSw.setAttribute("aria-pressed", otherOn);
  restSw.tabIndex = -1; // the name is the one control, so it's a single tab stop
  const restName = document.createElement("button");
  restName.type = "button";
  restName.className = "name";
  restName.textContent = restName.dataset.text = "Everyone else";
  restName.setAttribute("aria-pressed", otherOn);
  rest.title = otherOn ? "Hide everyone else" : "Show everyone else, in gray";
  restName.setAttribute("aria-label", rest.title);
  rest.append(restSw, restName);
  rest.addEventListener("pointerenter", () => otherOn && hover("Everyone else"));
  rest.addEventListener("pointerleave", () => hover(null));
  rest.addEventListener("click", () => {
    hover(null);
    $("include-other").checked = !otherOn;
    $("include-other").dispatchEvent(new Event("input"));
  });
  items.push(rest);
  // As in the rolling chart, the box leaves shown pinned artists alone (a hidden one it brings back like the
  // rest). Checked when they're all shown, a plus when some can come back; a click shows them all, or hides
  // them all once they're all shown
  const top = keyed.filter((n) => !pins.has(n) || state.hidden.includes(n));
  const on = top.filter((n) => !state.hidden.includes(n)).length;
  const box = document.createElement("button");
  box.type = "button";
  box.className = "legend-item legend-all";
  box.setAttribute("role", "checkbox");
  box.setAttribute("aria-checked", on === top.length ? "true" : on ? "mixed" : "false");
  box.title = `${on === top.length ? "Hide" : "Show"} all top ${noun().many}`;
  box.setAttribute("aria-label", box.title);
  const mark = document.createElement("span");
  mark.className = "all-box";
  const glyph = document.createElement("span");
  glyph.className = "all-glyph";
  glyph.classList.toggle("plus", on !== top.length);
  mark.append(glyph);
  box.append(mark);
  box.addEventListener("click", () => showArtists($("chart-rolling"), top, on !== top.length));
  key.replaceChildren(...(top.length ? [box] : []), ...items);
  const underEl = under != null ? chips(key).get(under) : null;
  if (underEl) {
    underEl.classList.add("hover");
    underEl.addEventListener("pointerleave", () => underEl.classList.remove("hover"), { once: true });
  }
  flip(before, chips(key));
  for (const [n, el] of boxes(key)) {
    if (!marked.get(n)?.hover) continue;
    const b = boxOf(el);
    b.classList.add("hover");
    b.addEventListener("pointerleave", () => b.classList.remove("hover"), { once: true });
  }
  if (refocus) {
    const [n, cls] = refocus;
    const chip = n == null ? null : chips(key).get(n);
    (n == null ? key.querySelector(".legend-all") : chip?.querySelector(`[class="${cls}"]`) ?? chip?.querySelector(".name"))?.focus({ preventScroll: true });
  }
  paintFocus();
  if (!dur(GROW_MS)) return;
  for (const [n, el] of chips(key)) {
    const was = looked.get(n);
    if (!was) continue;
    const now = looks(el);
    if (Object.keys(now).every((k) => now[k] === was[k])) continue;
    el.animate([was, now], { duration: GROW_MS, easing: EASE_OUT.css });
  }
  for (const [n, el] of boxes(key)) {
    const was = marked.get(n)?.parts;
    if (!was) continue;
    markLooks(el).forEach((now, i) => {
      if (Object.keys(now.look).every((k) => now.look[k] === was[i].look[k])) return;
      now.el.animate([was[i]?.look ?? now.look, now.look], { duration: GROW_MS, easing: EASE_OUT.css, pseudoElement: now.pseudo });
    });
  }
}

// How a key box's marks look: an artist box's fill, and the upright that makes the all box's minus a plus
const MARK_PARTS = [[".swatch", undefined], [".all-glyph", "::after"]];
function markLooks(unit) {
  return MARK_PARTS.flatMap(([sel, pseudo]) => {
    const el = unit.querySelector(sel);
    if (!el) return [];
    const cs = getComputedStyle(el, pseudo);
    return [{ el, pseudo, look: { backgroundColor: cs.backgroundColor, opacity: cs.opacity } }];
  });
}

// ---------- Artist search: pin any artist into the rolling chart ----------

// Case- and accent-insensitive, so "beyonce" finds Beyoncé
const fold = (s) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const fmtArtistHours = (h) => (h < 1 ? "<1 h" : `${Math.round(h).toLocaleString()} h`);
let results = [];
let active = -1;

// Up to 8 matches: names starting with the query, then a word starting with it, then anywhere.
// state.artists is sorted by hours and the sort is stable, so ties stay biggest first.
function searchArtists(query) {
  const q = fold(query.trim());
  if (!q) return [];
  const found = [];
  for (const a of state.artists) {
    const at = fold(a.name).indexOf(q);
    // Tracks and albums are found by their artist too, after every match on the name
    if (at < 0 && state.owner && fold(state.owner.get(a.name)).includes(q)) found.push({ ...a, at: -1, rank: 3 });
    if (at < 0) continue;
    const rank = at === 0 ? 0 : /[\s\-&(./,]/.test(a.name[at - 1]) ? 1 : 2;
    found.push({ ...a, at, len: q.length, rank });
  }
  return found.sort((a, b) => a.rank - b.rank).slice(0, 8);
}

function setActive(i) {
  active = i;
  const opts = [...$("artist-results").querySelectorAll('[role="option"]')];
  opts.forEach((li, k) => li.setAttribute("aria-selected", k === i));
  if (opts[i]) {
    $("artist-search").setAttribute("aria-activedescendant", opts[i].id);
    opts[i].scrollIntoView({ block: "nearest" });
  } else $("artist-search").removeAttribute("aria-activedescendant");
  // Preview the artist in the chart if they're already in it
  focusArtist($("chart-rolling"), results[i]?.name ?? null);
}

function showResults() {
  const input = $("artist-search");
  const list = $("artist-results");
  results = searchArtists(input.value);
  if (!input.value.trim()) return closeResults();

  const full = state.pinned.length >= MAX_PINS;
  const note = (text) => {
    const li = document.createElement("li");
    li.className = "note";
    li.textContent = text;
    return li;
  };
  const items = results.map((a, i) => {
    const pinned = state.pinned.includes(a.name);
    const li = document.createElement("li");
    li.id = `artist-opt-${i}`;
    li.setAttribute("role", "option");
    if (full && !pinned) li.setAttribute("aria-disabled", "true");
    const name = document.createElement("span");
    name.className = "name";
    // Bold the match. Folding can change a name's length (rarely), and then the indexes don't line up
    if (a.at >= 0 && fold(a.name).length === a.name.length) {
      const mark = document.createElement("mark");
      mark.textContent = a.name.slice(a.at, a.at + a.len);
      name.append(a.name.slice(0, a.at), mark, a.name.slice(a.at + a.len));
    } else name.textContent = a.name;
    const detail = document.createElement("span");
    detail.className = "detail";
    const status = pinned ? "Pinned" : state.chartNames?.includes(a.name) ? "In chart" : fmtArtistHours(a.hours);
    // A track or album says whose it is, unless its name already does
    const by = state.owner?.get(a.name);
    detail.textContent = by && !a.name.endsWith(` · ${by}`) ? `${by} · ${status}` : status;
    li.append(name, detail);
    // pointerdown would blur the input and close the list before the click lands
    li.addEventListener("pointerdown", (e) => e.preventDefault());
    li.addEventListener("pointerenter", () => setActive(i));
    li.addEventListener("click", () => choose(i));
    return li;
  });
  list.replaceChildren(
    ...(full ? [note(`${MAX_PINS} ${noun().many} pinned. Unpin one to add another.`)] : []),
    ...(items.length ? items : [note(`No ${noun().many} match`)])
  );
  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
  setActive(results.length ? 0 : -1);
}

export function closeResults() {
  if ($("artist-results").hidden) return;
  $("artist-results").hidden = true;
  $("artist-search").setAttribute("aria-expanded", "false");
  $("artist-search").removeAttribute("aria-activedescendant");
  focusArtist($("chart-rolling"), null);
  results = [];
  active = -1;
}

function choose(i) {
  const a = results[i];
  if (!a || (state.pinned.length >= MAX_PINS && !state.pinned.includes(a.name))) return;
  $("artist-search").value = "";
  closeResults();
  pin(a.name);
}

$("artist-search").addEventListener("input", showResults);
$("artist-search").addEventListener("focus", showResults);
$("artist-search").addEventListener("blur", closeResults);
$("artist-search").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!results.length) return;
    setActive((active + (e.key === "ArrowDown" ? 1 : results.length - 1)) % results.length);
  } else if (e.key === "Enter") {
    e.preventDefault();
    choose(active);
  } else if (e.key === "Escape") {
    e.preventDefault();
    if ($("artist-results").hidden) $("artist-search").value = "";
    closeResults();
  }
});

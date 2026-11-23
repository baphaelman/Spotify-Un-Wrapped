// The dashboard as a gallery: every graph is a tile with a live thumbnail of its own (thumbs.js), in sections. A tile
// opens its card in the grid's place at full size, the bar kept above it; ‹ › (or the arrow keys) step through the
// graphs, "All graphs" (or Esc, or Back) returns.
//
// The cards wait in a stage off screen, always --gal-w wide, so putOff (state.js) holds their paints while the grid
// shows: a drag of the period redraws the thumbnails and the rolling chart's data, not thirteen full graphs. Opening
// one moves it into view at the same width (no chart resizes) and its held paint runs. The grid, likewise, moves off
// screen while a card is open rather than hiding, so the thumbnails keep their size.
//
// Opening flies: the tile grows into the card's place while the card, pinned there and scaled down over the tile,
// grows with it and fades in over it; the rest of the grid fades where it is. A card with an arrival (arrivals.js)
// flies solid instead: its plot starts as the thumbnail and morphs into itself, and only what's around it fades.
// Closing is the same in reverse, into the tile. A flight turned back midway (Esc while it opens) reverses from where
// it is.

import { $, bringBack, owes, prefer, holdIdle, onOwedChange, unloadAll, hooks } from "./state.js";
import { ENTER_MS, MORPH_MS, STAGGER_MS, STAGGER_MAX_MS, EASE_OUT, EASE_IN_OUT, EASE_GENTLE, dur, flip } from "./motion.js";
import { addThumb, paintThumbs, paintThumb, comingBack, STRETCH } from "./thumbs.js";
import { ARRIVALS } from "./arrivals.js";

// card id -> its address (#every-play)
const SLUG = {
  "mix-card": "mix", "sunburst-card": "inside", "ranking-card": "all",
  "rolling-card": "top-view", "race-card": "over-time", "rank-card": "rank-race", "monthly-card": "every-month", "discovery-card": "discovery",
  "hours-card": "hours-per-week", "clock-card": "when", "raster-card": "every-play", "calendar-card": "every-day", "skips-card": "skips",
};
const SECTIONS = [
  ["Your top", ["mix-card", "sunburst-card", "ranking-card"]],
  ["Over time", ["rolling-card", "race-card", "rank-card", "monthly-card", "discovery-card"]],
  ["How you listen", ["hours-card", "clock-card", "raster-card", "calendar-card", "skips-card"]],
];
// The ways to lay the tiles out. Graphs keep their sections; a section whose tiles don't fill its rows stretches some.
// fill (the default): the section's short row comes first, made of its graphs whose thumbnails stretch best (STRETCH,
//   thumbs.js), sharing the row evenly (five tiles in three columns: two a column and a half each, then three)
// last: the section's last row shares the width, whichever graphs land there
// even: nothing stretches, the last row left short
// (last and even, passed over, stay as Visual tweaks)
const LAYOUTS = {
  fill: { label: "Fill the rows, best stretchers first", groups: SECTIONS, fill: true, lead: true },
  last: { label: "Fill the last row", groups: SECTIONS, fill: true },
  even: { label: "Even", groups: SECTIONS },
};
const DEFAULT_LAYOUT = "fill";
const LAYOUT_KEY = "gallery-layout";

// Tiles that keep only their card's first sentence, giving the thumbnail the room
const SHORT = new Set(["sunburst-card", "ranking-card"]);
const make = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const dash = $("dashboard");
const bar = dash.querySelector(".period-bar");
const gallery = make("div", "gallery");
gallery.id = "gallery";
bar.after(gallery);

// The open view's header (back, where you are, ‹ ›) and the slot its card moves into
const head = make("div", "gal-head");
head.innerHTML = `<button type="button" class="ghost gal-back">‹ All graphs</button><span class="gal-crumb muted"></span>
  <span class="gal-steps"><button type="button" class="ghost gal-step" data-d="-1" aria-label="Previous graph">‹</button><button type="button" class="ghost gal-step" data-d="1" aria-label="Next graph">›</button></span>`;
const slot = make("div", "gal-open");
const stage = make("div", "gal-stage");
stage.setAttribute("aria-hidden", "true");

// "Missing something?", once, right under the period bar: ask for a graph, or make one
const ask = make("div", "gal-ask");
ask.append(make("h4", "", "Missing something?"), make("p", "", "Ask for a graph you'd like to see, or make your own: the site is open source."));
const acts = make("div", "gal-ask-actions");
const req = make("button", "ghost", "Ask for a graph");
req.type = "button";
req.addEventListener("click", () => $("feedback-open").click());
const own = make("a", "", "Make your own ↗");
own.href = $("github-link")?.href ?? "#";
own.target = "_blank";
own.rel = "noopener";
acts.append(req, own);
ask.append(acts);

// The layouts passed over, flights without their clip (to compare how smoothly they run), and unloading every card
// (each owes its paint again, so the idle paints draw them anew: their dots show it), Visual tweaks
const pick = make("div", "gal-layout tweak-only");
pick.hidden = true;
const layoutPick = make("label", "", "Gallery layout ");
const sel = make("select");
for (const [k, l] of Object.entries(LAYOUTS)) sel.append(Object.assign(make("option", "", l.label), { value: k }));
try {
  sel.value = LAYOUTS[localStorage.getItem(LAYOUT_KEY)] ? localStorage.getItem(LAYOUT_KEY) : DEFAULT_LAYOUT;
} catch {
  sel.value = DEFAULT_LAYOUT;
}
layoutPick.append(sel);
const clipPick = make("label", "", "Clip flights ");
const clipBox = Object.assign(make("input"), { type: "checkbox", checked: true });
clipPick.append(clipBox);
// (the top of the page on the card's own curve, the abrupter one passed over, to compare)
const navPick = make("label", "", "Top of page on the card's curve ");
const navBox = Object.assign(make("input"), { type: "checkbox" });
navPick.append(navBox);
const navEase = () => (!pick.hidden && navBox.checked ? EASE_IN_OUT : EASE_GENTLE).css;
const unload = make("button", "ghost", "Unload cards");
unload.type = "button";
unload.title = "Every card off screen owes its paint again; the idle paints draw them back one by one";
unload.addEventListener("click", unloadAll);
pick.append(layoutPick, clipPick, navPick, unload);
gallery.append(ask, pick, head, slot, stage);
// (off only while Visual tweaks is on: off, the page is as chosen)
const clipped = () => pick.hidden || clipBox.checked;

const tiles = []; // {card, tile, slug}, in no particular order: the page's order is the sections' (order())
const byId = new Map();
for (const id of Object.keys(SLUG)) {
  const card = $(id);
  stage.append(card);
  const tile = make("div", "gal-tile");
  tile.tabIndex = 0;
  tile.setAttribute("role", "button");
  const title = make("h4");
  const blurb = make("p");
  const thumb = make("div", "gal-thumb");
  thumb.id = "thumb-" + id;
  tile.classList.toggle("short", SHORT.has(id));
  tile.classList.toggle("round", id === "sunburst-card"); // (its circle takes the tile's height: thumbs.js rings)
  // (a Visual tweak: a dot in the corner, filled once the card is drawn for what the page shows, so it opens at once)
  const ready = make("span", "gal-ready tweak-only");
  ready.hidden = true;
  ready.classList.toggle("waiting", owes(card));
  tile.append(title, blurb, thumb, ready);
  // (the card under the cursor, or focused, draws first: it's the one about to be opened)
  for (const type of ["pointerenter", "focus"]) tile.addEventListener(type, () => prefer(card));
  addThumb(id, thumb);
  // The tile's name and line follow the card's (they change with the view: "Top Albums over time")
  const h2 = card.querySelector("h2");
  const p = card.querySelector("h2 + p, h2 ~ p");
  const name = () => {
    title.textContent = h2?.textContent ?? "";
    const text = p?.textContent ?? "";
    blurb.textContent = SHORT.has(id) ? (text.match(/^.*?\.(?=\s|$)/)?.[0] ?? text) : text;
    tile.setAttribute("aria-label", `Open ${title.textContent}`);
  };
  name();
  const watch = new MutationObserver(name);
  for (const el of [h2, p]) if (el) watch.observe(el, { subtree: true, childList: true, characterData: true });
  // A card the page hides (Skips and picks without skip data) hides its tile, and the rows re-fit
  const shown = () => {
    if (tile.hidden === card.hidden) return;
    tile.hidden = card.hidden;
    arrange();
  };
  tile.hidden = card.hidden;
  new MutationObserver(shown).observe(card, { attributes: true, attributeFilter: ["hidden"] });
  const entry = { card, tile, slug: SLUG[id], ready };
  tiles.push(entry);
  byId.set(id, entry);
  tile.addEventListener("click", () => open(entry));
  tile.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target === tile) {
      e.preventDefault();
      open(entry);
    }
  });
}
onOwedChange((card, owing) => byId.get(card.id)?.ready.classList.toggle("waiting", owing));

// ---------- Arranging: sections, columns, spans ----------
let cols = 0;
let arranged = ""; // what the tiles were last arranged for
// A section's tiles in rows (see LAYOUTS), each tile's span in half columns (so a row can split into halves)
function pack(list, L) {
  const total = cols * 2;
  const short = L.fill ? list.length % cols : 0;
  const rowsOf = (xs) => Array.from({ length: Math.ceil(xs.length / cols) }, (_, i) => xs.slice(i * cols, (i + 1) * cols));
  let rows;
  if (!short) rows = rowsOf(list);
  else if (L.lead) {
    // the short row leads: the graphs that stretch best, in the section's order (a tie goes to the earlier one)
    const best = new Set([...list].sort((a, b) => (STRETCH[b.card.id] ?? 0) - (STRETCH[a.card.id] ?? 0)).slice(0, short));
    rows = [list.filter((x) => best.has(x)), ...rowsOf(list.filter((x) => !best.has(x)))];
  } else rows = [...rowsOf(list.slice(0, list.length - short)), list.slice(-short)];
  const spans = new Map();
  for (const r of rows) {
    const room = short ? total - 2 * r.length : 0;
    r.forEach((x, i) => spans.set(x, 2 + Math.floor(room / r.length) + (i < room % r.length ? 1 : 0)));
  }
  return { total, spans, order: rows.flat() };
}
const layoutName = () => (pick.hidden ? DEFAULT_LAYOUT : sel.value);
function arrange() {
  if (!cols) return;
  const name = layoutName();
  const L = LAYOUTS[name];
  const key = [name, cols, ...tiles.map((x) => +x.tile.hidden)].join();
  if (key === arranged) return;
  const first = !arranged;
  arranged = key;
  const visible = !first && !gallery.classList.contains("open") && gallery.offsetParent !== null;
  const before = visible ? new Map(tiles.map((x) => [x, x.tile.getBoundingClientRect()])) : null;
  for (const s of gallery.querySelectorAll(".gal-sec")) s.remove();
  for (const [title, ids] of L.groups) {
    const s = make("section", "gal-sec");
    s.dataset.name = title;
    if (title) s.append(make("h3", "", title));
    const grid = make("div", "gal-grid");
    const list = ids.map((id) => byId.get(id));
    const { total, spans, order } = pack(list.filter((x) => !x.tile.hidden), L);
    // (tiles the page hides keep their place in the list, after the shown ones)
    for (const x of [...order, ...list.filter((x) => x.tile.hidden)]) {
      const w = spans.get(x) ?? 2;
      x.tile.style.gridColumn = `span ${w}`;
      // (a graph across the whole row draws a taller thumbnail)
      x.tile.classList.toggle("hero", w === total && cols >= 3);
      // (moved after the first arrangement, a tile doesn't rise in again)
      if (!first) x.tile.style.animation = "none";
      grid.append(x.tile);
    }
    grid.style.gridTemplateColumns = `repeat(${total}, minmax(0, 1fr))`;
    s.append(grid);
    stage.before(s);
  }
  if (before) flip(before, tiles.map((x) => [x, x.tile]));
  paintThumbs(); // (a tile that changed width redraws for it: the mix's labels and pictures, All your …'s rows)
}
sel.addEventListener("change", () => {
  try {
    localStorage.setItem(LAYOUT_KEY, sel.value);
  } catch {}
  arrange();
});
// (the choice counts only while Visual tweaks is on: off, the page is as chosen)
new MutationObserver(arrange).observe(pick, { attributes: true, attributeFilter: ["hidden"] });

// ---------- Fitting: the cards' full width and the tiles' columns ----------
const galW = () => parseFloat(gallery.style.getPropertyValue("--gal-w"));
function fit() {
  const main = gallery.closest("main");
  const cs = getComputedStyle(main);
  const w = main.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  if (w <= 0) return;
  gallery.style.setProperty("--gal-w", `${w}px`);
  const c = w >= 860 ? 3 : w >= 540 ? 2 : 1;
  if (c !== cols) {
    cols = c;
    arrange();
  }
}
fit();
new ResizeObserver(fit).observe(gallery.closest("main"));

// ---------- Opening and closing ----------
let current = null;
// The open graph's neighbours (‹ ›) draw what a change left them sooner than the rest (state.js soon)
hooks.paintRank = (card) => {
  const list = current && order(), i = list ? list.indexOf(current) : -1;
  return i >= 0 && (list[i - 1]?.card === card || list[i + 1]?.card === card) ? 2 : null;
};
let gridScroll = 0;
// Where the bar ends once it's pinned to the top, as it is with a card open
const barBottom = () => parseFloat(getComputedStyle(bar).top) + bar.getBoundingClientRect().height;
const order = () => [...gallery.querySelectorAll(".gal-sec .gal-tile")].map((t) => tiles.find((x) => x.tile === t)).filter((x) => !x.tile.hidden);
const rise = (el, delay = 0) => el.animate(
  [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }],
  { duration: dur(ENTER_MS), delay: dur(delay), easing: EASE_OUT.css, fill: "backwards" }
);
// the open card starts just under the bar, its header above it
const openTop = () => Math.round(gallery.getBoundingClientRect().top + scrollY - barBottom() - 8);
const scrollToOpen = (top = openTop()) => scrollTo({ top, behavior: "instant" });
// The top of the page (its title line and the period bar) moving as it would with the page scrolled from `g` (the
// grid's scroll) to `o` (the open card's), on the flight's clock, while the page stays where it is now (at one of the
// two): the real scroll jumps once the flight lands (opening) or as it starts (closing), when nothing on screen moves
// for it. The tile stays put meanwhile, so the flight's start holds. Its curve is the gentler smoothstep: on the
// cubic, a move this short reads as abrupt. (the bar is stuck to the top past where it would scroll by: its keyframes
// bend there, in eased time)
const topbar = document.querySelector(".topbar");
function scrollAnims(g, o, opts) {
  if (g === o) return [];
  const at = scrollY, ty = (y) => ({ transform: `translateY(${y}px)` });
  const stuck = parseFloat(getComputedStyle(bar).top), barH = bar.getBoundingClientRect().height;
  // (where the bar's top would be in the page, not stuck: just above the gallery)
  const N = gallery.getBoundingClientRect().top + at - parseFloat(getComputedStyle(bar).marginBottom) - barH;
  const barAt = (x) => Math.max(stuck, N - x) - Math.max(stuck, N - at);
  const out = [];
  const u = (N - stuck - g) / (o - g);
  const bend = u > 0 && u < 1 ? [{ ...ty(barAt(N - stuck)), offset: u }] : [];
  opts = { ...opts, easing: navEase() };
  if (barAt(g) || barAt(o)) out.push(bar.animate([ty(barAt(g)), ...bend, ty(barAt(o))], opts));
  const hb = topbar.getBoundingClientRect().bottom + at; // (its bottom in the page)
  if (hb > Math.min(g, o)) out.push(topbar.animate([ty(at - g), ty(at - o)], opts));
  return out;
}

// ---------- The flight between a tile and its card ----------
// The thumbnail is the shared element: it flies from its place in the tile to the card's plot, while the card, scaled
// so its plot starts exactly on the thumbnail and clipped to the tile's frame, grows to its place with it. The two
// cover the same box all the way, so the crossfade between them is between matching shapes.
// card id -> what its thumbnail stands for in the card (an ECharts chart is narrowed to its grid)
const PLOT = {
  "mix-card": "#mix-bar", "sunburst-card": "#sunburst", "ranking-card": "#ranking-list", "rolling-card": "#chart-rolling",
  "race-card": "#race-rows", "rank-card": "#chart-rank", "monthly-card": "#chart-monthly", "discovery-card": "#chart-discovery",
  "hours-card": "#chart-rolling-hours", "clock-card": "#chart-clock", "raster-card": "#chart-raster",
  "calendar-card": "#chart-calendar", "skips-card": "#skips-list",
};
// Plots that hang from the top (lists of rows): a solid flight sets their top on the thumbnail's, not their baseline
const HANG = new Set(["race-card", "ranking-card", "skips-card"]);
// The plot's box on screen, within the card's (C)
function plotBox(card, C) {
  const el = card.querySelector(PLOT[card.id]);
  if (!el) return C;
  const r = el.getBoundingClientRect();
  let { left, top, width, height } = r;
  const grid = echarts.getInstanceByDom(el)?.getModel()?.getComponent("grid")?.coordinateSystem?.getRect?.();
  if (grid?.width > 0) ({ left, top, width, height } = { left: left + grid.x, top: top + grid.y, width: grid.width, height: grid.height });
  const bottom = Math.min(top + height, C.bottom - 16);
  return width > 0 && bottom > top ? { left, top, width, height: bottom - top } : C;
}
// The keyframes of a flight open (played in reverse to close): T the tile's box, Th its thumbnail's, C the card's in
// its place, P its plot's. solid: the card's plot is the thumbnail all the way (its arrival morphs it), so the card
// draws over the tile and never fades as a whole: its frame and everything but the plot fade in around it, and the
// thumbnail under it fades out early, over bars that match it. gTop, oTop: the page's scroll on the grid and with the
// card open (scrollAnims).
function flightAnims(entry, T, Th, C, P, direction, solid, gTop, oTop) {
  const { card, tile } = entry;
  const thumb = tile.querySelector(".gal-thumb");
  const s = Th.width / P.width;
  // (a solid card's plot sits on the thumbnail's baseline (its grid's bottom, for an ECharts one), or its top when it
  // hangs from it (HANG): its arrival stretches or places its first shapes to the thumbnail's, when the two boxes'
  // shapes differ)
  const dx = Th.left - C.left - s * (P.left - C.left);
  const dy = solid && !HANG.has(card.id) ? baseline(thumb, Th) - C.top - s * (P.top + P.height - C.top) : Th.top - C.top - s * (P.top - C.top);
  // the tile's frame, in the scaled card's own pixels
  const fl = (T.left - C.left - dx) / s, ft = (T.top - C.top - dy) / s;
  const clip = [ft, C.width - fl - T.width / s, C.height - ft - T.height / s, fl].map((v) => `${Math.max(0, v)}px`).join(" ");
  for (const el of [card, thumb]) el.style.transformOrigin = "0 0";
  tile.style.zIndex = solid ? "4" : "6"; // (above the card, so the thumbnail crosses over it, unless the card is solid)
  const o = { duration: dur(MORPH_MS), easing: EASE_IN_OUT.css, fill: "forwards", direction };
  const from = `translate(${dx}px, ${dy}px) scale(${s})`;
  const cs = getComputedStyle(card);
  const fadeIn = [{ opacity: 0 }, { opacity: 1, offset: 0.4 }, { opacity: 1 }];
  // (the card's move on its own, transform and opacity, so the compositor runs it even while the page is busy; its
  // clip and colors, which only the page can draw, beside it: a busy frame holds them, not the card)
  const clipFrom = clipped() ? { clipPath: `inset(${clip} round ${8 / s}px)` } : {};
  const clipTo = clipped() ? { clipPath: "inset(0px 0px 0px 0px round 8px)" } : {};
  return [
    card.animate(solid ? [{ transform: from }, { transform: "none" }] : [{ transform: from, opacity: 0 }, { opacity: 1, offset: 0.4 }, { transform: "none", opacity: 1 }], o),
    card.animate(solid
      ? [{ ...clipFrom, backgroundColor: "transparent", borderColor: "transparent" }, { backgroundColor: cs.backgroundColor, borderColor: cs.borderColor, offset: 0.4 }, { ...clipTo }]
      : [clipFrom, clipTo], o),
    thumb.animate([
      { transform: "none", opacity: 1 },
      ...(solid ? [{ opacity: 0, offset: 0.25 }] : [{ opacity: 1, offset: 0.4 }, { opacity: 0, offset: 0.7 }]),
      // (solid: it rides on the card, scaled evenly with it, so its shapes stay on the card's while it fades; else it
      // stretches to the plot's box)
      { transform: solid ? riding(Th, C, dx, dy, s) : `translate(${P.left - Th.left}px, ${P.top - Th.top}px) scale(${P.width / Th.width}, ${P.height / Th.height})`, opacity: 0 },
    ], o),
    // (each to its own opacity: what's hidden now, Discovery's key while the names fit, stays hidden)
    ...(solid ? chromeOf(card).flatMap((el) => {
      const op = +getComputedStyle(el).opacity;
      return op > 0 ? [el.animate(op === 1 ? fadeIn : [{ opacity: 0 }, { opacity: op, offset: 0.4 }, { opacity: op }], o)] : [];
    }) : []),
    // the tile's frame and words give way to the card's
    tile.animate([{}, { backgroundColor: "transparent", borderColor: "transparent", offset: 0.4 }, { backgroundColor: "transparent", borderColor: "transparent" }], o),
    ...[...tile.children].filter((e) => e !== thumb).map((el) => el.animate([{ opacity: 1 }, { opacity: 0, offset: 0.3 }, { opacity: 0 }], o)),
    head.animate([{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }], o),
    // everything else in the gallery fades where it is
    ...others(tile).map((el) => el.animate([{ opacity: 1 }, { opacity: 0, offset: 0.6 }, { opacity: 0 }], o)),
    // the top of the page scrolls with the flight
    ...scrollAnims(gTop, oTop, o),
  ];
}
// Where a thumbnail's shapes stand on screen: an ECharts one's grid bottom, else the element's bottom
function baseline(thumb, Th) {
  const c = echarts.getInstanceByDom(thumb);
  const g = c?.getOption()?.series?.some?.(Boolean) && c.getModel().getComponent("grid")?.coordinateSystem?.getRect?.();
  return g?.height > 0 ? Th.top + (g.y + g.height) * (Th.height / thumb.offsetHeight) : Th.bottom;
}
// The thumbnail's transform at the end of a solid flight: where the card carries it. The card goes from
// translate(dx, dy) scale(s) to none, both linear in the same eased time, so a thumbnail going from none to
// translate(e) scale(1 / s) stays attached to it all the way: e = q(1 - s) - d, q its place in the card's own pixels.
function riding(Th, C, dx, dy, s) {
  const qx = (Th.left - C.left - dx) / s, qy = (Th.top - C.top - dy) / s;
  return `translate(${qx * (1 - s) - dx}px, ${qy * (1 - s) - dy}px) scale(${1 / s})`;
}
// ---------- A solid flight's chrome: everything of the card but its plot's shapes ----------
const plotChart = (card) => echarts.getInstanceByDom(card.querySelector(PLOT[card.id]));
// The card's elements beside its plot (walking up from it), and an ECharts plot's own overlays beside its canvas (a
// plot of elements or its own canvas is all plot: its arrival fades what it doesn't morph)
function chromeOf(card) {
  const plot = card.querySelector(PLOT[card.id]);
  const root = plotChart(card)?.getZr().painter.getViewportRoot?.();
  const out = root ? [...plot.children].filter((e) => e !== root) : [];
  for (let el = plot; el !== card; el = el.parentElement) out.push(...[...el.parentElement.children].filter((e) => e !== el));
  return out;
}
// The chart's drawn shapes that aren't a series' (axes, guides, labels), faded in the canvas with the chrome: opening,
// from nothing to whole by 40% of the flight as the chrome does (keyframes in eased time, as the animations' are);
// closing, the same played back (the in-out cubic is symmetric). from: turned back midway, from that share of each
// shape's opacity to the end over ms.
function fadeCanvas(card, opening, ms, from) {
  const c = plotChart(card);
  if (!c) return;
  const own = new Set();
  for (const v of c._chartsViews ?? []) v.group.traverse((e) => void own.add(e));
  for (const e of c.getZr().storage.getDisplayList(true)) {
    if (own.has(e)) continue;
    e.stopAnimation();
    // (each to its own opacity, read as a flight starts: a guide drawn faint stays faint, rather than ending the flight
    // strong and dropping back at the chart's next redraw)
    const op = from == null && ms ? (e.__restOpacity = e.style.opacity ?? 1) : e.__restOpacity ?? e.style.opacity ?? 1;
    if (!ms) {
      e.setStyle({ opacity: op });
      continue;
    }
    const a = e.animate("style", false);
    if (from != null) a.when(0, { opacity: from * op }).when(ms, { opacity: opening ? op : 0 }).start(EASE_IN_OUT.echarts);
    else if (opening) a.when(0, { opacity: 0 }).when(0.4 * ms, { opacity: op }).when(ms, { opacity: op }).start(EASE_IN_OUT.echarts);
    else a.when(0, { opacity: op }).when(0.6 * ms, { opacity: op }).when(ms, { opacity: 0 }).start(EASE_IN_OUT.echarts);
  }
}
// The card's arrival (arrivals.js), with its thumbnail as drawn: true when it ran
function arrive(entry, to, ms) {
  const fn = ARRIVALS[entry.card.id];
  return !!fn?.(entry.card, entry.tile.querySelector(".gal-thumb"), to, ms);
}
// Held on screen where it is (or at `r`) through a flight, above the grid and under the bar
const PINNED = ["position", "left", "top", "width", "margin", "zIndex", "display"];
function pin(el, r, width) {
  Object.assign(el.style, { position: "fixed", left: `${r.left}px`, top: `${r.top}px`, margin: "0", zIndex: "5" });
  if (width) el.style.width = `${width}px`;
}
const unpin = (...els) => els.forEach((el) => PINNED.forEach((k) => (el.style[k] = "")));

// The flight in progress: { anims, done (as it lands), undo (turned back), opening, entry, solid }
let flight = null;
function launch(entry, opening, anims, done, undo, solid) {
  const f = { anims, done, undo, opening, entry, solid };
  // (a cursor left where the tile was clicked doesn't hover the card flying under it: hovers wait for it to land)
  entry.card.style.pointerEvents = "none";
  holdIdle(true); // (no other card's paint mid-flight)
  flight = f;
  // (it lands once every part has, either way)
  const landed = () => {
    if (flight !== f || anims.some((a) => a.playState !== "finished")) return;
    flight = null;
    f.done();
  };
  for (const a of anims) a.onfinish = landed;
}
// Land at once (another graph asked for midway)
function land() {
  const f = flight;
  if (!f) return;
  flight = null;
  f.done();
}
// Fly back the way it came, from where it is
function turnBack() {
  const f = flight;
  // (the time flown so far is the time back, whichever way it was going)
  const ms = f.anims[0].currentTime;
  for (const a of f.anims) a.reverse();
  [f.done, f.undo] = [f.undo, f.done];
  f.opening = !f.opening;
  if (!f.solid) return;
  // the plot morphs back from where it is, its axes from the opacity the chrome has reached
  const at = +getComputedStyle(chromeOf(f.entry.card)[0] ?? f.entry.card).opacity;
  arrive(f.entry, f.opening ? "card" : "thumb", ms);
  fadeCanvas(f.entry.card, f.opening, ms, at);
}
// Everything in the gallery but the tile that flies (the sections' names, the other tiles, the bar above them)
const others = (tile) => [...gallery.querySelectorAll(".gal-sec h3, .gal-tile"), ask, pick].filter((e) => e !== tile && !e.hidden);
// Back to rest after a flight, either way
function settle(entry, anims) {
  for (const a of anims) a.cancel();
  fadeCanvas(entry.card, true, 0);
  unpin(entry.card, head);
  entry.card.style.pointerEvents = "";
  holdIdle(false);
  entry.card.style.transformOrigin = entry.tile.querySelector(".gal-thumb").style.transformOrigin = entry.tile.style.zIndex = "";
}
const toGrid = (entry, anims, solid) => () => {
  stage.append(entry.card);
  if (solid) arrive(entry, "card", 0); // (it waits off screen as itself)
  settle(entry, anims);
  entry.tile.focus({ preventScroll: true });
};
// (top: where the page scrolls to, as the top of the page was flown to it: the card's place, or where it was left
// when a close is turned back)
const toCard = (entry, anims, top) => () => {
  gallery.classList.add("open");
  settle(entry, anims);
  scrollToOpen(top);
};

function flyOpen(entry) {
  const { card, tile } = entry;
  const T = tile.getBoundingClientRect(), Th = tile.querySelector(".gal-thumb").getBoundingClientRect();
  const left = gallery.getBoundingClientRect().left;
  const y = barBottom() + 8;
  head.style.display = "flex";
  pin(head, { left, top: y }, galW());
  // (pinned before it joins the slot, so the page never lays out with the card in the flow above the grid)
  pin(card, { left, top: y + head.offsetHeight + 12 });
  slot.append(card);
  bringBack(card);
  const C = card.getBoundingClientRect();
  const solid = arrive(entry, "thumb", 0) && arrive(entry, "card", dur(MORPH_MS));
  const top = openTop();
  const anims = flightAnims(entry, T, Th, C, plotBox(card, C), "normal", solid, scrollY, top);
  if (solid) fadeCanvas(card, true, dur(MORPH_MS));
  launch(entry, true, anims, toCard(entry, anims, top), toGrid(entry, anims, solid), solid);
}

function flyClose(entry) {
  const { card, tile } = entry;
  const C = card.getBoundingClientRect(), H = head.getBoundingClientRect();
  const P = plotBox(card, C);
  pin(head, H, galW());
  head.style.display = "flex";
  pin(card, C);
  const was = scrollY;
  gallery.classList.remove("open");
  scrollTo({ top: gridScroll, behavior: "instant" });
  // the grid as it was left, where you were when you opened a graph; the tile it closes into is there unless ‹ › went
  // to one that isn't on screen: then only as far as brings it in
  let T = tile.getBoundingClientRect();
  const lo = barBottom() + 8;
  if (T.bottom <= lo || T.top >= innerHeight) {
    scrollBy({ top: T.top < lo ? T.top - lo : T.bottom - innerHeight, behavior: "instant" });
    T = tile.getBoundingClientRect();
  }
  paintThumb(card.id); // (now, so the arrival morphs to the thumbnail as it will show)
  paintThumbs();
  const solid = arrive(entry, "thumb", dur(MORPH_MS));
  const anims = flightAnims(entry, T, tile.querySelector(".gal-thumb").getBoundingClientRect(), C, P, "reverse", solid, scrollY, was);
  if (solid) fadeCanvas(card, false, dur(MORPH_MS));
  launch(entry, false, anims, toGrid(entry, anims, solid), toCard(entry, anims, was), solid);
}

function setCrumb(entry) {
  const list = order();
  const sec = entry.tile.closest(".gal-sec")?.dataset.name;
  head.querySelector(".gal-crumb").textContent = [sec, `${list.indexOf(entry) + 1} of ${list.length}`].filter(Boolean).join(" · ");
}

function open(entry, { step = false, push = true } = {}) {
  if (flight) {
    // the tile it's closing into, asked for again: fly back out
    if (!flight.opening && flight.entry === entry && !step) {
      turnBack();
      current = entry;
      if (push) history.pushState({ gallery: entry.slug }, "", "#" + entry.slug);
      return;
    }
    land();
  }
  if (current === entry) return;
  const fromGrid = !current;
  if (fromGrid) {
    gridScroll = scrollY;
    // (the tiles on screen now are on screen as it closes: their thumbnails redraw first while it's open)
    const lo = barBottom(), on = (r) => r.bottom > lo && r.top < innerHeight;
    comingBack(order().filter((x) => on(x.tile.getBoundingClientRect())).map((x) => x.tile.querySelector(".gal-thumb")));
  }
  if (current) stage.append(current.card);
  current = entry;
  setCrumb(entry);
  if (push) history[step || location.hash.slice(1) === entry.slug ? "replaceState" : "pushState"]({ gallery: entry.slug }, "", "#" + entry.slug);
  if (gallery.offsetParent !== null && fromGrid && dur(MORPH_MS)) return flyOpen(entry);
  slot.append(entry.card);
  gallery.classList.add("open");
  if (gallery.offsetParent === null) return;
  scrollToOpen();
  rise(entry.card);
  if (!step) rise(head);
}

function close({ push = true } = {}) {
  if (flight) {
    if (!flight.opening) return;
    // closed while it opens: fly back into the tile from where it is
    turnBack();
    current = null;
    if (push) history.pushState(null, "", location.pathname + location.search);
    return;
  }
  if (!current) return;
  const was = current;
  current = null;
  if (push) history.pushState(null, "", location.pathname + location.search);
  if (gallery.offsetParent !== null && dur(MORPH_MS)) return flyClose(was);
  stage.append(was.card);
  gallery.classList.remove("open");
  if (gallery.offsetParent === null) return;
  scrollTo({ top: gridScroll, behavior: "instant" });
  // (reduced motion: the grid comes back, the tile you left first)
  [was, ...order().filter((x) => x !== was)].forEach((x, i) => rise(x.tile, Math.min(i * STAGGER_MS, STAGGER_MAX_MS)));
  was.tile.focus({ preventScroll: true });
  paintThumbs();
}

const step = (d) => {
  land();
  const list = order();
  open(list[(list.indexOf(current) + d + list.length) % list.length], { step: true });
};

head.querySelector(".gal-back").addEventListener("click", () => close());
for (const b of head.querySelectorAll(".gal-step")) b.addEventListener("click", () => step(+b.dataset.d));
addEventListener("keydown", (e) => {
  if (!current || e.defaultPrevented || e.target.closest?.("input, select, textarea, [role=slider], dialog") || dash.hidden) return;
  if (e.key === "Escape") close();
  else if (e.key === "ArrowLeft") step(-1);
  else if (e.key === "ArrowRight") step(1);
});

// The address: #every-play opens that graph; Back closes it
const fromHash = () => tiles.find((x) => x.slug === location.hash.slice(1) && !x.tile.hidden);
addEventListener("popstate", () => {
  const x = fromHash();
  if (x) open(x, { step: !!current, push: false });
  else close({ push: false });
});
const atStart = fromHash();
if (atStart) open(atStart, { push: false });

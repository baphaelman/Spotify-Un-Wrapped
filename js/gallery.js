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
// grows with it and fades in over it; the rest of the grid fades where it is. Closing is the same in reverse, into
// the tile. A flight turned back midway (Esc while it opens) reverses from where it is.

import { $, bringBack } from "./state.js";
import { ENTER_MS, MORPH_MS, STAGGER_MS, STAGGER_MAX_MS, EASE_OUT, EASE_IN_OUT, dur, flip } from "./motion.js";
import { addThumb, paintThumbs } from "./thumbs.js";

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
// wide (the default): the stretching goes to the section's wide graphs, which lead it: its short row comes first, the
//   wide graphs in it, sharing the room (five tiles in three columns: Top … View two columns beside one more, then three)
// fill: the section's last row shares the width (three, then two a column and a half wide)
// even: nothing stretches, the last row left short
// (fill and even stay as Visual tweaks)
const WIDE = ["rolling-card", "calendar-card"];
const LAYOUTS = {
  wide: { label: "Wide graphs lead, rows filled", groups: SECTIONS, wide: WIDE, fill: true },
  fill: { label: "Fill the rows", groups: SECTIONS, fill: true },
  even: { label: "Even", groups: SECTIONS },
};
const DEFAULT_LAYOUT = "wide";
const LAYOUT_KEY = "gallery-layout";

// Tiles that keep only their card's first sentence, giving the thumbnail the room
const SHORT = new Set(["sunburst-card"]);
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

// The layout choice, a tweak
const pick = make("label", "gal-layout tweak-only", "Gallery layout ");
pick.hidden = true;
const sel = make("select");
for (const [k, l] of Object.entries(LAYOUTS)) sel.append(Object.assign(make("option", "", l.label), { value: k }));
try {
  sel.value = LAYOUTS[localStorage.getItem(LAYOUT_KEY)] ? localStorage.getItem(LAYOUT_KEY) : DEFAULT_LAYOUT;
} catch {
  sel.value = DEFAULT_LAYOUT;
}
pick.append(sel);
gallery.append(ask, pick, head, slot, stage);

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
  tile.append(title, blurb, thumb);
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
  const entry = { card, tile, slug: SLUG[id] };
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

// ---------- Arranging: sections, columns, spans ----------
let cols = 0;
let arranged = ""; // what the tiles were last arranged for
// A section's tiles in rows (see LAYOUTS), each tile's span in half columns (so a row can split into halves)
function pack(list, L) {
  const total = cols * 2;
  const short = list.length % cols;
  const rowsOf = (xs) => Array.from({ length: Math.ceil(xs.length / cols) }, (_, i) => xs.slice(i * cols, (i + 1) * cols));
  const wides = list.filter((x) => L.wide?.includes(x.card.id)).slice(0, short);
  let rows;
  if (!L.fill || !short) rows = rowsOf(list);
  else if (wides.length) {
    // the short row leads: its wide graphs first, then the section's next graphs
    const lead = [...wides, ...list.filter((x) => !wides.includes(x)).slice(0, short - wides.length)];
    rows = [lead, ...rowsOf(list.filter((x) => !lead.includes(x)))];
  } else rows = [...rowsOf(list.slice(0, list.length - short)), list.slice(-short)];
  const spans = new Map();
  for (const r of rows) {
    const room = L.fill ? total - 2 * r.length : 0;
    // the room goes to the row's wide graphs, or else to all of it, evenly
    const to = r.filter((x) => wides.includes(x)).length ? r.filter((x) => wides.includes(x)) : r;
    r.forEach((x) => spans.set(x, 2));
    to.forEach((x, i) => spans.set(x, 2 + Math.floor(room / to.length) + (i < room % to.length ? 1 : 0)));
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
      // (a wide graph across the whole row draws a taller thumbnail)
      x.tile.classList.toggle("hero", w === total && cols >= 3 && !!L.wide?.includes(x.card.id));
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
let gridScroll = 0;
// Where the bar ends once it's pinned to the top, as it is with a card open
const barBottom = () => parseFloat(getComputedStyle(bar).top) + bar.getBoundingClientRect().height;
const order = () => [...gallery.querySelectorAll(".gal-sec .gal-tile")].map((t) => tiles.find((x) => x.tile === t)).filter((x) => !x.tile.hidden);
const rise = (el, delay = 0) => el.animate(
  [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }],
  { duration: dur(ENTER_MS), delay: dur(delay), easing: EASE_OUT.css, fill: "backwards" }
);
// the open card starts just under the bar, its header above it
const scrollToOpen = () => scrollTo({ top: gallery.getBoundingClientRect().top + scrollY - barBottom() - 8, behavior: "instant" });

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
// its place, P its plot's
function flightAnims(entry, T, Th, C, P, direction) {
  const { card, tile } = entry;
  const thumb = tile.querySelector(".gal-thumb");
  const s = Th.width / P.width;
  const dx = Th.left - C.left - s * (P.left - C.left), dy = Th.top - C.top - s * (P.top - C.top);
  // the tile's frame, in the scaled card's own pixels
  const fl = (T.left - C.left - dx) / s, ft = (T.top - C.top - dy) / s;
  const clip = [ft, C.width - fl - T.width / s, C.height - ft - T.height / s, fl].map((v) => `${Math.max(0, v)}px`).join(" ");
  for (const el of [card, thumb]) el.style.transformOrigin = "0 0";
  tile.style.zIndex = "6"; // (above the card, so the thumbnail crosses over it)
  const o = { duration: dur(MORPH_MS), easing: EASE_IN_OUT.css, fill: "forwards", direction };
  return [
    card.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(${s})`, clipPath: `inset(${clip} round ${8 / s}px)`, opacity: 0 },
      { opacity: 1, offset: 0.4 },
      { transform: "none", clipPath: "inset(0px 0px 0px 0px round 8px)", opacity: 1 },
    ], o),
    thumb.animate([
      { transform: "none", opacity: 1 },
      { opacity: 1, offset: 0.4 },
      { opacity: 0, offset: 0.7 },
      { transform: `translate(${P.left - Th.left}px, ${P.top - Th.top}px) scale(${P.width / Th.width}, ${P.height / Th.height})`, opacity: 0 },
    ], o),
    // the tile's frame and words give way to the card's
    tile.animate([{}, { backgroundColor: "transparent", borderColor: "transparent", offset: 0.4 }, { backgroundColor: "transparent", borderColor: "transparent" }], o),
    ...[...tile.children].filter((e) => e !== thumb).map((el) => el.animate([{ opacity: 1 }, { opacity: 0, offset: 0.3 }, { opacity: 0 }], o)),
    head.animate([{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }], o),
    // everything else in the gallery fades where it is
    ...others(tile).map((el) => el.animate([{ opacity: 1 }, { opacity: 0, offset: 0.6 }, { opacity: 0 }], o)),
  ];
}
// Held on screen where it is (or at `r`) through a flight, above the grid and under the bar
const PINNED = ["position", "left", "top", "width", "margin", "zIndex", "display"];
function pin(el, r, width) {
  Object.assign(el.style, { position: "fixed", left: `${r.left}px`, top: `${r.top}px`, margin: "0", zIndex: "5" });
  if (width) el.style.width = `${width}px`;
}
const unpin = (...els) => els.forEach((el) => PINNED.forEach((k) => (el.style[k] = "")));

// The flight in progress: { anims, done (as it lands), undo (turned back), opening, entry }
let flight = null;
function launch(entry, opening, anims, done, undo) {
  const f = { anims, done, undo, opening, entry };
  flight = f;
  anims[0].onfinish = () => {
    if (flight !== f) return;
    flight = null;
    f.done();
  };
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
  for (const a of f.anims) a.reverse();
  [f.done, f.undo] = [f.undo, f.done];
  f.opening = !f.opening;
}
// Everything in the gallery but the tile that flies (the sections' names, the other tiles, the bar above them)
const others = (tile) => [...gallery.querySelectorAll(".gal-sec h3, .gal-tile"), ask, pick].filter((e) => e !== tile && !e.hidden);
// Back to rest after a flight, either way
function settle(entry, anims) {
  for (const a of anims) a.cancel();
  unpin(entry.card, head);
  entry.card.style.transformOrigin = entry.tile.querySelector(".gal-thumb").style.transformOrigin = entry.tile.style.zIndex = "";
}
const toGrid = (entry, anims) => () => {
  stage.append(entry.card);
  settle(entry, anims);
  entry.tile.focus({ preventScroll: true });
};
const toCard = (entry, anims) => () => {
  gallery.classList.add("open");
  settle(entry, anims);
  scrollToOpen();
};

function flyOpen(entry) {
  const { card, tile } = entry;
  const T = tile.getBoundingClientRect(), Th = tile.querySelector(".gal-thumb").getBoundingClientRect();
  const left = gallery.getBoundingClientRect().left;
  const top = barBottom() + 8;
  head.style.display = "flex";
  pin(head, { left, top }, galW());
  // (pinned before it joins the slot, so the page never lays out with the card in the flow above the grid)
  pin(card, { left, top: top + head.offsetHeight + 12 });
  slot.append(card);
  bringBack(card);
  const C = card.getBoundingClientRect();
  const anims = flightAnims(entry, T, Th, C, plotBox(card, C), "normal");
  launch(entry, true, anims, toCard(entry, anims), toGrid(entry, anims));
}

function flyClose(entry) {
  const { card, tile } = entry;
  const C = card.getBoundingClientRect(), H = head.getBoundingClientRect();
  const P = plotBox(card, C);
  pin(head, H, galW());
  head.style.display = "flex";
  pin(card, C);
  gallery.classList.remove("open");
  scrollTo({ top: gridScroll, behavior: "instant" });
  // the tile it closes into, on screen (it may not be where the grid was left, after ‹ ›)
  let T = tile.getBoundingClientRect();
  const lo = barBottom() + 8;
  if (T.top < lo || T.bottom > innerHeight) {
    scrollBy({ top: T.top - lo - Math.max(0, (innerHeight - lo - T.height) / 2), behavior: "instant" });
    T = tile.getBoundingClientRect();
  }
  paintThumbs();
  const anims = flightAnims(entry, T, tile.querySelector(".gal-thumb").getBoundingClientRect(), C, P, "reverse");
  launch(entry, false, anims, toGrid(entry, anims), toCard(entry, anims));
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
  if (fromGrid) gridScroll = scrollY;
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

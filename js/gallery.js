// The dashboard as a gallery: every graph card sits in a tile, in sections, drawn at its full width and shown
// scaled down. The thumbnail is the real graph, so it follows the period bar like always (a drag redraws it at
// liveRender's pace, see period.js). A tile opens its card in the grid's place at full size, the bar kept above it;
// ‹ › (or the arrow keys) step through the graphs, "All graphs" (or Esc, or Back) returns.
//
// A card never changes width between tile and open view (--gal-w), so no chart resizes. Tiles out of the open view
// are moved off screen, not hidden, so putOff (state.js) holds their paints until they're back, as it does for
// cards scrolled away.

import { $ } from "./state.js";
import { MORPH_MS, ENTER_MS, STAGGER_MS, STAGGER_MAX_MS, EASE_IN_OUT, EASE_OUT, dur } from "./motion.js";

// [section, [card id, slug for the address]]
const SECTIONS = [
  ["Your top", [["mix-card", "mix"], ["sunburst-card", "inside"], ["ranking-card", "all"]]],
  ["Over time", [["rolling-card", "top-view"], ["race-card", "over-time"], ["rank-card", "rank-race"], ["monthly-card", "every-month"], ["discovery-card", "discovery"]]],
  ["How you listen", [["hours-card", "hours-per-week"], ["clock-card", "when"], ["raster-card", "every-play"], ["calendar-card", "every-day"], ["skips-card", "skips"]]],
];
const TILE_H = 190; // the thumbnail's height, px
const GAP = 12, PAD = 12; // between tiles, inside a tile (as in the CSS)

const dash = $("dashboard");
const gallery = document.createElement("div");
gallery.id = "gallery";
gallery.className = "gallery";
dash.querySelector(".period-bar").after(gallery);

// The open view's header: back, where you are, ‹ ›
const head = document.createElement("div");
head.className = "gal-head";
head.innerHTML = `<button type="button" class="ghost gal-back">‹ All graphs</button><span class="gal-crumb muted"></span>
  <span class="gal-steps"><button type="button" class="ghost gal-step" data-d="-1" aria-label="Previous graph">‹</button><button type="button" class="ghost gal-step" data-d="1" aria-label="Next graph">›</button></span>`;
gallery.append(head);

const tiles = []; // {card, tile, slug, sec}
const make = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

for (const [sec, cards] of SECTIONS) {
  const s = make("section", "gal-sec");
  s.append(make("h3", "", sec));
  const grid = make("div", "gal-grid");
  for (const [id, slug] of cards) {
    const card = $(id);
    const tile = make("div", "gal-tile");
    tile.tabIndex = 0;
    tile.setAttribute("role", "button");
    const title = make("h4");
    const blurb = make("p");
    const frame = make("div", "gal-frame");
    const scale = make("div", "gal-scale");
    scale.append(card);
    frame.append(scale);
    tile.append(title, blurb, frame);
    grid.append(tile);
    // The tile's name and line follow the card's (they change with the view: "Top Albums over time")
    const h2 = card.querySelector("h2");
    const p = card.querySelector("h2 + p, h2 ~ p");
    const name = () => {
      title.textContent = h2?.textContent ?? "";
      blurb.textContent = p?.textContent ?? "";
      tile.setAttribute("aria-label", `Open ${title.textContent}`);
    };
    name();
    const watch = new MutationObserver(name);
    for (const el of [h2, p]) if (el) watch.observe(el, { subtree: true, childList: true, characterData: true });
    // A card the page hides (Skips and picks without skip data) hides its tile
    const shown = () => (tile.hidden = card.hidden);
    shown();
    new MutationObserver(shown).observe(card, { attributes: true, attributeFilter: ["hidden"] });
    const entry = { card, tile, slug, sec };
    tiles.push(entry);
    tile.addEventListener("click", () => gallery.classList.contains("open") || open(entry));
    tile.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target === tile && !gallery.classList.contains("open")) {
        e.preventDefault();
        open(entry);
      }
    });
  }
  // "Missing something?": ask for a graph, or make one
  const ask = make("div", "gal-ask");
  ask.append(make("h4", "", "Missing something?"));
  ask.append(make("p", "", "Ask for a graph you'd like to see, or make your own: the site is open source."));
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
  grid.append(ask);
  s.append(grid);
  gallery.append(s);
}

// ---------- Fitting: the cards' full width, the tiles' columns and scale ----------
function fit() {
  const main = gallery.closest("main");
  const cs = getComputedStyle(main);
  const w = main.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  if (w <= 0) return;
  const cols = w >= 860 ? 3 : w >= 540 ? 2 : 1;
  const frameW = (w - GAP * (cols - 1)) / cols - 2 * PAD - 2;
  gallery.style.setProperty("--gal-w", `${w}px`);
  gallery.style.setProperty("--gal-cols", cols);
  gallery.style.setProperty("--gal-s", (frameW / w).toFixed(4));
  gallery.style.setProperty("--gal-h", `${TILE_H}px`);
}
fit();
new ResizeObserver(fit).observe(gallery.closest("main"));

// ---------- Opening and closing ----------
let current = null;
let gridScroll = 0;
const barBottom = () => dash.querySelector(".period-bar").getBoundingClientRect().height;
const order = () => tiles.filter((x) => !x.tile.hidden);

function open(entry, { step = false, push = true } = {}) {
  const { card, tile } = entry;
  const laidOut = gallery.offsetParent !== null;
  const from = laidOut && !step ? card.getBoundingClientRect() : null;
  if (!current) gridScroll = scrollY;
  current?.tile.classList.remove("is-open");
  current = entry;
  gallery.classList.add("open");
  tile.classList.add("is-open");
  const list = order();
  head.querySelector(".gal-crumb").textContent = `${entry.sec} · ${list.indexOf(entry) + 1} of ${list.length}`;
  if (push) history[step || location.hash.slice(1) === entry.slug ? "replaceState" : "pushState"]({ gallery: entry.slug }, "", "#" + entry.slug);
  if (!laidOut) return;
  // the open card starts just under the bar
  scrollTo({ top: gallery.getBoundingClientRect().top + scrollY - barBottom() - 8, behavior: "instant" });
  const to = card.getBoundingClientRect();
  if (from && to.width) {
    // it grows out of its tile
    const k = from.width / to.width;
    card.animate(
      [{ transformOrigin: "0 0", transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${k})` }, { transformOrigin: "0 0", transform: "none" }],
      { duration: dur(MORPH_MS), easing: EASE_IN_OUT.css }
    );
  } else {
    card.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: dur(ENTER_MS), easing: EASE_OUT.css });
  }
  head.animate([{ opacity: 0 }, { opacity: 1 }], { duration: dur(ENTER_MS), easing: EASE_OUT.css });
}

function close({ push = true } = {}) {
  if (!current) return;
  const was = current;
  current.tile.classList.remove("is-open");
  current = null;
  gallery.classList.remove("open");
  if (push) history.pushState(null, "", location.pathname + location.search);
  if (gallery.offsetParent === null) return;
  scrollTo({ top: gridScroll, behavior: "instant" });
  // the grid comes back, the tile you left first
  const list = [was, ...order().filter((x) => x !== was)];
  list.forEach((x, i) => x.tile.animate(
    [{ opacity: 0, transform: "translateY(10px) scale(0.98)" }, { opacity: 1, transform: "none" }],
    { duration: dur(ENTER_MS), delay: dur(Math.min(i * STAGGER_MS, STAGGER_MAX_MS)), easing: EASE_OUT.css, fill: "backwards" }
  ));
  was.tile.focus({ preventScroll: true });
}

const step = (d) => {
  const list = order();
  open(list[(list.indexOf(current) + d + list.length) % list.length], { step: true });
};

head.querySelector(".gal-back").addEventListener("click", () => close());
for (const b of head.querySelectorAll(".gal-step")) b.addEventListener("click", () => step(+b.dataset.d));
addEventListener("keydown", (e) => {
  if (!current || e.defaultPrevented || e.target.closest("input, select, textarea, [role=slider], dialog") || dash.hidden) return;
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

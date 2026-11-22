// The dashboard as a gallery: every graph is a tile with a live thumbnail of its own (thumbs.js), in sections. A tile
// opens its card in the grid's place at full size, the bar kept above it; ‹ › (or the arrow keys) step through the
// graphs, "All graphs" (or Esc, or Back) returns.
//
// The cards wait in a stage off screen, always --gal-w wide, so putOff (state.js) holds their paints while the grid
// shows: a drag of the period redraws the thumbnails and the rolling chart's data, not thirteen full graphs. Opening
// one moves it into view at the same width (no chart resizes) and its held paint runs. The grid, likewise, moves off
// screen while a card is open rather than hiding, so the thumbnails keep their size.

import { $ } from "./state.js";
import { ENTER_MS, STAGGER_MS, STAGGER_MAX_MS, EASE_OUT, dur } from "./motion.js";
import { addThumb, paintThumbs } from "./thumbs.js";

// [section, [card id, slug for the address]]
const SECTIONS = [
  ["Your top", [["mix-card", "mix"], ["sunburst-card", "inside"], ["ranking-card", "all"]]],
  ["Over time", [["rolling-card", "top-view"], ["race-card", "over-time"], ["rank-card", "rank-race"], ["monthly-card", "every-month"], ["discovery-card", "discovery"]]],
  ["How you listen", [["hours-card", "hours-per-week"], ["clock-card", "when"], ["raster-card", "every-play"], ["calendar-card", "every-day"], ["skips-card", "skips"]]],
];

const make = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const dash = $("dashboard");
const gallery = make("div", "gallery");
gallery.id = "gallery";
dash.querySelector(".period-bar").after(gallery);

// The open view's header (back, where you are, ‹ ›) and the slot its card moves into
const head = make("div", "gal-head");
head.innerHTML = `<button type="button" class="ghost gal-back">‹ All graphs</button><span class="gal-crumb muted"></span>
  <span class="gal-steps"><button type="button" class="ghost gal-step" data-d="-1" aria-label="Previous graph">‹</button><button type="button" class="ghost gal-step" data-d="1" aria-label="Next graph">›</button></span>`;
const slot = make("div", "gal-open");
const stage = make("div", "gal-stage");
stage.setAttribute("aria-hidden", "true");
gallery.append(head, slot);

const tiles = []; // {card, tile, slug, sec}
for (const [sec, cards] of SECTIONS) {
  const s = make("section", "gal-sec");
  s.append(make("h3", "", sec));
  const grid = make("div", "gal-grid");
  for (const [id, slug] of cards) {
    const card = $(id);
    stage.append(card);
    const tile = make("div", "gal-tile");
    tile.tabIndex = 0;
    tile.setAttribute("role", "button");
    const title = make("h4");
    const blurb = make("p");
    const thumb = make("div", "gal-thumb");
    thumb.id = "thumb-" + id;
    tile.append(title, blurb, thumb);
    grid.append(tile);
    addThumb(id, thumb);
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
    tile.addEventListener("click", () => open(entry));
    tile.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target === tile) {
        e.preventDefault();
        open(entry);
      }
    });
  }
  // "Missing something?": ask for a graph, or make one
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
  s.append(grid, ask);
  gallery.append(s);
}
gallery.append(stage);

// ---------- Fitting: the cards' full width and the tiles' columns ----------
function fit() {
  const main = gallery.closest("main");
  const cs = getComputedStyle(main);
  const w = main.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  if (w <= 0) return;
  gallery.style.setProperty("--gal-w", `${w}px`);
  gallery.style.setProperty("--gal-cols", w >= 860 ? 3 : w >= 540 ? 2 : 1);
}
fit();
new ResizeObserver(fit).observe(gallery.closest("main"));

// ---------- Opening and closing ----------
let current = null;
let gridScroll = 0;
const barHeight = () => dash.querySelector(".period-bar").getBoundingClientRect().height;
const order = () => tiles.filter((x) => !x.tile.hidden);
const rise = (el, delay = 0) => el.animate(
  [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }],
  { duration: dur(ENTER_MS), delay: dur(delay), easing: EASE_OUT.css, fill: "backwards" }
);

function open(entry, { step = false, push = true } = {}) {
  if (current === entry) return;
  if (!current) gridScroll = scrollY;
  if (current) stage.append(current.card);
  current = entry;
  slot.append(entry.card);
  gallery.classList.add("open");
  const list = order();
  head.querySelector(".gal-crumb").textContent = `${entry.sec} · ${list.indexOf(entry) + 1} of ${list.length}`;
  if (push) history[step || location.hash.slice(1) === entry.slug ? "replaceState" : "pushState"]({ gallery: entry.slug }, "", "#" + entry.slug);
  if (gallery.offsetParent === null) return;
  // the open card starts just under the bar
  scrollTo({ top: gallery.getBoundingClientRect().top + scrollY - barHeight() - 8, behavior: "instant" });
  rise(entry.card);
  if (!step) rise(head);
}

function close({ push = true } = {}) {
  if (!current) return;
  const was = current;
  stage.append(was.card);
  current = null;
  gallery.classList.remove("open");
  if (push) history.pushState(null, "", location.pathname + location.search);
  if (gallery.offsetParent === null) return;
  scrollTo({ top: gridScroll, behavior: "instant" });
  // the grid comes back, the tile you left first
  [was, ...order().filter((x) => x !== was)].forEach((x, i) => rise(x.tile, Math.min(i * STAGGER_MS, STAGGER_MAX_MS)));
  was.tile.focus({ preventScroll: true });
  paintThumbs();
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

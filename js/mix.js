// The listening mix: one bar showing each shown artist's share of the selected period (any stretch of days the brush picks).
// It reads the same per-day artist table as the rolling chart (aggregate.dailyTable), so the two always agree.
// Hovering an artist anywhere (chart, the period bar's key, lists, this bar) lights their segment; clicking pins them.
// Segments are kept per artist, so changing the period slides and resizes the ones that stay (colors and identity preserved), grows newcomers from nothing and collapses whoever leaves.

import { dayToDate, rangeHours } from "./aggregate.js";
import { MORPH_MS, dur, easeInOut, flip, tweenNumber } from "./motion.js";
import { coverFor, knownCover } from "./covers.js";

const $ = (id) => document.getElementById(id);

const GAP = 2; // px between segments

let ctx = null; // { table, names, slots, pins, hasOther, periodLabel, lo, hi } from the last updateMix
let hover = () => {};
// name -> { name, seg, label, x, w, from, to, leaving, pinnable }; x and w are fractions of the bar
const entries = new Map();
let raf = 0;
let under = null; // the artist whose segment or tile the pointer is on

const fmtDay = (d) => dayToDate(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const fmtHours = (h) => h.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " h";

const span = (cls) => {
  const el = document.createElement("span");
  el.className = cls;
  return el;
};

// A segment shows its share and, beneath it, its hours; who it is reads in its tile of the key under the bar, in the same color
// and never cut short. A click on either pins them; a click on the color tab beside the tile hides or shows them
// (the tab sits outside the card, so hovering it doesn't light the artist).
function makeEntry(name) {
  const seg = document.createElement("div");
  seg.className = "mix-seg";
  const label = span("mix-pct");
  const hoursEl = span("mix-hours");
  seg.append(label, hoursEl);
  const row = document.createElement("li");
  const tab = document.createElement("button");
  tab.type = "button";
  tab.className = "tab";
  tab.append(span("bar"));
  const rowWho = span("who");
  const rowName = span("name");
  const rowBy = span("by");
  rowWho.append(rowName, rowBy);
  // Tracks and albums: the album's cover, on a square of the artist's color until it arrives
  const art = span("art");
  const img = new Image();
  img.alt = "";
  img.decoding = "async";
  img.addEventListener("load", () => img.classList.add("shown"));
  art.append(img);
  const card = span("mix-card");
  card.append(art, rowWho);
  row.append(tab, card);
  const e = { name, seg, label, hoursEl, row, card, tab, rowName, rowBy, img, coverId: undefined, coverTimer: 0, x: 0, w: 0, from: null, to: null, leaving: false, pinnable: false };
  for (const el of [seg, card]) {
    el.addEventListener("pointerenter", () => hover((under = name)));
    el.addEventListener("pointerleave", () => hover((under = null)));
  }
  seg.addEventListener("click", () => e.pinnable && !e.off && ctx.pins.toggle(name));
  // A hidden one's tile brings it back, like its chip in the period bar's key
  const act = () => e.pinnable && (e.off ? ctx.pins.hide(name) : ctx.pins.toggle(name));
  card.addEventListener("click", act);
  card.addEventListener("keydown", (ev) => {
    if (ev.target === card && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); act(); }
  });
  tab.addEventListener("click", () => {
    if (!e.pinnable) return;
    hover(null);
    ctx.pins.hide(name);
  });
  return e;
}

// A segment this wide (px) has room for its share, and from HOURS_PX for its hours beneath
const SHARE_PX = 30;
const HOURS_PX = 48;
const EDGE = 1e-6; // how close to an end of the bar counts as touching it

// Puts every segment where its x and w say, and shows what fits. The segments at either end
// round the bar's outer corners.
function place() {
  const bar = $("mix-bar");
  const W = bar.clientWidth + GAP;
  for (const e of entries.values()) {
    const px = Math.max(0, e.w * W - GAP);
    e.seg.style.left = `${e.x * W}px`;
    e.seg.style.width = `${px}px`;
    e.label.textContent = Math.round(e.w * 100) + "%";
    // Under a pixel wide (no listening in the period) the segment isn't drawn at all: its padding and a pin's
    // outline would otherwise still show
    e.seg.classList.toggle("gone", px < 1);
    e.seg.classList.toggle("fits-share", px >= SHARE_PX && !e.leaving);
    e.seg.classList.toggle("fits-hours", px >= HOURS_PX && !e.leaving && !e.off);
    e.seg.classList.toggle("outer-l", e.x <= EDGE);
    e.seg.classList.toggle("outer-r", e.x + e.w >= 1 - EDGE);
  }
}

function frame(p) {
  for (const e of entries.values()) {
    e.x = e.from.x + (e.to.x - e.from.x) * p;
    e.w = e.from.w + (e.to.w - e.from.w) * p;
  }
  place();
}

function glide() {
  cancelAnimationFrame(raf);
  const ms = dur(MORPH_MS);
  const moving = [...entries.values()].some((e) => e.from.x !== e.to.x || e.from.w !== e.to.w);
  const done = () => {
    raf = 0;
    frame(1);
    for (const [name, e] of entries) {
      if (!e.leaving) continue;
      e.seg.remove();
      e.row.remove();
      clearTimeout(e.coverTimer);
      entries.delete(name);
    }
  };
  if (!ms || !moving || !$("mix-bar").clientWidth) return done();
  const t0 = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - t0) / ms);
    if (t === 1) return done();
    frame(easeInOut(t));
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

// Called on every (non-sweep) render of the rolling chart. table: aggregate.dailyTable for the shown
// artists; pins: {has, toggle, hide} for the chart's pinned artists; names/slots/hasOther: the chart's artists and
// their palette slots; plays: name -> plays over the period; lo/hi: the period's first and last day; noun: what the
// names are ({ one, many }, artists by default).
export function updateMix(next) {
  ctx = next;
  const { table, names, slots, hasOther, lo, hi, hidden } = ctx;
  const range = rangeHours(table, lo, hi);
  // Deselected artists have no share of the bar, and the rest fill it
  const hours = range.hours.map((h, i) => (hidden.has(names[i]) ? 0 : h));
  const total = hours.reduce((a, b) => a + b, 0);
  const bar = $("mix-bar");

  $("mix-sub").textContent = `${ctx.periodLabel} · ${fmtDay(lo)} – ${fmtDay(hi)}`;
  // Without "Everyone else" the bar only counts the artists shown
  $("mix-total-label").textContent = hasOther ? "Total listening" : `Shown ${ctx.noun?.many ?? "artists"}`;
  const totalEl = $("mix-total");
  if (total) tweenNumber(totalEl, total, { format: fmtHours });
  else {
    cancelAnimationFrame(totalEl._raf);
    totalEl._num = 0;
    totalEl.textContent = "none";
  }
  bar.classList.toggle("empty", !total);
  bar.setAttribute("aria-label", `Listening mix: ${names.map((n, i) => `${n} ${total ? Math.round((hours[i] / total) * 100) : 0}%`).join(", ")}`);

  const first = entries.size === 0;

  // Targets in the new order
  const target = new Map();
  let acc = 0;
  names.forEach((name, i) => {
    const w = total ? hours[i] / total : 0;
    target.set(name, { x: acc, w });
    acc += w;
  });

  // Whoever isn't shown any more collapses into the place of the next artist that stays
  const oldOrder = [...entries.values()].sort((a, b) => a.x - b.x);
  oldOrder.forEach((e, i) => {
    if (target.has(e.name)) return;
    e.leaving = true;
    const next = oldOrder.slice(i + 1).find((o) => target.has(o.name));
    e.to = { x: next ? target.get(next.name).x : 1, w: 0 };
  });

  const list = $("mix-list");
  list.classList.toggle("with-covers", !!ctx.cover && names.some((n) => ctx.cover(n)?.ids.length));
  list.classList.toggle("portraits", ctx.noun?.one === "artist"); // artists' photos are round, albums' covers square
  const rowsBefore = new Map([...entries].map(([n, e]) => [n, e.row.getBoundingClientRect()]));
  names.forEach((name, i) => {
    let e = entries.get(name);
    if (!e) {
      e = makeEntry(name);
      entries.set(name, e);
      bar.append(e.seg);
      const t = target.get(name);
      Object.assign(e, { x: t.x, w: 0 }); // grows from nothing where it will sit
    }
    e.leaving = false;
    e.from = { x: e.x, w: e.w };
    e.to = target.get(name);
    e.pinnable = !(hasOther && i === names.length - 1);
    const pinned = e.pinnable && ctx.pins.has(name);
    const color = hasOther && i === names.length - 1 ? "var(--other)" : `var(--series-${(slots?.[i] ?? i) + 1})`;
    e.seg.style.setProperty("--c", color);
    e.seg.classList.toggle("pinnable", e.pinnable);
    e.seg.classList.toggle("pinned", pinned);
    const off = hidden.has(name);
    e.off = off;
    e.seg.classList.toggle("off", off);
    tweenNumber(e.hoursEl, hours[i], { format: fmtHours });
    const other = hasOther && i === names.length - 1;
    e.rowName.textContent = other ? name : ctx.title?.(name) ?? name; // from the user's files
    e.rowBy.textContent = other ? "" : ctx.by?.(name) ?? "";
    const by = e.rowBy.textContent ? ` ${e.rowBy.textContent}` : "";
    showCover(e, other ? undefined : ctx.cover?.(name));
    e.row.style.setProperty("--c", color);
    e.row.classList.toggle("pinnable", e.pinnable);
    e.row.classList.toggle("pinned", pinned);
    e.row.classList.toggle("off", off);
    e.card.tabIndex = e.pinnable ? 0 : -1;
    e.card.setAttribute("role", "button");
    e.tab.disabled = !e.pinnable; // everyone else is shown or hidden from the period bar's key
    e.tab.title = off ? `Show ${e.rowName.textContent}` : `Hide ${e.rowName.textContent}`;
    e.tab.setAttribute("aria-label", e.tab.title);
    e.tab.setAttribute("aria-pressed", !off);
    const share = e.to.w;
    e.card.title = e.seg.title = off ? "" : `${pinned ? "Click to unpin · " : e.pinnable ? "Click to pin · " : ""}${e.rowName.textContent}${by} · ${(share * 100).toFixed(share < 0.1 ? 1 : 0)}% · ${fmtHours(hours[i])}`;
  });
  for (const e of entries.values()) if (e.leaving) { e.from = { x: e.x, w: e.w }; e.row.remove(); }
  list.replaceChildren(...names.map((n) => entries.get(n).row));
  flip(rowsBefore, new Map(names.map((n) => [n, entries.get(n).row])));

  if (first) {
    for (const e of entries.values()) { e.x = e.to.x; e.w = e.to.w; e.from = e.to; }
    place();
  } else glide();
  dim();
  // Clicking to pin re-renders the chart, which drops its hover; while the pointer is still here, light them again
  if (under && names.includes(under) && focusName !== under) hover(under);
}

// A row's cover: at once when it's known, otherwise asked for once the bar holds still (a drag redraws the bar
// every ~90 ms, and the covers of whatever it passes over aren't worth fetching)
const COVER_WAIT_MS = 250;
function showCover(e, id) {
  if (id === e.coverId) return;
  e.coverId = id;
  clearTimeout(e.coverTimer);
  e.img.classList.remove("shown");
  e.img.removeAttribute("src");
  if (!id) return;
  const put = (url) => e.coverId === id && url && (e.img.src = url);
  const known = knownCover(id);
  if (known !== undefined) return put(known);
  e.coverTimer = setTimeout(() => coverFor(id, { soon: true }).then(put), COVER_WAIT_MS);
}

// Pinned artists and the hovered one stay lit and the rest dim (nobody dims while there's neither). A hover
// lights one more artist; it never dims a pinned one.
let focusName = null;
function dim() {
  const focus = focusName == null ? undefined : entries.get(focusName);
  // A pinned artist with no listening in the period isn't drawn, so it dims nobody. The pins are read live: a pin
  // re-renders the chart, which clears its hover before this bar is told about the new pin
  const pinned = (e) => e.pinnable && ctx.pins.has(e.name) && e.to?.w > 0;
  const any = !!focus || [...entries.values()].some(pinned);
  for (const e of entries.values()) {
    const lit = !any || e === focus || pinned(e);
    e.seg.classList.toggle("dim", !lit);
    e.row.classList.toggle("dim", !lit);
  }
}

// Light one artist's segment (and dim the rest), from a hover anywhere on the page; null clears
export function highlightMix(name) {
  // A re-render clearing the hover doesn't unlight the one the pointer is still on (updateMix lights them again)
  if (name == null && under && entries.has(under)) name = under;
  focusName = ctx ? name : null;
  for (const e of entries.values()) {
    e.seg.classList.toggle("focus", e.name === focusName);
    e.row.classList.toggle("focus", e.name === focusName);
  }
  dim();
}

export function setupMix(onHover) {
  hover = onHover;
  new ResizeObserver(() => !raf && place()).observe($("mix-bar"));
}

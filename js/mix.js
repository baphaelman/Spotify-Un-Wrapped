// The listening mix: one bar showing each shown artist's share of the selected period (any stretch of days the brush picks).
// It reads the same per-day artist table as the rolling chart (aggregate.dailyTable), so the two always agree.
// Hovering an artist anywhere (chart, the period bar's key, lists, this bar) lights their segment; clicking pins them.
// Segments are kept per artist, so changing the period slides and resizes the ones that stay (colors and identity preserved), grows newcomers from nothing and collapses whoever leaves.

import { dayToDate, rangeHours } from "./aggregate.js";
import { MORPH_MS, dur, easeInOut, tweenNumber } from "./motion.js";

const $ = (id) => document.getElementById(id);

const GAP = 2; // px between segments

let ctx = null; // { table, names, slots, pins, hasOther, periodLabel, lo, hi } from the last updateMix
let hover = () => {};
// name -> { name, seg, label, x, w, from, to, leaving, pinnable }; x and w are fractions of the bar
const entries = new Map();
let raf = 0;

const fmtDay = (d) => dayToDate(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const fmtHours = (h) => h.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " h";

const span = (cls) => {
  const el = document.createElement("span");
  el.className = cls;
  return el;
};

// A segment reads, top to bottom: its share, then the artist's name; their hours sit below it,
// under the bar. A click pins them.
function makeEntry(name) {
  const seg = document.createElement("div");
  seg.className = "mix-seg";
  const label = span("mix-pct");
  const nameEl = span("mix-name");
  nameEl.textContent = name; // from the user's files
  const who = span("mix-who");
  who.append(nameEl);
  const byEl = span("mix-by");
  seg.append(label, who, byEl);
  const hoursEl = span("mix-hours");
  const under = span("mix-under");
  under.append(hoursEl);
  const e = { name, seg, label, nameEl, byEl, under, hoursEl, x: 0, w: 0, from: null, to: null, leaving: false, pinnable: false };
  seg.addEventListener("pointerenter", () => hover(name));
  seg.addEventListener("pointerleave", () => hover(null));
  seg.addEventListener("click", () => e.pinnable && !e.off && ctx.pins.toggle(name));
  return e;
}

// What fits in a segment this wide (px): the share from SHARE_PX, the hours under it from HOURS_PX, the name
// from DETAIL_PX
const SHARE_PX = 30;
const HOURS_PX = 40;
const DETAIL_PX = 80;
const EDGE = 1e-6; // how close to an end of the bar counts as touching it

// Puts every segment and its hours where its x and w say, and shows what fits. The segments at either end
// round the bar's outer corners.
function place() {
  const bar = $("mix-bar");
  const W = bar.clientWidth + GAP;
  for (const e of entries.values()) {
    const px = Math.max(0, e.w * W - GAP);
    for (const el of [e.seg, e.under]) {
      el.style.left = `${e.x * W}px`;
      el.style.width = `${px}px`;
    }
    e.label.textContent = Math.round(e.w * 100) + "%";
    // Under a pixel wide (no listening in the period) the segment isn't drawn at all: its padding and a pin's
    // outline would otherwise still show
    e.seg.classList.toggle("gone", px < 1);
    e.seg.classList.toggle("fits-share", px >= SHARE_PX && !e.leaving);
    e.seg.classList.toggle("fits-detail", px >= DETAIL_PX && !e.leaving);
    e.under.classList.toggle("fits", px >= HOURS_PX && !e.leaving && !e.off);
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
      e.under.remove();
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

  names.forEach((name, i) => {
    let e = entries.get(name);
    if (!e) {
      e = makeEntry(name);
      entries.set(name, e);
      bar.append(e.seg, e.under);
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
    e.nameEl.textContent = other ? name : ctx.title?.(name) ?? name;
    e.byEl.textContent = other ? "" : ctx.by?.(name) ?? "";
    const by = e.byEl.textContent ? ` ${e.byEl.textContent}` : "";
    const share = e.to.w;
    e.seg.title = off ? "" : `${pinned ? "Click to unpin · " : e.pinnable ? "Click to pin · " : ""}${e.nameEl.textContent}${by} · ${(share * 100).toFixed(share < 0.1 ? 1 : 0)}% · ${fmtHours(hours[i])}`;
  });
  for (const e of entries.values()) if (e.leaving) e.from = { x: e.x, w: e.w };

  if (first) {
    for (const e of entries.values()) { e.x = e.to.x; e.w = e.to.w; e.from = e.to; }
    place();
  } else glide();
  dim();
}

// Pinned artists and the hovered one stay lit and the rest dim (nobody dims while there's neither). A hover
// lights one more artist; it never dims a pinned one.
let focusName = null;
function dim() {
  const focus = focusName == null ? undefined : entries.get(focusName);
  // A pinned artist with no listening in the period isn't drawn, so it dims nobody
  const pinned = (e) => e.seg.classList.contains("pinned") && e.to.w > 0;
  const any = !!focus || [...entries.values()].some(pinned);
  for (const e of entries.values()) {
    const lit = !any || e === focus || pinned(e);
    e.seg.classList.toggle("dim", !lit);
    e.under.classList.toggle("dim", !lit);
  }
}

// Light one artist's segment (and dim the rest), from a hover anywhere on the page; null clears
export function highlightMix(name) {
  focusName = ctx ? name : null;
  for (const e of entries.values()) e.seg.classList.toggle("focus", e.name === focusName);
  dim();
}

export function setupMix(onHover) {
  hover = onHover;
  new ResizeObserver(() => !raf && place()).observe($("mix-bar"));
}

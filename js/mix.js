// The listening mix: one bar showing each shown artist's share of the selected period (any stretch of days the brush picks).
// It reads the same per-day artist table as the rolling chart (aggregate.dailyTable), so the two always agree.
// Hovering an artist anywhere (chart, legends, lists, this bar) lights their segment; clicking pins them.
// Segments and legend entries are kept per artist, so changing the period slides and resizes the ones
// that stay (colors and identity preserved), grows newcomers from nothing and collapses whoever leaves.

import { dayToDate, rangeHours } from "./aggregate.js";
import { FADE_MS, dur, easeInOut, flip, tweenNumber } from "./motion.js";

const $ = (id) => document.getElementById(id);

const GAP = 2; // px between segments
const MIX_MS = 650;

let ctx = null; // { table, names, slots, pins, hasOther, periodLabel, lo, hi } from the last updateMix
let hover = () => {};
// name -> { name, seg, label, item, x, w, from, to, leaving, pinnable }; x and w are fractions of the bar
const entries = new Map();
let raf = 0;

const fmtDay = (d) => dayToDate(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const fmtHours = (h) => h.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " h";

function makeEntry(name) {
  const seg = document.createElement("div");
  seg.className = "mix-seg";
  const label = document.createElement("span");
  seg.append(label);
  const e = { name, seg, label, item: null, x: 0, w: 0, from: null, to: null, leaving: false, pinnable: false };
  seg.addEventListener("pointerenter", () => hover(name));
  seg.addEventListener("pointerleave", () => hover(null));
  seg.addEventListener("click", () => e.pinnable && !e.off && ctx.pins.toggle(name));
  return e;
}

function makeItem(e) {
  const item = document.createElement("span");
  item.className = "legend-item mix-legend-item";
  item.title = e.name;
  const sw = document.createElement("button");
  sw.type = "button";
  sw.className = "swatch";
  sw.addEventListener("click", (ev) => {
    ev.stopPropagation();
    hover(null);
    if (e.pinnable) ctx.pins.hide(e.name);
  });
  const label = document.createElement("span");
  label.className = "name";
  label.textContent = e.name; // artist names come from user files
  label.dataset.text = e.name; // read by the CSS that reserves the bold width
  item.append(sw, label);
  item.addEventListener("pointerenter", () => hover(e.name));
  item.addEventListener("pointerleave", () => hover(null));
  item.addEventListener("click", () => e.pinnable && (e.off ? ctx.pins.hide(e.name) : ctx.pins.toggle(e.name)));
  return item;
}

// Puts every segment where its x and w say, and writes the percentage that fits
function place() {
  const bar = $("mix-bar");
  const W = bar.clientWidth + GAP;
  for (const e of entries.values()) {
    e.seg.style.left = `${e.x * W}px`;
    e.seg.style.width = `${Math.max(0, e.w * W - GAP)}px`;
    e.label.textContent = e.w >= 0.04 && !e.leaving ? Math.round(e.w * 100) + "%" : "";
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
  const ms = dur(MIX_MS);
  const moving = [...entries.values()].some((e) => e.from.x !== e.to.x || e.from.w !== e.to.w);
  const done = () => {
    raf = 0;
    frame(1);
    for (const [name, e] of entries) {
      if (!e.leaving) continue;
      e.seg.remove();
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
// artists; pins: {has, toggle} for the chart's pinned artists; names/slots/hasOther: the chart's artists and
// their palette slots; lo/hi: the period's first and last day.
export function updateMix(next) {
  ctx = next;
  const { table, names, slots, hasOther, lo, hi, hidden } = ctx;
  const range = rangeHours(table, lo, hi);
  // Deselected artists keep their legend entry (dimmed) but have no share of the bar, and the rest fill it
  const hours = range.hours.map((h, i) => (hidden.has(names[i]) ? 0 : h));
  const total = hours.reduce((a, b) => a + b, 0);
  const bar = $("mix-bar");
  const legend = $("mix-legend");

  $("mix-sub").textContent = `${ctx.periodLabel} · ${fmtDay(lo)} – ${fmtDay(hi)}`;
  // Without "Everyone else" the bar only counts the artists shown
  $("mix-total-label").textContent = hasOther ? "Total listening" : "Shown artists";
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
  const before = new Map();
  for (const e of entries.values()) if (e.item) before.set(e.name, e.item.getBoundingClientRect());

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
    if (e.item) {
      // Fade the legend entry out where it stood, without holding up the others' move
      const { item } = e;
      const lr = legend.getBoundingClientRect();
      const r = before.get(e.name);
      Object.assign(item.style, { position: "absolute", left: `${r.left - lr.left}px`, top: `${r.top - lr.top}px`, width: `${r.width}px`, pointerEvents: "none" });
      before.delete(e.name);
      e.item = null;
      const gone = () => item.remove();
      if (dur(FADE_MS)) item.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS * 1.5 }).finished.then(gone, gone);
      else gone();
    }
  });

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
    if (!e.item) e.item = makeItem(e);
    e.from = { x: e.x, w: e.w };
    e.to = target.get(name);
    e.pinnable = !(hasOther && i === names.length - 1);
    const pinned = e.pinnable && ctx.pins.has(name);
    const color = hasOther && i === names.length - 1 ? "var(--other)" : `var(--series-${(slots?.[i] ?? i) + 1})`;
    for (const el of [e.seg, e.item]) {
      el.style.setProperty("--c", color);
      el.classList.toggle("pinnable", e.pinnable);
      el.classList.toggle("pinned", pinned);
    }
    const off = hidden.has(name);
    e.off = off;
    e.item.classList.toggle("hidden-artist", off);
    e.seg.classList.toggle("off", off);
    const sw = e.item.firstChild;
    sw.setAttribute("aria-pressed", !off);
    sw.title = off ? `Show ${name}` : `Hide ${name}`;
    sw.setAttribute("aria-label", sw.title);
    sw.disabled = !e.pinnable; // "Everyone else" has no box to untick
    const share = e.to.w;
    e.seg.title = off ? "" : `${pinned ? "Click to unpin · " : e.pinnable ? "Click to pin · " : ""}${name} · ${(share * 100).toFixed(share < 0.1 ? 1 : 0)}% · ${fmtHours(hours[i])}`;
  });
  for (const e of entries.values()) if (e.leaving) e.from = { x: e.x, w: e.w };

  // Legend in the new order, gliding from where each entry was
  const els = new Map(names.map((n) => [n, entries.get(n).item]));
  legend.append(...els.values());
  if (!first) flip(before, els, { ms: MIX_MS });

  if (first) {
    for (const e of entries.values()) { e.x = e.to.x; e.w = e.to.w; e.from = e.to; }
    place();
  } else glide();
}

// Light one artist's segment (and dim the rest), from a hover anywhere on the page; null clears
export function highlightMix(name) {
  const k = name == null || !ctx ? undefined : entries.get(name);
  $("mix-bar").classList.toggle("focusing", !!k);
  for (const e of entries.values()) {
    const on = e === k;
    e.seg.classList.toggle("focus", on);
    e.item?.classList.toggle("focus", on);
  }
}

export function setupMix(onHover) {
  hover = onHover;
  new ResizeObserver(() => !raf && place()).observe($("mix-bar"));
}

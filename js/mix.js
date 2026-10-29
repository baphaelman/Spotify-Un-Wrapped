// The listening mix: one bar showing each shown artist's share of a span of days, with several ways to move
// through time (month picker and stepper, span chips, a free day-by-day slider, and play). It reads the same
// per-day artist table as the rolling chart (aggregate.dailyTable), so the two always agree.
//
// Time is a span {start, len} in day indices (aggregate.dayIndex). The slider moves `start` one day at a
// time; the month picker sets a whole calendar month; the chips set `len`. `kind` is "month" while the span
// is exactly a picked month, which lights the picker instead of a chip.

import { dayIndex, dayToDate, rangeHours } from "./aggregate.js";

const $ = (id) => document.getElementById(id);

const span = { start: 0, len: 30, kind: "custom" };
let ctx = null; // { table, names, slots, hasOther, lo, hi } from the last updateMix
let hover = () => {};
let rendered = { key: null, bounds: null };
let segs = [];
let items = []; // legend entries, in the same order as segs
let raf = 0;

const fmt = (d, opts) => dayToDate(d).toLocaleDateString(undefined, opts);
const fmtDay = (d) => fmt(d, { month: "short", day: "numeric" });
const fmtMonth = (d) => fmt(d, { month: "short", year: "numeric" });
const monthKey = (d) => { const x = dayToDate(d); return x.getFullYear() * 12 + x.getMonth(); };
const monthStart = (k) => dayIndex(new Date(Math.floor(k / 12), k % 12, 1).getTime());
const monthEnd = (k) => dayIndex(new Date(Math.floor(k / 12), (k % 12) + 1, 0).getTime());
const fmtHours = (h) => (h >= 10 ? Math.round(h).toLocaleString() : h.toFixed(1)) + " h";

// ---------- Setting the span ----------

// Keep the span inside the period: no longer than it, and not starting before or ending after it
function clamp() {
  const { lo, hi } = ctx;
  span.len = Math.max(1, Math.min(span.len, hi - lo + 1));
  span.start = Math.max(lo, Math.min(Math.round(span.start), hi - span.len + 1));
}

function setSpan(start, len, kind = "custom") {
  span.start = start;
  span.len = len;
  span.kind = kind;
  clamp();
  paint();
}

// A whole calendar month, cut off where the period begins or ends
function setMonth(k) {
  const a = Math.max(ctx.lo, monthStart(k)), b = Math.min(ctx.hi, monthEnd(k));
  setSpan(a, b - a + 1, "month");
}

const monthOfSpan = () => monthKey(span.kind === "month" ? span.start : span.start + Math.floor(span.len / 2));

// "Everyone else" can't be pinned
const canPin = (i) => !(ctx.hasOther && i === ctx.names.length - 1);
const isPinned = (i) => canPin(i) && ctx.pins.has(ctx.names[i]);

// ---------- Painting ----------

function paint() {
  if (!ctx) return;
  const { table, names, lo, hi } = ctx;
  const end = span.start + span.len - 1;
  const { hours, total } = rangeHours(table, span.start, end);

  $("mix-sub").textContent =
    `${fmtDay(span.start)}${span.len === 1 ? "" : " – " + fmtDay(end)}, ${dayToDate(end).getFullYear()} · ${span.len} ${span.len === 1 ? "day" : "days"}`;
  // Without "Everyone else" the bar only counts the artists shown
  $("mix-total-label").textContent = ctx.hasOther ? "Total listening" : "Shown artists";
  $("mix-total").textContent = total ? `≈ ${fmtHours(total)}` : "none";
  const bar = $("mix-bar");
  bar.classList.toggle("empty", !total);
  bar.setAttribute("aria-label", `Listening mix: ${names.map((n, i) => `${n} ${total ? Math.round((hours[i] / total) * 100) : 0}%`).join(", ")}`);
  names.forEach((name, i) => {
    const share = total ? hours[i] / total : 0;
    const seg = segs[i];
    seg.style.flexGrow = share;
    seg.firstChild.textContent = share >= 0.04 ? Math.round(share * 100) + "%" : "";
    seg.classList.toggle("pinned", isPinned(i));
    items[i].classList.toggle("pinned", isPinned(i));
    seg.title = `${isPinned(i) ? "Click to unpin · " : canPin(i) ? "Click to pin · " : ""}${name} · ${(share * 100).toFixed(share < 0.1 ? 1 : 0)}% · ${fmtHours(hours[i])}`;
  });

  const slider = $("mix-slider");
  const room = hi - span.len + 1 - lo;
  slider.min = lo;
  slider.max = lo + Math.max(room, 0);
  slider.value = span.start;
  slider.disabled = room <= 0;
  slider.style.setProperty("--p", room > 0 ? (span.start - lo) / room : 0);
  slider.setAttribute("aria-valuetext", $("mix-sub").textContent);

  for (const b of $("mix-span").children) {
    const len = b.dataset.len === "all" ? hi - lo + 1 : Number(b.dataset.len);
    b.setAttribute("aria-pressed", span.kind !== "month" && span.len === len);
    b.disabled = len > hi - lo + 1;
  }
  $("mix-month").value = span.kind === "month" ? String(monthKey(span.start)) : "";
  const m = monthOfSpan();
  $("mix-prev").disabled = monthStart(m) <= lo;
  $("mix-next").disabled = monthEnd(m) >= hi;
  $("mix-latest").disabled = end >= hi;
  $("mix-play").disabled = room <= 0;
}

// Segments and legend, rebuilt only when the artists change so the bar can tween between spans
function build() {
  const { names, slots, hasOther } = ctx;
  const color = (i) => (hasOther && i === names.length - 1 ? "var(--other)" : `var(--series-${(slots?.[i] ?? i) + 1})`);
  segs = names.map((name, i) => {
    const seg = document.createElement("div");
    seg.className = "mix-seg";
    seg.style.setProperty("--c", color(i));
    seg.append(document.createElement("span"));
    seg.addEventListener("pointerenter", () => hover(name));
    seg.addEventListener("pointerleave", () => hover(null));
    // Clicking a part of the bar pins or unpins its artist, like clicking its band in the chart
    if (canPin(i)) {
      seg.classList.add("pinnable");
      seg.addEventListener("click", () => ctx.pins.toggle(name));
    }
    return seg;
  });
  $("mix-bar").replaceChildren(...segs);
  items = names.map((name, i) => {
      const item = document.createElement("span");
      item.className = "legend-item mix-legend-item";
      item.style.setProperty("--c", color(i));
      item.title = name;
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = color(i);
      const label = document.createElement("span");
      label.className = "name";
      label.textContent = name; // artist names come from user files
      item.append(sw, label);
      item.addEventListener("pointerenter", () => hover(name));
      item.addEventListener("pointerleave", () => hover(null));
      return item;
  });
  $("mix-legend").replaceChildren(...items);
}

function buildMonths() {
  const { lo, hi } = ctx;
  const opts = [new Option("Custom range", "")];
  for (let k = monthKey(lo); k <= monthKey(hi); k++) opts.push(new Option(fmtMonth(monthStart(k)), String(k)));
  opts[0].hidden = true;
  $("mix-month").replaceChildren(...opts);
  $("mix-lo").textContent = fmtMonth(lo);
  $("mix-hi").textContent = fmtMonth(hi);
}

// Called on every (non-sweep) render of the rolling chart. table: aggregate.dailyTable for the shown
// artists; pins: {has, toggle} for the chart's pinned artists; names/slots/hasOther: the chart's artists and their palette slots; lo/hi: the period's first and
// last day.
export function updateMix(next) {
  ctx = next;
  const key = ctx.names.join("\u0000") + "|" + ctx.slots?.join(",") + "|" + ctx.hasOther;
  if (key !== rendered.key) { build(); rendered.key = key; }
  const bounds = ctx.lo + ":" + ctx.hi;
  if (bounds !== rendered.bounds) {
    // A new period (or new data): start on its last month
    rendered.bounds = bounds;
    stop();
    buildMonths();
    setMonth(monthKey(ctx.hi));
    return;
  }
  clamp();
  paint();
}

// ---------- Play ----------

function stop() {
  cancelAnimationFrame(raf);
  raf = 0;
  const b = $("mix-play");
  b.textContent = "▶";
  b.setAttribute("aria-label", "Play through time");
  b.title = "Play through time";
}

function play() {
  const b = $("mix-play");
  b.textContent = "❚❚";
  b.setAttribute("aria-label", "Pause");
  b.title = "Pause";
  if (span.start + span.len - 1 >= ctx.hi) span.start = ctx.lo; // at the end: start over
  let pos = span.start, last = performance.now();
  const tick = (now) => {
    // Roughly one span per second, but never slower than a month a second
    pos += ((now - last) / 1000) * Math.max(30, span.len);
    last = now;
    const max = ctx.hi - span.len + 1;
    span.start = Math.min(pos, max);
    span.kind = "custom";
    clamp();
    paint();
    if (pos >= max) return stop();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

// ---------- Events ----------

export function setupMix(onHover) {
  hover = onHover;
  $("mix-slider").addEventListener("input", (e) => { stop(); setSpan(Number(e.target.value), span.len); });
  $("mix-month").addEventListener("change", (e) => { stop(); if (e.target.value) setMonth(Number(e.target.value)); });
  $("mix-prev").addEventListener("click", () => { stop(); setMonth(monthOfSpan() - 1); });
  $("mix-next").addEventListener("click", () => { stop(); setMonth(monthOfSpan() + 1); });
  $("mix-latest").addEventListener("click", () => { stop(); setSpan(ctx.hi - span.len + 1, span.len); });
  $("mix-play").addEventListener("click", () => (raf ? stop() : play()));
  for (const b of $("mix-span").children) {
    b.addEventListener("click", () => {
      stop();
      const len = b.dataset.len === "all" ? ctx.hi - ctx.lo + 1 : Number(b.dataset.len);
      // Grow or shrink around the middle of the current span, so the view stays where the reader was
      setSpan(Math.round(span.start + span.len / 2 - len / 2), len);
    });
  }
}

// The listening mix: one bar showing each shown artist's share of the selected period (a year, or all time).
// It reads the same per-day artist table as the rolling chart (aggregate.dailyTable), so the two always agree.
// Hovering an artist anywhere (chart, legends, lists, this bar) lights their segment; clicking pins them.

import { dayToDate, rangeHours } from "./aggregate.js";

const $ = (id) => document.getElementById(id);

let ctx = null; // { table, names, slots, pins, hasOther, periodLabel, lo, hi } from the last updateMix
let hover = () => {};
let renderedKey = null;
let segs = [];
let items = []; // legend entries, in the same order as segs

const fmtDay = (d) => dayToDate(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const fmtHours = (h) => h.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " h";

// "Everyone else" can't be pinned
const canPin = (i) => !(ctx.hasOther && i === ctx.names.length - 1);
const isPinned = (i) => canPin(i) && ctx.pins.has(ctx.names[i]);

function paint() {
  const { table, names, lo, hi } = ctx;
  const { hours, total } = rangeHours(table, lo, hi);

  $("mix-sub").textContent = `${ctx.periodLabel} · ${fmtDay(lo)} – ${fmtDay(hi)}`;
  // Without "Everyone else" the bar only counts the artists shown
  $("mix-total-label").textContent = ctx.hasOther ? "Total listening" : "Shown artists";
  $("mix-total").textContent = total ? fmtHours(total) : "none";
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
}

// Segments and legend, rebuilt only when the artists change so the bar can tween between periods
function build() {
  const { names, slots, hasOther } = ctx;
  const color = (i) => (hasOther && i === names.length - 1 ? "var(--other)" : `var(--series-${(slots?.[i] ?? i) + 1})`);
  const wire = (el, name, i) => {
    el.style.setProperty("--c", color(i));
    el.addEventListener("pointerenter", () => hover(name));
    el.addEventListener("pointerleave", () => hover(null));
    // Clicking an artist's segment or name pins or unpins them, like clicking their band in the chart
    if (canPin(i)) {
      el.classList.add("pinnable");
      el.addEventListener("click", () => ctx.pins.toggle(name));
    }
  };
  segs = names.map((name, i) => {
    const seg = document.createElement("div");
    seg.className = "mix-seg";
    seg.append(document.createElement("span"));
    wire(seg, name, i);
    return seg;
  });
  items = names.map((name, i) => {
    const item = document.createElement("span");
    item.className = "legend-item mix-legend-item";
    item.title = name;
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = color(i);
    const label = document.createElement("span");
    label.className = "name";
    label.textContent = name; // artist names come from user files
    item.append(sw, label);
    wire(item, name, i);
    return item;
  });
  $("mix-bar").replaceChildren(...segs);
  $("mix-legend").replaceChildren(...items);
}

// Called on every (non-sweep) render of the rolling chart. table: aggregate.dailyTable for the shown
// artists; pins: {has, toggle} for the chart's pinned artists; names/slots/hasOther: the chart's artists and
// their palette slots; lo/hi: the period's first and last day.
export function updateMix(next) {
  ctx = next;
  const key = ctx.names.join("\u0000") + "|" + ctx.slots?.join(",") + "|" + ctx.hasOther;
  if (key !== renderedKey) { build(); renderedKey = key; }
  paint();
}

// Light one artist's segment (and dim the rest), from a hover anywhere on the page; null clears
export function highlightMix(name) {
  const k = name == null || !ctx ? -1 : ctx.names.indexOf(name);
  $("mix-bar").classList.toggle("focusing", k >= 0);
  segs.forEach((seg, i) => seg.classList.toggle("focus", i === k));
  items.forEach((item, i) => item.classList.toggle("focus", i === k));
}

export function setupMix(onHover) {
  hover = onHover;
}

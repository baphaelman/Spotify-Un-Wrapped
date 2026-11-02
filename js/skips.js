// Skips and picks: one bar per shown artist (or track, album, genre), its plays over the period split into picked
// (you clicked the song in a list), played through (it came up next) and skipped (marked skipped, or ended with the next
// button), in shades of its color. A picked song you skipped counts as skipped. See aggregate.isPick, isSkip.
// Drawn from the same artists, colors and period as the listening mix (rollingview.renderMix); hovering a row lights
// the artist everywhere, clicking pins them. Rows are kept per artist: their parts glide to new sizes, rows move to
// their new place and newcomers rise in.

import { flip, tweenNumber } from "./motion.js";
import { tune } from "./tune.js";

const OTHER = "Everyone else";

const $ = (id) => document.getElementById(id);

let ctx = null; // { names, slots, reasons, hidden, pins, ... } from the last updateSkips
let hover = () => {};
const rows = new Map(); // name -> { row, parts, pickEl, skipEl }
let under = null; // the artist whose row the pointer is on
let focusName = null;

const pct = (x) => (x < 0.1 ? (x * 100).toFixed(1) : Math.round(x * 100)) + "%";
const fmtHours = (h) => h.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " h";

const span = (cls, text = "") => {
  const el = document.createElement("span");
  el.className = cls;
  el.textContent = text;
  return el;
};

function makeRow(name) {
  const row = document.createElement("li");
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  const who = span("name");
  const bar = span("skips-bar");
  const parts = ["picked", "on", "skipped"].map((cls) => {
    const part = bar.appendChild(document.createElement("i"));
    part.className = cls;
    return part;
  });
  // Under the head's "picked" and "skipped" columns
  const pickEl = span("num pick");
  const skipEl = span("num skip");
  row.append(who, bar, pickEl, skipEl);
  row.addEventListener("pointerenter", () => hover((under = name)));
  row.addEventListener("pointerleave", () => hover((under = null)));
  // Everyone else lights and pins nothing (as in the mix)
  const pin = () => name !== OTHER && ctx.pins.toggle(name);
  row.addEventListener("click", pin);
  row.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pin(); }
  });
  return { row, who, parts, pickEl, skipEl };
}

// next: names, slots (the chart's artists and palette slots), hidden, pins ({has, toggle}), title (name -> shown
// name), periodLabel, reasons (name -> aggregate.itemTotals entry over the period, or null when the plays don't say
// why they began and ended), reasonsLost (they would, once the files are read again), other (add a row for every
// artist not shown, this card's own toggle)
export function updateSkips(next) {
  ctx = next;
  const card = $("skips-card");
  // The account export never says; the card only shows for histories that do or could
  card.hidden = !ctx.reasons && !ctx.reasonsLost;
  $("skips-note").hidden = !ctx.reasonsLost;
  $("skips-head").hidden = !ctx.reasons;
  $("skips-sub").textContent = ctx.periodLabel;
  // The look is a visual tweak: horizontal or vertical bars, and how thick
  card.dataset.look = tune.skipsLook;
  card.style.setProperty("--skips-bar", `${tune.skipsBar}px`);
  const list = $("skips-list");
  const totals = new Map(ctx.reasons ?? []);
  if (ctx.reasons && ctx.other) totals.set(OTHER, othersOf(ctx.reasons, new Set(ctx.names)));
  const names = ctx.reasons ? [...ctx.names, ...(ctx.other ? [OTHER] : [])].filter((n) => !ctx.hidden.has(n) && totals.get(n)?.plays) : [];
  const before = new Map([...rows].map(([n, r]) => [n, r.row.getBoundingClientRect()]));
  for (const [n, r] of rows) if (!names.includes(n)) { r.row.remove(); rows.delete(n); }
  names.forEach((name) => {
    let r = rows.get(name);
    if (!r) rows.set(name, (r = makeRow(name)));
    const i = ctx.names.indexOf(name);
    r.row.style.setProperty("--c", name === OTHER ? "var(--other)" : `var(--series-${(ctx.slots?.[i] ?? i) + 1})`);
    const { plays: n, skip, pick, both, hours } = totals.get(name);
    // picked (and not skipped) / played through / skipped
    [pick - both, n - skip - pick + both, skip].forEach((v, k) => (r.parts[k].style.flexGrow = v / n));
    tweenNumber(r.pickEl, (pick / n) * 100, { format: (v) => pct(v / 100) });
    tweenNumber(r.skipEl, (skip / n) * 100, { format: (v) => pct(v / 100) });
    r.who.textContent = name === OTHER ? OTHER : ctx.title?.(name) ?? name; // from the user's files
    const pinned = ctx.pins.has(name);
    r.row.classList.toggle("pinned", pinned);
    r.row.classList.toggle("other", name === OTHER);
    r.row.title = `${name === OTHER ? "" : pinned ? "Click to unpin · " : "Click to pin · "}${r.who.textContent} · ${fmtHours(hours)} · ${Math.round(n).toLocaleString()} plays · skipped ${pct(skip / n)} · picked ${pct(pick / n)}`;
  });
  list.replaceChildren(...names.map((n) => rows.get(n).row));
  // The key's words sit over the middle of the top bar's parts, and glide with them
  const top = names.length ? totals.get(names[0]) : null;
  const keyParts = [...$("skips-head").querySelectorAll(".skips-key > span")];
  if (top) [top.pick - top.both, top.plays - top.skip - top.pick + top.both, top.skip].forEach((v, k) => (keyParts[k].style.flexGrow = v / top.plays));
  flip(before, new Map(names.map((n) => [n, rows.get(n).row])));
  dim();
  // Clicking to pin re-renders the chart, which drops its hover; while the pointer is still here, light them again
  if (under && rows.has(under) && focusName !== under) hover(under);
}

// Every artist not shown, summed (reasons holds every item in the period)
function othersOf(reasons, shown) {
  const sum = { plays: 0, skip: 0, pick: 0, both: 0, hours: 0 };
  for (const [n, e] of reasons) if (!shown.has(n)) for (const k in sum) sum[k] += e[k];
  return sum;
}

// Pinned artists and the hovered one stay lit and the rest dim; only a hover dims them less (the hover/pin rule)
function dim() {
  const anyPin = [...rows.keys()].some((n) => ctx.pins.has(n));
  const any = anyPin || (focusName != null && rows.has(focusName));
  for (const [n, r] of rows) {
    const lit = !any || n === focusName || ctx.pins.has(n);
    r.row.classList.toggle("focus", n === focusName);
    r.row.classList.toggle("dim", !lit);
    r.row.classList.toggle("glance", !lit && !anyPin);
  }
}

// Light one artist's row, from a hover anywhere on the page; null clears
export function highlightSkips(name) {
  if (name == null && under && rows.has(under)) name = under;
  focusName = ctx ? name : null;
  if (ctx) dim();
}

export function setupSkips(onHover) {
  hover = onHover;
}

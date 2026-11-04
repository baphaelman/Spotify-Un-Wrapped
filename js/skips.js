// Skips and picks: one bar per shown artist (or track, album, genre), its plays over the period split into picked
// (you clicked the song in a list), played through (it came up next) and skipped (marked skipped, or ended with the next
// button), in shades of its color. A picked song you skipped counts as skipped. See aggregate.isPick, isSkip.
// Drawn from the same artists, colors and period as the listening mix (rollingview.renderMix); hovering a row lights
// the artist everywhere, clicking pins them. Rows are kept per artist: their parts glide to new sizes, the list keeps
// one height and rows share it, gliding to their new place and size; newcomers open and leavers close where they are.

import { flip, tweenNumber, dur, MORPH_MS, EASE_IN_OUT } from "./motion.js";
import { tune } from "./tune.js";
import { fmtHours } from "./format.js";

const OTHER = "Everyone else";
const ROOM = 11; // rows the horizontal list has room for at the set thickness: the most artists and Everyone else

const $ = (id) => document.getElementById(id);

let ctx = null; // { names, slots, reasons, hidden, pins, ... } from the last updateSkips
let hover = () => {};
const rows = new Map(); // name -> { row, parts, pickEl, skipEl }
let under = null; // the artist whose row the pointer is on
let focusName = null;

const pct = (x) => (x < 0.1 ? (x * 100).toFixed(1) : Math.round(x * 100)) + "%";

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
  const horizontal = tune.skipsLook !== 1;
  // Horizontal, the list keeps one height (room for 10 artists and Everyone else at the set thickness): rows share it,
  // gliding to their new place and size, so the card never moves the page
  const H = ctx.reasons ? ROOM * (tune.skipsBar + 6) : 0;
  list.style.height = horizontal ? `${H}px` : "";
  const h = names.length ? H / names.length : 0;
  const oldNames = [...rows.keys()];
  const before = new Map([...rows].map(([n, r]) => [n, r.row.getBoundingClientRect()]));
  const leaving = [];
  for (const [n, r] of rows) if (!names.includes(n)) { rows.delete(n); horizontal || n === OTHER ? leaving.push([n, r.row]) : r.row.remove(); }
  const entering = [];
  names.forEach((name) => {
    let r = rows.get(name);
    if (!r) { rows.set(name, (r = makeRow(name))); entering.push(name); }
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
  if (horizontal) {
    // A newcomer opens from nothing, and a leaver closes to nothing, where the row after it is in the other layout,
    // so every edge glides straight from one layout to the next
    const oldH = oldNames.length ? H / oldNames.length : 0;
    const edge = (order, next, size) => (next == null ? H : order.indexOf(next) * size);
    for (const name of entering) {
      const next = names.slice(names.indexOf(name) + 1).find((n) => oldNames.includes(n));
      place(rows.get(name).row, edge(oldNames, next, oldH), 0);
    }
    for (const [name, el] of leaving) {
      list.append(el);
      const next = oldNames.slice(oldNames.indexOf(name) + 1).find((n) => names.includes(n));
      el.style.pointerEvents = "none";
      place(el, edge(names, next, h), 0);
      fade(el, true).then(() => el.remove());
    }
    void list.offsetHeight; // the newcomers start closed
    names.forEach((n, i) => place(rows.get(n).row, i * h, h));
    for (const name of entering) fade(rows.get(name).row, false);
  } else {
    // Everyone else is last, so it can grow and shrink in place without moving the other rows
    for (const [, el] of leaving) { list.append(el); resize(el, true).then(() => el.remove()); }
    if (rows.has(OTHER) && !before.has(OTHER)) resize(rows.get(OTHER).row, false);
  }
  // The key's words sit over the middle of the top bar's parts, and glide with them
  const top = names.length ? totals.get(names[0]) : null;
  const keyParts = [...$("skips-head").querySelectorAll(".skips-key > span")];
  if (top) [top.pick - top.both, top.plays - top.skip - top.pick + top.both, top.skip].forEach((v, k) => (keyParts[k].style.flexGrow = v / top.plays));
  if (!horizontal) flip(before, new Map(names.map((n) => [n, rows.get(n).row])));
  dim();
  // Clicking to pin re-renders the chart, which drops its hover; while the pointer is still here, light them again
  if (under && rows.has(under) && focusName !== under) hover(under);
}

// A horizontal row's place in the list; its top and height glide there (CSS)
function place(el, y, size) {
  el.style.setProperty("--y", `${y}px`);
  el.style.setProperty("--h", `${size}px`);
}

// A newcomer fading in as it opens, or a leaver out as it closes (on the morph tier, not the dimming's fade)
function fade(el, away) {
  const a = el.animate({ opacity: away ? [1, 0] : [0, 1] }, { duration: dur(MORPH_MS), easing: EASE_IN_OUT.css, fill: away ? "forwards" : "none" });
  return a.finished.catch(() => {});
}

// A row growing from nothing to its height (or shrinking to nothing), fading with it
function resize(el, away) {
  const h = `${el.offsetHeight}px`;
  const shut = { height: "0px", paddingTop: "0px", paddingBottom: "0px", opacity: 0 };
  const open = { height: h, opacity: 1 };
  el.style.overflow = "hidden";
  const a = el.animate(away ? [open, shut] : [shut, open], { duration: dur(MORPH_MS), easing: EASE_IN_OUT.css });
  const done = () => (el.style.overflow = "");
  return a.finished.then(done, done);
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

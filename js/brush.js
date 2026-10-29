// The period brush: the sticky bar's timeline. A backdrop of listening hours over the whole history with a
// window on it; dragging the window (or either edge) chooses the period, down to the day. The page draws
// everything from that range, so nothing is rounded to a year.

import { dayToDate } from "./aggregate.js";

const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";
const MIN_DAYS = 7; // the smallest window
const DAY = 86400000;

let model = null; // { first, last, min }: the timeline's first and last day (day indices), and the earliest day the window may reach (before `first` when the sparse start of the history is cut off)
let bands = null; // see setBrushBands
let range = null; // { lo, hi }: the window, day indices, inclusive
let onChange = () => {};
let drag = null;
let keyTimer = 0;

const days = () => model.last - model.first + 1;
const trackW = () => $("brush-track").clientWidth;
const xOf = (day) => ((day - model.first) / days()) * trackW();
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmtDay = (d) => dayToDate(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

// cb(range) runs on every change the reader makes, as they make it; done() once they let go
export function setupBrush(cb, done = () => {}) {
  onChange = cb;
  const track = $("brush-track");
  new ResizeObserver(() => draw()).observe(track);

  track.addEventListener("pointerdown", (e) => {
    if (!model || !range || e.button) return;
    const t = e.target;
    let mode = t.closest(".bh.l") ? "l" : t.closest(".bh.r") ? "r" : t.closest("#brush-win") ? "m" : null;
    if (!mode) {
      // A click on the track puts the window there, centered, and carries on as a drag of the window
      const x = e.clientX - track.getBoundingClientRect().left;
      const span = range.hi - range.lo;
      const lo = clamp(Math.round(model.first + (x / trackW()) * days()) - Math.floor(span / 2), model.min, model.last - span);
      emit(lo, lo + span);
      mode = "m";
    }
    drag = { mode, x: e.clientX, lo: range.lo, hi: range.hi };
    track.setPointerCapture(e.pointerId);
    track.classList.add("dragging");
    e.preventDefault();
  });

  track.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const d = Math.round(((e.clientX - drag.x) / trackW()) * days());
    if (drag.mode === "m") {
      const shift = clamp(d, model.min - drag.lo, model.last - drag.hi);
      emit(drag.lo + shift, drag.hi + shift);
    } else if (drag.mode === "l") {
      // Dragged to the timeline's left end, the edge goes on to the very first day, which the cut-off start hides
      const lo = clamp(Math.max(drag.lo, model.first) + d, model.first, drag.hi - (MIN_DAYS - 1));
      emit(lo <= model.first ? model.min : lo, drag.hi);
    }
    else emit(drag.lo, clamp(drag.hi + d, drag.lo + MIN_DAYS - 1, model.last));
  });

  const end = () => {
    if (!drag) return;
    drag = null;
    track.classList.remove("dragging");
    done();
  };
  track.addEventListener("pointerup", end);
  track.addEventListener("pointercancel", end);

  // Arrow keys: an edge moves a day (a month with Shift), the whole window a week (a month with Shift)
  track.addEventListener("keydown", (e) => {
    const dir = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    if (!dir || !model || !range) return;
    e.preventDefault();
    clearTimeout(keyTimer);
    keyTimer = setTimeout(done, 250);
    const t = e.target;
    if (t.classList.contains("l")) emit(clamp(range.lo + dir * (e.shiftKey ? 30 : 1), model.min, range.hi - (MIN_DAYS - 1)), range.hi);
    else if (t.classList.contains("r")) emit(range.lo, clamp(range.hi + dir * (e.shiftKey ? 30 : 1), range.lo + MIN_DAYS - 1, model.last));
    else {
      const shift = clamp(dir * (e.shiftKey ? 30 : 7), model.min - range.lo, model.last - range.hi);
      emit(range.lo + shift, range.hi + shift);
    }
  });
}

function emit(lo, hi) {
  if (range && lo === range.lo && hi === range.hi) return;
  range = { lo, hi };
  position();
  onChange({ lo, hi });
}

// Called when the data loads: the day the timeline starts and ends on (day indices), and the history's
// real first day if the timeline starts later (the sparse start is cut off, as in the rolling chart)
export function setBrushData(first, last, min = first) {
  model = { first, last, min };
  draw();
  position();
}

// The stack graph in miniature, behind the window: the rolling chart's own artists and colors over the
// whole history. { start, days: day index of each point, bands: [{ lo, hi, color, look }] } with lo/hi the band's
// edges as 0..1 of the height (null where nothing was played), color a CSS color, and look "lit" (pinned or
// hovered), "dim" (something else is lit) or "rest".
export function setBrushBands(next) {
  bands = next;
  // The timeline starts where the bands do (`start`, a day index), but not under the reader's hand: the
  // pointer is mapped to days by it, so it waits for the drag to end
  if (next.start != null && !drag && model) model.first = Math.min(next.start, model.last);
  draw();
  position();
}

// Moves the window to a range chosen elsewhere (a preset, the step buttons)
export function setBrushRange(r) {
  range = { ...r };
  position();
}

function position() {
  if (!model || !range) return;
  // A window before the timeline's cut-off start still shows, as a sliver at its left end
  const W = trackW();
  const l = Math.min(Math.max(0, xOf(range.lo)), Math.max(0, W - 8));
  const r = Math.max(xOf(range.hi + 1), l + 8);
  const win = $("brush-win");
  win.style.left = `${l}px`;
  win.style.width = `${Math.max(0, r - l)}px`;
  $("brush-dim-a").style.width = `${l}px`;
  $("brush-dim-b").style.left = `${r}px`;
  for (const [cls, value] of [["l", range.lo], ["r", range.hi]]) {
    const h = win.querySelector(`.bh.${cls}`);
    h.setAttribute("aria-valuemin", model.min);
    h.setAttribute("aria-valuemax", model.last);
    h.setAttribute("aria-valuenow", value);
    h.setAttribute("aria-valuetext", fmtDay(value));
  }
}

// The backdrop: each band as a pale tint of its artist's color, edged in the color, like the stack graph
// above it (the shades are the same CSS variables), and a tick at each new year
function draw() {
  if (!model) return;
  const W = trackW(), H = $("brush-track").clientHeight;
  if (!W) return;
  const n = days();

  const svg = $("brush-svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.replaceChildren();
  const el = (tag, attrs) => {
    const e = document.createElementNS(SVG, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    svg.append(e);
  };

  if (bands?.days.length) {
    // About one point per two pixels is plenty, and always the last
    const stride = Math.max(1, Math.floor(bands.days.length / (W / 2)));
    const idx = [];
    for (let i = 0; i < bands.days.length; i += stride) idx.push(i);
    if (idx[idx.length - 1] !== bands.days.length - 1) idx.push(bands.days.length - 1);
    const X = (i) => xOf(bands.days[i]).toFixed(1);
    const Y = (f) => ((1 - f) * H).toFixed(1);
    for (const band of bands.bands) {
      // Unbroken stretches of points that have a value
      const runs = [];
      let run = null;
      for (const i of idx) {
        if (band.hi[i] == null) run = null;
        else (run ??= (runs.push([]), runs[runs.length - 1])).push(i);
      }
      const line = (key, r) => r.map((i, k) => `${k ? "L" : "M"}${X(i)},${Y(band[key][i])}`).join("");
      const rev = (r) => [...r].reverse();
      const fill = runs.map((r) => `${line("hi", r)}${line("lo", rev(r)).replace("M", "L")}Z`).join("");
      const shade = band.look === "lit" ? "hover" : band.look === "dim" ? "dim" : "band";
      el("path", { d: fill, style: `fill:color-mix(in srgb, ${band.color} calc(var(--shade-${shade}) * 100%), var(--surface))` });
      el("path", {
        d: runs.map((r) => line("hi", r) + line("lo", r)).join(""),
        style: `fill:none;stroke:${band.color};stroke-width:${band.look === "lit" ? 2 : 1.25};stroke-linejoin:round`,
      });
    }
  }

  // A tick and a label for each January 1, thinned so the labels never touch
  const startYear = dayToDate(model.first).getFullYear();
  const endYear = dayToDate(model.last).getFullYear();
  const perYear = (W / n) * 365;
  const every = Math.max(1, Math.ceil(36 / perYear));
  const labels = $("brush-years");
  labels.replaceChildren();
  for (let yr = startYear; yr <= endYear; yr++) {
    const x = Math.max(0, xOf(Math.round(Date.UTC(yr, 0, 1) / DAY)));
    if (yr > startYear) el("line", { class: "brush-tick", x1: x, x2: x, y1: 0, y2: H });
    if ((yr - startYear) % every) continue;
    // The first year's label sits at the left end, so it's left out when the next year's is close behind it
    if (yr === startYear && xOf(Math.round(Date.UTC(yr + 1, 0, 1) / DAY)) < 40) continue;
    const s = document.createElement("span");
    s.textContent = yr;
    s.style.left = `${x}px`;
    labels.append(s);
  }
}

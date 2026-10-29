// The period brush: the sticky bar's timeline. A backdrop of listening hours over the whole history with a
// window on it; dragging the window (or either edge) chooses the period, down to the day. The page draws
// everything from that range, so nothing is rounded to a year.

import { dayToDate } from "./aggregate.js";

const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";
const MIN_DAYS = 7; // the smallest window
const DAY = 86400000;

let model = null; // { first, last, daily }: the history's day indices and hours per day
let range = null; // { lo, hi }: the window, day indices, inclusive
let onChange = () => {};
let drag = null;

const days = () => model.last - model.first + 1;
const trackW = () => $("brush-track").clientWidth;
const xOf = (day) => ((day - model.first) / days()) * trackW();
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmtDay = (d) => dayToDate(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

// cb(range) runs on every change the reader makes, as they make it
export function setupBrush(cb) {
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
      const lo = clamp(Math.round(model.first + (x / trackW()) * days()) - Math.floor(span / 2), model.first, model.last - span);
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
      const shift = clamp(d, model.first - drag.lo, model.last - drag.hi);
      emit(drag.lo + shift, drag.hi + shift);
    } else if (drag.mode === "l") emit(clamp(drag.lo + d, model.first, drag.hi - (MIN_DAYS - 1)), drag.hi);
    else emit(drag.lo, clamp(drag.hi + d, drag.lo + MIN_DAYS - 1, model.last));
  });

  const end = () => {
    drag = null;
    track.classList.remove("dragging");
  };
  track.addEventListener("pointerup", end);
  track.addEventListener("pointercancel", end);

  // Arrow keys: an edge moves a day (a month with Shift), the whole window a week (a month with Shift)
  track.addEventListener("keydown", (e) => {
    const dir = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    if (!dir || !model || !range) return;
    e.preventDefault();
    const t = e.target;
    if (t.classList.contains("l")) emit(clamp(range.lo + dir * (e.shiftKey ? 30 : 1), model.first, range.hi - (MIN_DAYS - 1)), range.hi);
    else if (t.classList.contains("r")) emit(range.lo, clamp(range.hi + dir * (e.shiftKey ? 30 : 1), range.lo + MIN_DAYS - 1, model.last));
    else {
      const shift = clamp(dir * (e.shiftKey ? 30 : 7), model.first - range.lo, model.last - range.hi);
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

// Called when the data loads: the history's first and last day, and the hours on each day between
export function setBrushData(first, last, daily) {
  model = { first, last, daily };
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
  const l = xOf(range.lo), r = xOf(range.hi + 1);
  const win = $("brush-win");
  win.style.left = `${l}px`;
  win.style.width = `${Math.max(0, r - l)}px`;
  $("brush-dim-a").style.width = `${l}px`;
  $("brush-dim-b").style.left = `${r}px`;
  for (const [cls, value] of [["l", range.lo], ["r", range.hi]]) {
    const h = win.querySelector(`.bh.${cls}`);
    h.setAttribute("aria-valuemin", model.first);
    h.setAttribute("aria-valuemax", model.last);
    h.setAttribute("aria-valuenow", value);
    h.setAttribute("aria-valuetext", fmtDay(value));
  }
}

// The backdrop: hours per day, averaged over a few pixels' worth of days, with a tick at each new year
function draw() {
  if (!model) return;
  const W = trackW(), H = $("brush-track").clientHeight;
  if (!W) return;
  const n = days();
  const half = Math.max(3, Math.round((n / W) * 2));
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + model.daily[i];
  const avg = (day) => {
    const a = Math.max(0, day - half), b = Math.min(n, day + half + 1);
    return (pre[b] - pre[a]) / (b - a);
  };
  const xs = [];
  for (let x = 0; x <= W; x += 2) xs.push(x);
  const vals = xs.map((x) => avg(Math.min(n - 1, Math.floor((x / W) * n))));
  const max = Math.max(...vals, 1e-9);
  const y = (v) => H - 3 - (v / max) * (H - 10);
  const line = xs.map((x, i) => `${i ? "L" : "M"}${x},${y(vals[i]).toFixed(1)}`).join("");

  const svg = $("brush-svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.replaceChildren();
  const el = (tag, attrs) => {
    const e = document.createElementNS(SVG, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    svg.append(e);
  };

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
    const s = document.createElement("span");
    s.textContent = yr;
    s.style.left = `${x}px`;
    labels.append(s);
  }
  el("path", { class: "brush-area", d: `${line}L${W},${H}L0,${H}Z` });
  el("path", { class: "brush-line", d: line });
}

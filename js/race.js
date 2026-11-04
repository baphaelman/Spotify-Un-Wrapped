// "Top artists over time": the view's top n (the period bar's slider) day by day through the period, played like a
// video. Each day's top list is worked out once per period (build); playing moves a playhead through the days, and
// every frame ranks the items by their value at the playhead, interpolated between the days around it. The rows
// chase their place, width and number on one clock with the time slider and the date, so a swap of ranks glides and
// a drag of the slider (a scrub) moves everything together.
// Two measures: the hours played in the days up to each day (a window that grows with the period, reaching back
// before its start, so its first days aren't empty), or so far in the period.
// Like the list below it, rows keep the chart's colors (the rest stay gray), hovering one lights its item everywhere,
// and clicking it pins or unpins it. No pictures, so no lookups.
import * as agg from "./aggregate.js";
import { $, state, noun, putOff, chartColor, MAX_PINS, WINDOWS } from "./state.js";
import { focusArtist } from "./charts.js";
import { CHASE_MS, ENTER_MS, FADE_MS, MORPH_MS, dur, litLook, scaledMs, easeInOut, easeOut } from "./motion.js";
import { tune } from "./tune.js";
import { hoursText } from "./format.js";

const KEEP = 12; // each day keeps the slider's most (10) plus two under them, which slide up from below the last bar
// The trailing window for "Last … days", one of the rolling chart's slice sizes (its slider, #race-window). A new
// period's length sets it to about a twelfth of it (a month of a year), so a short period looks at days and all time
// at months; the reader can move it from there, as the period buttons set "Days per slice".
const fitWindow = (span) => {
  let best = 0;
  for (let i = 1; i < WINDOWS.length; i++) if (Math.abs(WINDOWS[i] - span / 12) < Math.abs(WINDOWS[best] - span / 12)) best = i;
  return best;
};
let recent = 30;
let fittedSpan = null; // the period length the window was last fitted to
// How fast the period plays at 1×: the same days a second (tune.raceRate, a visual tweak) whatever its length
// The rows chase their targets with this time constant, so a move is all but done within CHASE_MS
const TAU = CHASE_MS / 3;
const SETTLED = 1e-3;

let measure = "total";
const SPEED = 1; // the default; the buttons go from a quarter as fast to four times as fast (more under "Visual tweaks")
let speed = SPEED;
let built = null; // { key, lo, hi, frames: [{ map, list, floor }] }
let t = 0; // the playhead, a fractional day index in [lo, hi]
let playing = false;
let raf = 0, last = 0;
let scale = 0; // the hours the widest bar stands for, chased like the rows
const rows = new Map(); // item -> { el, bar, val, rank, pos, op, v, shown }
let hovered = null;

// ---------- Each day's top list ----------

// The top KEEP of `keys` by vals, most first; with `zero`, items not played yet count, at 0
function pickTop(keys, vals, zero = false) {
  const top = [];
  for (const k of keys) {
    const v = vals.get(k) ?? (zero ? 0 : undefined);
    if (!(v > 0 || (zero && v === 0)) || (top.length === KEEP && v <= top[KEEP - 1][1])) continue;
    if (top.length === KEEP) top.pop();
    let i = top.length;
    while (i > 0 && top[i - 1][1] < v) i--;
    top.splice(i, 0, [k, v]);
  }
  return top;
}

// With "Everyone else" off (#race-other), only the rolling chart's artists race
const onlyChart = () => !$("race-other").checked;

function build(lo, hi) {
  const hidden = new Set(state.hidden);
  const only = onlyChart() ? new Set(state.chartNames) : null;
  // Only the chart's artists: they all race from the start, at 0 until first played
  const names = only && [...only].filter((a) => !hidden.has(a));
  const back = measure === "recent" ? recent - 1 : 0;
  const days = hi - lo + 1 + back;
  const buckets = Array.from({ length: days }, () => new Map()); // item -> ms that day
  for (const p of agg.filterRange(state.plays, lo - back, hi)) {
    if (hidden.has(p.artist) || (only && !only.has(p.artist))) continue;
    const m = buckets[agg.dayIndex(p.t) - lo + back];
    if (m) m.set(p.artist, (m.get(p.artist) ?? 0) + p.ms);
  }
  const vals = new Map();
  const frames = [];
  let top = [];
  for (let d = 0; d < days; d++) {
    for (const [k, ms] of buckets[d]) vals.set(k, (vals.get(k) ?? 0) + ms);
    if (measure === "recent") {
      // The day leaving the window takes its hours with it
      for (const [k, ms] of buckets[d - recent] ?? []) {
        const v = vals.get(k) - ms;
        if (v < 1) vals.delete(k);
        else vals.set(k, v);
      }
      if (d < back) continue;
      top = names ? pickTop(names, vals, true) : pickTop(vals.keys(), vals);
    } else {
      // Totals only grow, so today's top is among yesterday's and today's players
      top = names ? pickTop(names, vals, true) : pickTop(new Set([...top.map(([k]) => k), ...buckets[d].keys()]), vals);
    }
    frames.push({ list: top, map: new Map(top), floor: top.length === KEEP ? top[KEEP - 1][1] : 0 });
  }
  return frames;
}

// Every item near the top at the playhead, with its value there: between two days, each moves straight from one
// day's value to the next. An item only one of the days kept was at most that day's last value on the other.
function at(time) {
  const { frames, lo } = built;
  const x = Math.max(0, Math.min(frames.length - 1, time - lo));
  const k = Math.floor(x), f = x - k;
  const A = frames[k], B = frames[Math.min(k + 1, frames.length - 1)];
  const out = new Map();
  for (const [key, a] of A.list) out.set(key, a + ((B.map.get(key) ?? Math.min(a, B.floor)) - a) * f);
  for (const [key, b] of B.list) if (!A.map.has(key)) out.set(key, Math.min(b, A.floor) + (b - Math.min(b, A.floor)) * f);
  return [...out].sort((a, b) => b[1] - a[1]);
}

// ---------- Rows ----------

function makeRow(key) {
  const li = document.createElement("li");
  li._key = key;
  li.tabIndex = 0;
  li.setAttribute("role", "button");
  const rank = document.createElement("span");
  rank.className = "race-rank";
  const name = document.createElement("span");
  name.className = "race-name";
  name.textContent = state.titles?.get(key) ?? key;
  const by = state.owner?.get(key);
  if (by) {
    const small = document.createElement("small");
    small.textContent = by;
    name.append(small);
  }
  name.title = by ? `${state.titles?.get(key) ?? key} — ${by}` : key;
  const track = document.createElement("span");
  track.className = "race-track";
  const bar = document.createElement("span");
  bar.className = "race-bar";
  const val = document.createElement("span");
  val.className = "race-val";
  track.append(bar, val);
  li.append(rank, name, track);
  const c = chartColor(key);
  if (c) li.style.setProperty("--c", c);
  $("race-rows").append(li);
  return { el: li, bar, val, rankEl: rank, rank: -1, pos: n(), op: 0, v: 0, text: "", shown: false };
}

const n = () => Number($("n-artists").value);

// The hover/pin rule, as on the list's rows: hovered rows shade, pinned ones shade deeper and outline, the rest dim
function markRows() {
  const pinned = new Set(state.pinned);
  const full = state.pinned.length >= MAX_PINS;
  for (const [key, r] of rows) {
    const look = litLook(pinned, hovered, key);
    r.el.classList.toggle("focus", look === "hover" || look === "pinHover");
    r.el.classList.toggle("pinned", pinned.has(key));
    r.el.classList.toggle("dim", look === "dim" || look === "dimHover");
    r.el.classList.toggle("glance", look === "dimHover");
    r.el.setAttribute("aria-pressed", pinned.has(key));
    r.el.toggleAttribute("aria-disabled", full && !pinned.has(key));
  }
}

// The key's repaint (key.js) recolors the rows and marks the pins, as for the list
export function recolorRace() {
  if (onlyChart()) paintRace(); // the chart's artists may have changed; it rebuilds only if they did
  for (const [key, r] of rows) {
    const c = chartColor(key);
    if (c) r.el.style.setProperty("--c", c);
    else r.el.style.removeProperty("--c");
  }
  markRows();
}

// The item hovered anywhere on the page
export function focusRace(name) {
  hovered = name ?? null;
  markRows();
}

// ---------- The clock ----------

const span = () => (built ? built.hi - built.lo : 0);
const playMs = () => (span() / tune.raceRate) * 1000;

// One frame: the playhead moves on (while playing), and the rows, the slider and the date follow it
function frame(now) {
  raf = 0;
  if (!built) return;
  const dt = last ? Math.min(100, now - last) : 0; // (a frame after a stall moves on as one ordinary frame would)
  last = now;
  if (playing) {
    t += (dt / playMs()) * span() * speed;
    if (t >= built.hi) {
      t = built.hi;
      setPlaying(false);
    }
  }
  const tau = dur(TAU);
  const a = tau ? 1 - Math.exp(-dt / tau) : 1;
  const count = n();
  const ranked = at(t);
  let settled = true;
  const chase = (r, k, to) => {
    r[k] += (to - r[k]) * a;
    if (Math.abs(to - r[k]) > SETTLED * (k === "v" ? Math.max(1, to) : 1)) settled = false;
    else r[k] = to;
  };
  const top = ranked[0]?.[1] ?? 0;
  if (!scale) scale = top;
  scale += (top - scale) * a;
  if (Math.abs(top - scale) > SETTLED * Math.max(1, top)) settled = false;
  else scale = top;

  const here = new Set();
  ranked.forEach(([key, v], i) => {
    here.add(key);
    let r = rows.get(key);
    if (!r) {
      // A newcomer starts below the last bar, faded out, at its value
      rows.set(key, (r = makeRow(key)));
      r.v = v;
      markRows();
    }
    const shown = i < count;
    chase(r, "pos", shown ? i : count);
    chase(r, "op", shown ? 1 : 0);
    chase(r, "v", v);
    if (shown && r.rank !== i) {
      r.rank = i;
      r.rankEl.textContent = i + 1;
    }
    r.shown = shown;
  });
  for (const [key, r] of rows) {
    if (here.has(key)) continue;
    chase(r, "pos", count);
    chase(r, "op", 0);
    r.shown = false;
    if (r.op === 0) {
      r.el.remove();
      rows.delete(key);
    }
  }
  for (const r of rows.values()) {
    r.el.style.transform = `translateY(calc(${r.pos} * var(--race-row)))`;
    r.el.style.opacity = r.op;
    r.el.style.visibility = r.op < 0.01 ? "hidden" : "";
    r.el.style.setProperty("--f", scale > 0 ? Math.max(0, r.v / scale) : 0);
    const text = hoursText(r.v, 0);
    if (text !== r.text) r.val.textContent = r.text = text;
  }
  if (!paintLines(dt)) settled = false;
  $("race-stage").style.setProperty("--n", count);
  paintTime();
  if (playing || !settled) raf = requestAnimationFrame(frame);
  else last = 0;
}

// The scale lines: round hours (1, 2 or 5 × a power of ten) about a quarter of the widest bar apart, placed by the
// chased scale so they slide with the bars. A step is kept while 2 to 8 of it fit, so a scale hovering at a boundary
// doesn't flicker; a line leaving the step or the track fades out on FADE_MS and a new one fades in. False until all
// have settled.
const lines = new Map(); // hours -> { el, op }
let lineStep = 0;
const niceStep = (h) => {
  const p = 10 ** Math.floor(Math.log10(h)), m = h / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
};
const lineText = (h) => (h < 1 ? `${Math.round(h * 60)} min` : `${h.toLocaleString()} h`);
function paintLines(dt) {
  const h = scale / 3_600_000;
  if (h > 0 && (!lineStep || h / lineStep < 2 || h / lineStep > 8)) lineStep = niceStep(h / 4);
  const want = new Set();
  if (h > 0) for (let k = 1; k * lineStep <= h; k++) want.add(Number((k * lineStep).toPrecision(6)));
  for (const v of want) {
    if (lines.has(v)) continue;
    const el = document.createElement("span");
    el.dataset.label = lineText(v);
    el.style.opacity = 0;
    $("race-scale").append(el);
    lines.set(v, { el, op: 0 });
  }
  const tau = dur(FADE_MS / 3);
  const a = tau ? 1 - Math.exp(-dt / tau) : 1;
  let settled = true;
  for (const [v, l] of lines) {
    const to = want.has(v) ? 1 : 0;
    l.op += (to - l.op) * a;
    if (Math.abs(to - l.op) > SETTLED) settled = false;
    else l.op = to;
    if (!l.op && !to) {
      l.el.remove();
      lines.delete(v);
      continue;
    }
    l.el.style.opacity = l.op;
    l.el.style.setProperty("--f", (v * 3_600_000) / scale);
  }
  return settled;
}

function kick() {
  if (!raf) raf = requestAnimationFrame(frame);
}

// ---------- When the plays bunch up ----------

// A strip over the time slider, like a video's most-replayed graph: the hours played in the "Days" window up to each
// day, at about one point per DENSITY_PX (each the average over the days it stands for), scaled to the period's
// busiest stretch. A change morphs it point by point from what's on screen: a new window over the time the window
// takes (scaledMs), a period dragged on CHASE_MS, any other on MORPH_MS. The part before the playhead fills deeper.
const DENSITY_PX = 2;
let density = null; // { key, n, recent, shown, from, to, t0, ms, ease, raf }

function densityTarget(lo, hi, n) {
  const back = recent - 1;
  const days = hi - lo + 1 + back;
  const sums = new Float64Array(days + 1); // running total of each day's ms
  const hidden = new Set(state.hidden);
  for (const p of agg.filterRange(state.plays, lo - back, hi)) {
    if (hidden.has(p.artist)) continue;
    const d = agg.dayIndex(p.t) - lo + back;
    if (d >= 0 && d < days) sums[d + 1] += p.ms;
  }
  for (let d = 0; d < days; d++) sums[d + 1] += sums[d];
  // The window's hours up to each day of the period, then a running total of those to average a point's days
  const span = hi - lo + 1;
  const runs = new Float64Array(span + 1);
  for (let d = 0; d < span; d++) runs[d + 1] = runs[d] + sums[d + back + 1] - sums[d + back + 1 - recent];
  const out = new Float64Array(n);
  let top = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * span) / n), b = Math.max(a + 1, Math.floor(((i + 1) * span) / n));
    out[i] = (runs[b] - runs[a]) / (b - a);
    top = Math.max(top, out[i]);
  }
  if (top) for (let i = 0; i < n; i++) out[i] /= top;
  return out;
}

// What's on screen, read at n points
function resample(v, n) {
  if (v.length === n) return Float64Array.from(v);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / Math.max(1, n - 1)) * (v.length - 1), k = Math.floor(x);
    out[i] = v[k] + ((v[Math.min(k + 1, v.length - 1)] - v[k]) * (x - k));
  }
  return out;
}

function drawDensity() {
  const { shown, n } = density;
  const svg = $("race-density");
  const box = `0 0 ${n - 1} 1`;
  if (svg.getAttribute("viewBox") !== box) svg.setAttribute("viewBox", box);
  let line = "";
  for (let i = 0; i < n; i++) line += `${i ? "L" : "M"}${i} ${(1 - shown[i] * 0.9).toFixed(4)}`;
  const area = `${line}L${n - 1} 1L0 1Z`;
  svg.querySelector(".race-density-line").setAttribute("d", line);
  svg.querySelector(".race-density-fill").setAttribute("d", area);
  svg.querySelector(".race-density-played").setAttribute("d", area);
  paintPlayed();
}

function paintPlayed() {
  if (density) $("race-played").firstElementChild.setAttribute("width", (span() ? (t - built.lo) / span() : 1) * (density.n - 1));
}

function paintDensity() {
  const w = $("race-density").clientWidth;
  if (!w || !state.plays) return;
  const { lo, hi } = state.range;
  const n = Math.max(2, Math.min(hi - lo + 1, Math.round(w / DENSITY_PX)));
  const key = [state.plays.length, lo, hi, recent, n, ...state.hidden].join("\u0000");
  if (density?.key === key) return;
  const to = densityTarget(lo, hi, n);
  const prev = density;
  if (prev) cancelAnimationFrame(prev.raf);
  const [ms, ease] = !prev ? [ENTER_MS, easeOut]
    : prev.recent !== recent ? [scaledMs(prev.recent, recent), easeInOut]
    : prev.raf ? [CHASE_MS, easeOut]
    : [MORPH_MS, easeInOut];
  const from = prev ? resample(prev.shown, n) : new Float64Array(n);
  density = { key, n, recent, shown: Float64Array.from(from), from, to, t0: performance.now(), ms: dur(ms), ease, raf: 0 };
  const d = density;
  const step = (now) => {
    const e = d.ms ? Math.min(1, (now - d.t0) / d.ms) : 1, k = d.ease(e);
    for (let i = 0; i < n; i++) d.shown[i] = d.from[i] + (d.to[i] - d.from[i]) * k;
    drawDensity();
    d.raf = e < 1 ? requestAnimationFrame(step) : 0;
  };
  d.raf = requestAnimationFrame(step);
}

function paintTime() {
  const input = $("race-time");
  input.value = t;
  input.style.setProperty("--p", span() ? (t - built.lo) / span() : 1);
  paintPlayed();
  const d = agg.dayToDate(Math.floor(t));
  const text = d.toLocaleDateString(undefined, span() > 400 ? { month: "short", year: "numeric" } : { day: "numeric", month: "short", year: "numeric" });
  if ($("race-date").textContent !== text) $("race-date").textContent = text;
}

// The speed as days of the period a second, under its buttons
export function paintRate() {
  $("race-density").dataset.look = tune.densityLook; // (the colors are a visual tweak, so they're set where the tweaks land)
  const rate = tune.raceRate * speed;
  $("race-rate").textContent = `${rate < 10 ? +rate.toFixed(1) : Math.round(rate)} days/s`;
}

function setPlaying(on) {
  playing = on;
  $("race-card").classList.toggle("playing", on);
  $("race-play").setAttribute("aria-label", on ? "Pause" : "Play");
  if (on) kick();
}

// The slider's marks: each year's start, or each month's over a period of a year or so
const TICK_PX = 48;
function paintTicks() {
  if (!built) return;
  const { lo, hi } = built;
  const marks = [];
  const months = hi - lo <= 400;
  const d = agg.dayToDate(lo);
  let m = new Date(d.getFullYear(), months ? d.getMonth() + 1 : 12, 1);
  for (; ; m = new Date(m.getFullYear(), m.getMonth() + (months ? 1 : 12), 1)) {
    const i = agg.dayIndex(m.getTime());
    if (i > hi) break;
    marks.push([i, months ? m.toLocaleDateString(undefined, { month: "short" }) : String(m.getFullYear())]);
  }
  const most = Math.max(2, Math.floor($("race-ticks").clientWidth / TICK_PX)); // as many as fit without crowding
  const step = Math.ceil(marks.length / most);
  $("race-ticks").replaceChildren(...marks.filter((_, i) => i % step === 0).map(([i, label]) => {
    const s = document.createElement("span");
    s.textContent = label;
    s.style.setProperty("--p", (i - lo) / Math.max(1, hi - lo));
    return s;
  }));
}

// ---------- Painting ----------

// Rebuilt when the period, the view, the hidden items or the measure change; otherwise the rows just follow.
// A drag of the period window repaints every frame, and a long period takes tens of ms to rebuild, so rebuilds come
// at most once per REBUILD_MS (the last one always runs)
const REBUILD_MS = CHASE_MS;
let lastBuild = 0, rebuildTimer = 0;
export function paintRace() {
  const card = $("race-card");
  if (!state.plays || putOff(card, () => paintRace())) return;
  const { lo, hi } = state.range;
  if (fittedSpan !== hi - lo) {
    fittedSpan = hi - lo;
    glideWindow(fitWindow(hi - lo + 1));
  }
  recent = WINDOWS[Math.round(Number($("race-window").value))];
  if (glide) recent = WINDOWS[glide.to];
  $("race-measure").querySelector('[data-measure="recent"]').textContent = `Last ${recent} days`;
  $("race-window").closest(".slider").classList.toggle("off", measure !== "recent");
  const words = noun();
  $("race-title").textContent = `Top ${words.Many} over time`;
  $("race-sub").textContent = measure === "total"
    ? `${words.who} was on top through the period, by hours played since its start`
    : `${words.who} was on top through the period, by hours played in the ${recent} days up to each day`;
  const key = [state.plays.length, state.dim, lo, hi, measure, recent, ...state.hidden, "\u0001", ...(onlyChart() ? state.chartNames ?? [] : ["*"])].join("\u0000");
  clearTimeout(rebuildTimer);
  const wait = lastBuild + REBUILD_MS - performance.now();
  if (built && built.key !== key && wait > 0) rebuildTimer = setTimeout(paintRace, wait);
  else if (built?.key !== key) {
    const frames = build(lo, hi);
    lastBuild = performance.now();
    // Playing from the start skips the days before anything was played
    const first = frames.findIndex((f) => f.list.length);
    built = { key, lo, hi, frames, start: lo + Math.max(0, first) };
    const input = $("race-time");
    input.min = lo;
    input.max = hi;
    // A period changed while playing plays on from the same day, if it's in the new one; otherwise it waits at the start
    if (!playing || t < lo || t > hi) t = built.start;
    paintTicks();
    paintRate();
    paintDensity();
  }
  kick();
}

function play() {
  if (!built) return;
  if (playing) return setPlaying(false);
  if (t >= built.hi) t = built.start; // from the end, it starts over
  last = 0;
  setPlaying(true);
}

$("race-play").addEventListener("click", play);

// Pause shows for a moment as the pointer moves over the video
let nudge = 0;
$("race-stage").addEventListener("pointermove", () => {
  $("race-card").classList.add("nudge");
  clearTimeout(nudge);
  nudge = setTimeout(() => $("race-card").classList.remove("nudge"), 1800);
});

// A scrub: the playhead goes where the slider is, and playing carries on from there once it's let go
let resume = false;
const time = $("race-time");
time.addEventListener("pointerdown", () => {
  resume = playing;
  setPlaying(false);
});
time.addEventListener("input", () => {
  if (!built) return;
  t = Number(time.value);
  kick();
});
time.addEventListener("change", () => {
  if (resume) {
    resume = false;
    if (t < built.hi) setPlaying(true);
  }
});

for (const [group, set] of [["race-measure", (b) => (measure = b.dataset.measure)], ["race-speed", (b) => (speed = Number(b.dataset.speed))]]) {
  $(group).addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.getAttribute("aria-pressed") === "true") return;
    for (const o of $(group).children) o.setAttribute("aria-pressed", o === b);
    set(b);
    if (group === "race-measure") paintRace();
    else paintRate();
  });
}

// ---------- The window's slider ----------

// The thumb sits at --p and only the current size shows its number, as on the chart's "Days per slice"
function paintWindow() {
  const input = $("race-window");
  const v = Number(input.value), at = (x) => x / (WINDOWS.length - 1);
  input.style.setProperty("--p", at(v));
  for (const tick of input.closest(".slider").querySelectorAll(".ticks [data-v]")) {
    tick.style.setProperty("--p", at(tick.dataset.v));
    tick.classList.toggle("on", +tick.dataset.v === Math.round(v));
  }
  input.setAttribute("aria-valuetext", `${WINDOWS[Math.round(v)]} days`);
}

// Code moving the slider (a new period) glides its thumb, taking as long as the size changes by (scaledMs)
let glide = null;
function glideWindow(to) {
  const input = $("race-window");
  const from = Number(input.value);
  if (glide) cancelAnimationFrame(glide.raf);
  glide = null;
  const ms = from === to ? 0 : scaledMs(WINDOWS[Math.round(from)], WINDOWS[to]);
  if (!ms) {
    input.value = to;
    return paintWindow();
  }
  input.step = "any";
  const t0 = performance.now();
  const step = (now) => {
    const e = Math.min(1, (now - t0) / ms);
    input.value = from + (to - from) * easeInOut(e);
    paintWindow();
    if (e < 1) glide.raf = requestAnimationFrame(step);
    else {
      input.step = 1;
      input.value = to;
      glide = null;
    }
  };
  glide = { to, raf: requestAnimationFrame(step) };
}

// The reader's hand: the thumb follows the pointer
$("race-window").addEventListener("input", () => {
  if (glide) {
    cancelAnimationFrame(glide.raf);
    glide = null;
    $("race-window").step = 1;
  }
  paintWindow();
  if (measure !== "recent") $("race-measure").querySelector('[data-measure="recent"]').click();
  else paintRace();
});
for (const tick of $("race-window").closest(".slider").querySelectorAll(".ticks [data-v]")) {
  tick.addEventListener("click", () => {
    $("race-window").value = tick.dataset.v;
    $("race-window").dispatchEvent(new Event("input"));
  });
}
paintWindow();

// The slider's count changes how many rows show
$("n-artists").addEventListener("input", kick);
$("race-other").addEventListener("change", () => paintRace());

// Pinning goes through the chart's own pins, which repaint the key and so these rows (recolorRace)
function toggle(li) {
  const pins = state.mixArgs?.[3];
  if (!pins || (!pins.has(li._key) && state.pinned.length >= MAX_PINS)) return;
  pins.toggle(li._key);
}

const list = $("race-rows");
let under = null;
list.addEventListener("pointerover", (e) => {
  const li = e.target.closest("li");
  if (!li || li === under) return;
  under = li;
  focusArtist($("chart-rolling"), li._key); // an item outside the chart has nothing there to light
});
list.addEventListener("pointerleave", () => {
  under = null;
  focusArtist($("chart-rolling"), null);
});
list.addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (li) toggle(li);
});
list.addEventListener("keydown", (e) => {
  const li = e.target.closest("li");
  if (!li || (e.key !== "Enter" && e.key !== " ")) return;
  e.preventDefault();
  toggle(li);
});

// A video scrolled out of sight stops, rather than playing to nobody
new IntersectionObserver((entries) => {
  if (entries.some((e) => !e.isIntersecting) && playing) setPlaying(false);
}).observe($("race-card"));

// A narrower slider fits fewer marks
let ticksWide = 0;
new ResizeObserver(() => {
  const w = $("race-ticks").clientWidth;
  if (built) paintDensity(); // (its own key keeps the same width from redrawing)
  if (Math.abs(w - ticksWide) < TICK_PX / 2) return;
  ticksWide = w;
  paintTicks();
}).observe($("race-ticks"));

// A speed hidden again (the visual tweaks switched off) gives way to the default
new MutationObserver(() => {
  const on = [...$("race-speed").children].find((b) => b.getAttribute("aria-pressed") === "true");
  if (on?.hidden) $("race-speed").querySelector(`[data-speed="${SPEED}"]`).click();
}).observe($("race-speed"), { subtree: true, attributes: true, attributeFilter: ["hidden"] });

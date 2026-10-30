// The page's side of the rolling chart (renderRolling in charts.js draws it): its artists and colors, the
// slider and smoothing sweeps, pins, and the graphs that follow its artists (the period bar's timeline,
// the mix bar, monthly hours and the clock).
import * as agg from "./aggregate.js";
import { renderRolling, renderMonthly, renderClock, currentZoom, focusArtist, toggleArtist, onZoomChange } from "./charts.js";
import { setBrushBands } from "./brush.js";
import { sweep, cancelSweep, GROW_MS, MORPH_MS, scaledMs, sweepSteps, EASE_OUT } from "./motion.js";
import { updateMix } from "./mix.js";
import { $, state, noun, autoSpans, extent, presetOf, presetLabel, rangePlays, shownPlays, splitKind, hooks } from "./state.js";

const paintArtistKey = () => hooks.paintArtistKey(); // key.js, through main.js

// ---------- Rolling chart (the original rolling_window.py) ----------

// The period as the chart's zoom range, start of the first day to end of the last
export function periodZoom() {
  return [agg.dayToDate(state.range.lo).getTime(), agg.dayToDate(state.range.hi + 1).getTime() - 1];
}

// The rolling chart has no points before its first window is full or after its last, so a range reaching
// past them (all time, or a period at either end of the history) is trimmed to the points that exist
export function clampZoom(zoom, dates) {
  if (!dates?.length) return zoom;
  return [Math.max(zoom[0], dates[0]), Math.min(zoom[1], dates[dates.length - 1])];
}

export function rollingSub(n, target, includeOther) {
  return (state.rollingMode === "share"
    ? `Share of listening time, ${target}-day rolling window` +
      (includeOther ? "" : state.pinned.length ? `, among the ${noun().many} shown` : `, among your top ${n} ${noun().many}`)
    : `Hours per week, ${target}-day rolling average`) +
    (presetOf(state.range) === "all" ? "" : `, top ${noun().many} of ${presetLabel() === "Custom" ? "the selected period" : presetLabel()}`);
}

// Fills a slider's track up to the thumb, places its notches, and marks the notch it sits on
function paintSlider(input) {
  if (input._glide) return; // glideWindow is placing it
  const at = (v) => (v - input.min) / (input.max - input.min);
  input.style.setProperty("--p", at(input.value));
  for (const tick of input.closest(".slider").querySelectorAll(".ticks [data-v]")) {
    tick.style.setProperty("--p", at(tick.dataset.v));
    tick.classList.toggle("on", tick.dataset.v === input.value);
  }
}

// Smoothing windows in days; the slider steps through these, evenly spaced
export const WINDOWS = [7, 15, 30, 45, 75, 90, 180];

// The rolling data last computed, so a sweep through blur radii doesn't redo it for every step
export let rawMemo = null;
const SMOOTH_CURVE = [0, 0.5, 0.6, 0.75, 0.85]; // curve rounding per smoothify strength
// "auto" scales both the blur and the curve rounding with how much time is on screen (see agg.autoAmount)
// Auto's curve rounding: scaled with the amount up to high, then on toward max
const autoCurve = (a) => (a <= 1 ? a * SMOOTH_CURVE[3] : SMOOTH_CURVE[3] + (a - 1) * (SMOOTH_CURVE[4] - SMOOTH_CURVE[3]));
const smoothCurve = (strength, span) => (strength === "auto" ? autoCurve(agg.autoAmount(span, autoSpans())) : SMOOTH_CURVE[strength]);
// Days on screen: the zoom range, or the whole timeline when there isn't one (all time)
const spanDays = (zoom, dates) =>
  (Number.isFinite(zoom?.[0]) ? zoom[1] - zoom[0] : dates[dates.length - 1] - dates[0]) / 86400000 || 0;

// look: optional overrides for the steps of a sweep. { window, grid } draws the chart of another window
// size on the points of window `grid`; { sigma, smooth } sets the blur radius and curve rounding.
// followers: false leaves the lists, mix bar, monthly chart and the bar's backdrop for the caller to update.
export function renderRollingChart(zoom, morph = false, look = null, followers = !look) {
  if (!look) cancelSweep(); // any other render ends a sweep in progress
  const n = Number($("n-artists").value);
  const target = $("window")._glideTo ?? WINDOWS[$("window").value]; // (the thumb is between steps mid-glide)
  const window = look?.window ?? target;
  state.shownWindow = window; // where a window sweep starts from, even if it interrupts another
  const includeOther = $("include-other").checked;
  $("window").setAttribute("aria-valuetext", `${target} days`);
  for (const id of ["n-artists", "window"]) paintSlider($(id));

  // Top artists come from the selected period; the timeline always spans all data, zoomed to the period.
  // A period with no plays falls back to the overall top artists, so the chart still has axes to show.
  let artists = chartArtists(rangePlays(), n);
  if (!artists.length) artists = chartArtists(state.plays, n);
  const strength = state.smoothify;
  const grid = look?.grid ?? window;
  // Each artist's albums or songs, chosen from the period like the artists themselves
  const kind = splitKind();
  const split = kind && { kind, names: agg.topParts(rangePlays(), artists, kind) };
  const key = [state.dim, state.plays.length, window, grid, includeOther, ...artists, kind, JSON.stringify(split?.names)].join("\u0000");
  if (rawMemo?.key !== key) rawMemo = { key, raw: agg.rolling(state.plays, artists, window, includeOther, grid, split) };
  const raw = rawMemo.raw;
  if (Number.isFinite(zoom?.[0])) zoom = clampZoom(zoom, raw.dates);
  const span = spanDays(zoom, raw.dates);
  const sigma = look?.sigma ?? agg.smoothifySigma(window, strength, span, autoSpans());
  const curve = look?.smooth ?? smoothCurve(strength, span);
  state.shownSmooth = { sigma, curve }; // what the zoom hook compares against
  // Auto says which strength it has landed on
  const amount = agg.autoAmount(span, autoSpans());
  $("smoothify").options[0].textContent = `Auto · ${amount < 0.1 ? "Off" : amount < 0.4 ? "Low" : amount < 0.75 ? "Med" : amount < 1.5 ? "High" : "Max"}`;
  const data = agg.blur(raw, sigma);
  const names = includeOther ? [...artists, "Everyone else"] : artists;
  state.chartNames = artists;

  $("rolling-sub").textContent = rollingSub(n, target, includeOther);
  const slots = assignSlots(artists);
  const pins = {
    has: (name) => state.pinned.includes(name),
    unpin,
    toggle: (name) => (state.pinned.includes(name) ? unpin(name) : pin(name)),
    hide: (name) => toggleArtist($("chart-rolling"), name),
    openPart: (artist, kind, name) => hooks.openPart(artist, kind, name),
  };
  mixArgs = [artists, slots, includeOther, pins]; // fresh before renderRolling, which can report a new selection
  renderRolling($("chart-rolling"), data, names, window, zoom, state.rollingMode, includeOther, morph, pins, slots, curve);
  if (followers) {
    // the steps of a sweep change neither the artists nor their colors
    renderMix(artists, slots, includeOther, pins);
    paintArtistKey();
    paintMonthly();
    paintClock();
    paintBrush();
  }
}

// The brush's backdrop: the rolling chart's own data over the whole history, in miniature (see
// brush.setBrushBands). Same artists, colors and stacking, with deselected artists left out, and lit
// (pinned, or hovered anywhere) artists strong while the rest dim, as in the chart.
let brushFocus = null; // the artist lit by hover, in the chart, a legend or a list
let brushMemo = null;
export let brushMorph = null; // set while a preset or step renders: the new bands wait for the window, then morph in
// raw: another rolling result to draw instead of the chart's (the end of a window sweep); morph: see setBrushBands
export function paintBrush(raw = rawMemo?.raw, morph = brushMorph) {
  if (!raw || !state.chartNames || !raw.dates.length) return;
  if (brushMemo?.raw !== raw) brushMemo = { raw, data: agg.blur(raw, 12) };
  const { dates, share } = brushMemo.data;
  const names = $("include-other").checked ? [...state.chartNames, "Everyone else"] : state.chartNames;
  // Deselected artists stay as bands with no thickness, so showing or hiding one morphs
  const hidden = names.map((a) => state.hidden.includes(a));
  const lit = new Set([...state.pinned, brushFocus].filter((a) => a != null && names.some((n, i) => n === a && !hidden[i])));
  const total = dates.map((_, k) => names.reduce((t, _n, i) => t + (hidden[i] ? 0 : share[i][k] ?? 0), 0));
  let acc = new Float64Array(dates.length);
  const bands = names.map((_n, i) => {
    const lo = Array.from(acc);
    if (!hidden[i]) acc = acc.map((a, k) => a + (share[i][k] ?? 0));
    const frac = (v, k) => (share[i][k] == null || total[k] <= 0 ? null : v / total[k]);
    const hi = Array.from(acc, frac);
    return {
      lo: lo.map(frac),
      hi,
      color: names[i] === "Everyone else" ? "var(--other)" : `var(--series-${state.colorSlots.get(names[i]) + 1})`,
      look: hidden[i] ? "hidden" : lit.has(names[i]) ? "lit" : lit.size ? "dim" : "rest",
    };
  });
  // Without "Everyone else" its band stays on top with no thickness, so toggling it morphs
  if (!$("include-other").checked) {
    const top = total.map((t) => (t > 0 ? 1 : null));
    bands.push({ lo: top, hi: top, color: "var(--other)", look: "hidden" });
  }
  const days = dates.map(agg.dayIndex);
  // The timeline begins where the drawn artists' listening does, not where the chart's data does (that's the
  // same for every artist set, so charts can morph), so a smaller window can cut off more
  const lead = Math.max(0, agg.leadIn(dates.map((_, k) => names.reduce((t, _n, i) => t + (raw.hours[i][k] ?? 0), 0))));
  setBrushBands({ start: Math.max(extent().lo, days[lead]), end: days[days.length - 1], days, bands }, morph);
}

// When you listened, split into the chart's artists (same colors, pins and hover; keyed in the period bar)
export function paintClock(plays = shownPlays()) {
  if (!mixArgs) return;
  const [artists, , includeOther, pins] = mixArgs;
  const keyed = artists.filter((a) => state.colorSlots.has(a));
  const slots = keyed.map((n) => state.colorSlots.get(n));
  const hover = (name) => focusArtist($("chart-rolling"), name);
  renderClock($("chart-clock"), agg.clockBy(plays, keyed, 1), keyed, slots, pins, hover, new Set(state.hidden), includeOther, 0.5);
}

// Total hours per month (or longer blocks over a long period, see agg.monthSpan) with the chart's artists picked
// out (same colors, pins and hover), each bar's top artist on top. Its own "Everyone else" toggle
// (#monthly-other) shows or hides the gray, apart from the period bar's.
const SPAN_WORDS = {
  1: ["per month", "month's"],
  3: ["every 3 months", "quarter's"],
  6: ["every 6 months", "half-year's"],
  12: ["per year", "year's"],
  24: ["every 2 years", "two years'"],
};
export function paintMonthly(plays = shownPlays()) {
  if (!mixArgs) return;
  const [artists, , , pins] = mixArgs;
  // mixArgs can lag a render behind the colors, so leave out any artist without a slot yet
  const keyed = artists.filter((a) => state.colorSlots.has(a));
  // Deselected artists keep their (empty) series, so unticking one shrinks its bars in place instead of redrawing the chart
  const slots = keyed.map((n) => state.colorSlots.get(n));
  const hover = (name) => focusArtist($("chart-rolling"), name);
  const span = agg.monthSpan(plays);
  $("monthly-title").textContent = `Hours ${SPAN_WORDS[span][0]}`;
  $("monthly-note").textContent = `Each ${SPAN_WORDS[span][1]} top ${noun().one} on top`;
  const other = $("monthly-other").checked;
  renderMonthly($("chart-monthly"), agg.monthly(plays, keyed, 5, span), keyed, slots, pins, hover, new Set(state.hidden), span, other);
}
$("monthly-other").addEventListener("change", () => paintMonthly());

// The listening mix bar: the same artists, colors and per-day hours as the chart above, over the period
let mixMemo = null;
export let mixArgs = null; // the last renderMix arguments, to redraw the bar when only the legend's selection changed
export function renderMix(artists, slots, includeOther, pins) {
  mixArgs = [artists, slots, includeOther, pins];
  const key = [state.dim, state.plays.length, includeOther, ...artists].join("\u0000");
  if (mixMemo?.key !== key) mixMemo = { key, table: agg.dailyTable(state.plays, artists, includeOther) };
  // Deselected artists stay in the key but drop out of the bar (see updateMix)
  const all = includeOther ? [...artists, "Everyone else"] : artists;
  // Each segment also shows its plays over the period; everyone else's are the plays of every artist not shown
  const shown = new Set(artists);
  const plays = new Map(all.map((n) => [n, 0]));
  for (const p of rangePlays()) {
    const n = shown.has(p.artist) ? p.artist : "Everyone else";
    if (plays.has(n)) plays.set(n, plays.get(n) + 1);
  }
  updateMix({
    table: mixMemo.table,
    names: all,
    plays,
    slots,
    hidden: new Set(state.hidden),
    pins,
    hasOther: includeOther,
    periodLabel: presetLabel(),
    noun: noun(),
    // Tracks and albums: the name alone, then who made it (and a track's album) beneath
    title: (n) => state.titles?.get(n) ?? n,
    cover: state.covers ? (n) => state.covers.get(n) : null,
    by: (n) => {
      const artist = state.owner?.get(n);
      if (!artist) return "";
      const album = state.dim === "track" ? state.albums?.get(n) : null;
      return `by ${artist}` + (album ? ` · ${album}` : "");
    },
    lo: state.range.lo,
    hi: state.range.hi,
  });
}

// Palette slot for each artist in the chart, so a color follows the artist instead of their position
// in the stack (which is their rank, and shifts with the period, the artist count and the pins).
// An artist keeps the slot they last had, if it's free. Pinned artists are placed first, so they always
// keep theirs: they're in the chart the whole time they're pinned, so nothing else can have taken it.
// Newcomers take the lowest free slot, which is usually one just vacated by whoever they replaced.
function assignSlots(artists) {
  const slots = new Array(artists.length);
  const used = new Set();
  const take = (i, slot) => {
    slots[i] = slot;
    used.add(slot);
    state.colorSlots.set(artists[i], slot);
  };
  const order = [...artists.keys()].sort((a, b) => state.pinned.includes(artists[b]) - state.pinned.includes(artists[a]));
  for (const i of order) {
    const had = state.colorSlots.get(artists[i]);
    if (had !== undefined && !used.has(had)) take(i, had);
  }
  for (const i of order) {
    if (slots[i] !== undefined) continue;
    let slot = 0;
    while (used.has(slot)) slot++;
    take(i, slot);
  }
  return slots;
}

// The period's top n artists plus the pinned ones. Pins outside the top n join at the end, on top of
// the stack in the next colors, so the artists already shown keep theirs. They push out the
// lowest-ranked unpinned artists, keeping n artists (or as many as are pinned, if that's more).
export function chartArtists(plays, n) {
  const top = agg.topArtists(plays, n).map((a) => a.name);
  const extra = state.pinned.filter((a) => !top.includes(a));
  const keep = Math.max(n, state.pinned.length) - extra.length;
  for (let i = top.length - 1; top.length > keep && i >= 0; i--) {
    if (!state.pinned.includes(top[i])) top.splice(i, 1);
  }
  return [...top, ...extra];
}

// Whole bands, or each split into its albums or songs. The buttons on offer follow the view (see splitKind).
export function syncSplit() {
  const group = $("rolling-split");
  group.hidden = state.dim === "track";
  group.querySelector('[data-split="album"]').hidden = state.dim !== "artist" || !state.raw?.some((p) => p.album);
  const kind = splitKind() ?? "";
  for (const b of group.children) b.setAttribute("aria-pressed", b.dataset.split === kind);
}
for (const btn of document.querySelectorAll("#rolling-split button")) {
  btn.addEventListener("click", () => {
    const to = btn.dataset.split || null;
    if (to === splitKind()) return;
    state.split = to;
    syncSplit();
    renderRollingChart(currentZoom($("chart-rolling")), true, null, false);
  });
}

for (const btn of document.querySelectorAll("#rolling-mode button")) {
  btn.addEventListener("click", () => {
    state.rollingMode = btn.dataset.mode;
    for (const b of document.querySelectorAll("#rolling-mode button")) b.setAttribute("aria-pressed", b === btn);
    renderRollingChart(currentZoom($("chart-rolling")), true);
  });
}

// Sweeps through every blur radius between the old strength and the current one (state.smoothify), rather than
// tweening each point straight from the old curve to the new, which would just crossfade them
export function sweepSmoothing(from) {
  const days = WINDOWS[$("window").value];
  const zoom = currentZoom($("chart-rolling"));
  const span = spanDays(zoom, rawMemo?.raw.dates ?? []);
  const [s0, s1] = [from, state.smoothify].map((k) => agg.smoothifySigma(days, k, span, autoSpans()));
  const [c0, c1] = [from, state.smoothify].map((k) => smoothCurve(k, span));
  // (a blur radius under half a day counts as half a day: "off" to a little is a small change)
  const total = scaledMs(s0, s1, MORPH_MS, undefined, 0.5);
  return sweep((t, ms) => {
    const look = { sigma: s0 + (s1 - s0) * t, smooth: c0 + (c1 - c0) * t };
    renderRollingChart(currentZoom($("chart-rolling")), { ms, easing: "linear" }, look);
  }, total, sweepSteps(total));
}
$("smoothify").addEventListener("change", (e) => {
  const from = state.smoothify;
  state.smoothify = e.target.value === "auto" ? "auto" : Number(e.target.value);
  if (state.smoothify !== from) sweepSmoothing(from);
});

// In auto, the smoothing follows the zoom: once the range settles, ease to the blur it now calls for
let zoomTimer = 0;
onZoomChange($("chart-rolling"), () => {
  if (state.smoothify !== "auto") return;
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => {
    const zoom = currentZoom($("chart-rolling"));
    if (!rawMemo || !state.shownSmooth || !Number.isFinite(zoom?.[0])) return;
    const span = spanDays(zoom, rawMemo.raw.dates);
    const sigma = agg.smoothifySigma(state.shownWindow, "auto", span, autoSpans());
    const curve = smoothCurve("auto", span);
    if (Math.abs(sigma - state.shownSmooth.sigma) < 0.2 && Math.abs(curve - state.shownSmooth.curve) < 0.02) return;
    cancelSweep();
    renderRollingChart(zoom, { ms: GROW_MS, easing: EASE_OUT.echarts }, { sigma, smooth: curve });
  }, 150);
});

// The slider's thumb (and its number) travelling from window `from` to `to` days over the sweep's time, on the
// same curve and log scale, for a change the page makes (a period button); a drag moves the thumb itself.
// The thumb needs a fractional value on the way, so its step is lifted while it glides.
let glideRaf = 0;
function endGlide(to = WINDOWS[$("window").value]) {
  cancelAnimationFrame(glideRaf);
  const input = $("window");
  if (!input._glide) return;
  input.step = "1";
  input._glide = false;
  input._glideTo = null;
  input.value = WINDOWS.indexOf(to);
  // The travelling number is a label of its own: the new tick takes it over without a cross-fade, or the
  // number would flash as one fades out and the other in
  const ticks = input.closest(".slider").querySelector(".ticks");
  ticks.classList.add("settle");
  ticks.querySelector(".glide")?.remove();
  ticks.querySelector(".target")?.classList.remove("target");
  paintSlider(input);
  getComputedStyle(ticks.querySelector(".on") ?? ticks).color; // apply the change with transitions off
  ticks.classList.remove("settle");
}
function glideWindow(from, to, ms) {
  const input = $("window");
  if (!ms) return;
  // A window size's place on the slider: between two steps in proportion to the log of its size
  const place = (w) => {
    const i = Math.max(0, Math.min(WINDOWS.length - 2, WINDOWS.findLastIndex((x) => x <= w)));
    return i + Math.max(0, Math.min(1, Math.log(w / WINDOWS[i]) / Math.log(WINDOWS[i + 1] / WINDOWS[i])));
  };
  input._glide = true;
  input._glideTo = to;
  input.step = "any";
  // The number travels as a label of its own, so every tick keeps its notch in place; the current tick hands
  // its number over (not fading)
  const ticks = input.closest(".slider").querySelector(".ticks");
  const label = document.createElement("span");
  label.className = "on glide";
  ticks.classList.add("settle");
  ticks.querySelector("[data-v].on")?.classList.remove("on");
  ticks.querySelector(".target")?.classList.remove("target");
  ticks.querySelector(`[data-v="${WINDOWS.indexOf(to)}"]`)?.classList.add("target");
  ticks.append(label);
  getComputedStyle(label).color;
  ticks.classList.remove("settle");
  const t0 = performance.now();
  const tick = (now) => {
    const t = Math.max(0, Math.min(1, (now - t0) / ms));
    const e = t * t * (3 - 2 * t); // the sweep's own curve
    const w = from * (to / from) ** e;
    const at = place(w);
    input.value = at;
    input.style.setProperty("--p", at / (WINDOWS.length - 1));
    label.style.setProperty("--p", at / (WINDOWS.length - 1));
    label.textContent = Math.round(w);
    if (t < 1) glideRaf = requestAnimationFrame(tick);
    else endGlide(to);
  };
  tick(t0);
}

// A new window size: sweep through the sizes in between, evenly spaced on a log scale like the slider's
// ticks. Every step uses the points of the final chart (the window fixed on `grid`), so ECharts can tween
// each point; the first step is drawn without animation to put the old window on those points. Edges
// the old window didn't reach appear at once there.
export function sweepWindow(glide = false, to = WINDOWS[$("window").value]) {
  const zoom = () => currentZoom($("chart-rolling"));
  const from = state.shownWindow;
  endGlide(to);
  if (!from || from === to) return Promise.resolve(renderRollingChart(zoom()));
  cancelSweep();
  // Taking longer the more doublings the slice size changes by, the slider's thumb, the chart and the bar's
  // backdrop all on that time
  const total = scaledMs(from, to);
  if (glide) glideWindow(from, to, total);
  renderRollingChart(zoom(), false, { window: from, grid: to });
  paintBrush(agg.rolling(state.plays, state.chartNames, to, $("include-other").checked), { delay: 0, ms: total });
  return sweep((t, ms) => {
    const window = t === 1 ? to : Math.round(from * (to / from) ** t);
    renderRollingChart(zoom(), { ms, easing: "linear" }, { window, grid: to });
  }, total, sweepSteps(total));
}

let pending = 0;
for (const id of ["n-artists", "window", "include-other"]) {
  $(id).addEventListener("input", () => {
    // The slice size follows the pointer's step (a click or a drag) with the same eased glide and sweep as a
    // period button: the thumb trails the pointer on the sweep's curve. Read the step now, since a glide
    // in flight keeps moving the thumb to fractional values.
    let to;
    if (id === "window") {
      to = WINDOWS[Math.max(0, Math.min(WINDOWS.length - 1, Math.round(Number($(id).value))))];
      if ($(id)._glide && $(id)._glideTo === to) return; // already on its way there
    }
    cancelAnimationFrame(pending);
    // The artist-count slider re-renders continuously as it drags, so it doesn't animate
    pending = requestAnimationFrame(() => {
      if (id === "window") return sweepWindow(true, to);
      const other = id === "include-other";
      brushMorph = other ? { ms: MORPH_MS } : null; // the bar's backdrop morphs with the chart
      renderRollingChart(currentZoom($("chart-rolling")), other);
      brushMorph = null;
    });
  });
}

// A click on one of the window's notches (or where its number shows) goes to that size, the way a click on the track would
for (const tick of $("window").closest(".slider").querySelectorAll(".ticks [data-v]")) {
  tick.addEventListener("click", () => {
    $("window").value = tick.dataset.v;
    $("window").dispatchEvent(new Event("input"));
  });
}

export const MAX_PINS = 10; // one per series color

export function pin(name) {
  if (state.pinned.includes(name) || state.pinned.length >= MAX_PINS) return;
  state.pinned = [...state.pinned, name];
  brushMorph = { ms: MORPH_MS };
  renderRollingChart(currentZoom($("chart-rolling")));
  brushMorph = null;
}

function unpin(name) {
  state.pinned = state.pinned.filter((a) => a !== name);
  brushMorph = { ms: MORPH_MS };
  renderRollingChart(currentZoom($("chart-rolling")));
  brushMorph = null;
}

// Other modules read these live through their imports, but only this one can assign them
export const setBrushMorph = (m) => (brushMorph = m);
export const setBrushFocus = (name) => (brushFocus = name);
export const clearMixArgs = () => (mixArgs = null);

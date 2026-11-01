// The page's side of the rolling chart (renderRolling in charts.js draws it): its artists and colors, the
// slider and smoothing sweeps, pins, and the graphs that follow its artists (the period bar's timeline,
// the mix bar, monthly hours and the clock).
import * as agg from "./aggregate.js";
import { renderRolling, renderMonthly, renderClock, currentZoom, focusArtist, holdFocus, toggleArtist, onZoomChange, linkStrip, hiddenIn } from "./charts.js";
import { setBrushBands } from "./brush.js";
import { sweep, cancelSweep, travel, GROW_MS, MORPH_MS, scaledMs, sweepSteps, EASE_OUT, dur } from "./motion.js";
import { updateMix } from "./mix.js";
import { tune } from "./tune.js";
import { genreCoversIn } from "./views.js";
import { $, state, noun, extent, presetOf, presetLabel, rangePlays, shownPlays, splitKind, hooks, putOff, rangeTotals } from "./state.js";

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
  return `Share of listening time, ${target}-day rolling window` +
    (includeOther ? "" : state.pinned.length ? `, among the ${noun().many} shown` : `, among your top ${n} ${noun().many}`) +
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
// (both scaled by the tunables, ×1 by default; see tune.js)
const smoothCurve = (strength, span) => Math.min(1, (strength === "auto" ? autoCurve(agg.autoAmount(span)) : SMOOTH_CURVE[strength]) * tune.curveScale);
const smoothSigma = (window, strength, span) => agg.smoothifySigma(window, strength, span) * tune.blurScale;
// Days on screen: the zoom range, or the whole timeline when there isn't one (all time)
const spanDays = (zoom, dates) =>
  (Number.isFinite(zoom?.[0]) ? zoom[1] - zoom[0] : dates[dates.length - 1] - dates[0]) / 86400000 || 0;

// The Hours per week card: the chart's artists in hours per week, following its every render, zoom and hover
linkStrip($("chart-rolling"), $("chart-rolling-hours"));
// Days per slice has a slider in each card, kept in step. #window is the one the page reads; the other passes
// its moves on to it, and both glide together
const windowSliders = [$("window"), $("hours-window")];

// look: optional overrides for the steps of a sweep. { window, grid } draws the chart of another window
// size on the points of window `grid`; { sigma, smooth } sets the blur radius and curve rounding; { stretch }
// draws only the points over that [start, end] (and one past each end), unfiltered by the range (see cutTo).
// followers: false leaves the lists, mix bar, monthly chart and the bar's backdrop for the caller to update.
let renders = 0; // how many times the chart has been drawn, so a window sweep can tell whether it's still its own
export function renderRollingChart(zoom, morph = false, look = null, followers = !look) {
  renders++;
  if (!look) cancelSweep(); // any other render ends a sweep in progress
  const n = Number($("n-artists").value);
  const target = $("window")._glideTo ?? WINDOWS[$("window").value]; // (the thumb is between steps mid-glide)
  const window = look?.window ?? target;
  state.shownWindow = window; // where a window sweep starts from, even if it interrupts another
  const includeOther = $("include-other").checked;
  for (const input of windowSliders) {
    if (!input._glide) input.value = $("window").value;
    input.setAttribute("aria-valuetext", `${target} days`);
  }
  for (const input of [$("n-artists"), ...windowSliders]) paintSlider(input);

  // Top artists come from the selected period; the timeline always spans all data, zoomed to the period.
  // A period with no plays falls back to the overall top artists, so the chart still has axes to show.
  let artists = chartArtists(null, n);
  if (!artists.length) artists = chartArtists(state.plays, n);
  const strength = state.smoothify;
  const grid = look?.grid ?? window;
  // Each artist's albums or songs, chosen from the period like the artists themselves
  const kind = splitKind();
  const split = kind && { kind, names: partsOf(artists, kind) };
  const key = [state.dim, state.plays.length, window, grid, includeOther, ...artists, kind, JSON.stringify(split?.names)].join("\u0000");
  if (rawMemo?.key !== key) rawMemo = { key, raw: agg.rolling(state.plays, artists, window, includeOther, grid, split) };
  const raw = rawMemo.raw;
  if (Number.isFinite(zoom?.[0])) zoom = clampZoom(zoom, raw.dates);
  const span = spanDays(zoom, raw.dates);
  const sigma = look?.sigma ?? smoothSigma(window, strength, span);
  const curve = look?.smooth ?? smoothCurve(strength, span);
  state.shownSmooth = { sigma, curve }; // what the zoom hook compares against
  // Auto says which strength it has landed on
  const amount = agg.autoAmount(span);
  $("smoothify").options[0].textContent = `Auto · ${amount < 0.1 ? "Off" : amount < 0.4 ? "Low" : amount < 0.75 ? "Med" : amount < 1.5 ? "High" : "Max"}`;
  let data = agg.blur(raw, sigma);
  if (look?.stretch) data = cutTo(data, look.stretch);
  const names = includeOther ? [...artists, "Everyone else"] : artists;
  state.chartNames = artists;

  $("rolling-sub").textContent = rollingSub(n, target, includeOther);
  $("hours-sub").textContent = `Each ${noun().one}'s hours per week, ${target}-day rolling average`;
  const slots = assignSlots(artists);
  const pins = {
    has: (name) => state.pinned.includes(name),
    unpin,
    toggle: (name) => (state.pinned.includes(name) ? unpin(name) : pin(name)),
    hide: (name) => toggleArtist($("chart-rolling"), name),
    openPart: (artist, kind, name) => hooks.openPart(artist, kind, name),
    // Artists shown or hidden: if the rest now split into other albums or songs, the chart is drawn afresh with
    // them, the bands and parts morphing together (the chart's selection is already set)
    restack: () => {
      if (!split || JSON.stringify(partsOf(artists, kind)) === JSON.stringify(split.names)) return false;
      renderRollingChart(currentZoom($("chart-rolling")), true, null, false);
      return true;
    },
  };
  mixArgs = [artists, slots, includeOther, pins]; // fresh before renderRolling, which can report a new selection
  renderRolling($("chart-rolling"), data, names, window, zoom, "share", includeOther, morph, pins, slots, curve);
  if (followers) {
    // the steps of a sweep change neither the artists nor their colors
    renderMix(artists, slots, includeOther, pins);
    paintArtistKey();
    paintMonthly();
    paintClock();
    paintBrush();
  }
}

// The points of `data` over the dates [lo, hi], and one past each end so the lines run on past the edges,
// marked free: the chart draws them all rather than filtering them to its range, so a sweep that moves the
// range keeps the same points from step to step
function cutTo(data, [lo, hi]) {
  const { dates } = data;
  const a = Math.max(0, dates.findLastIndex((d) => d <= lo));
  const b = dates.findIndex((d) => d >= hi) + 1 || dates.length;
  const cut = (row) => row.slice(a, b);
  const parts = data.parts && { ...data.parts, hours: data.parts.hours.map((l) => l.map(cut)), share: data.parts.share.map((l) => l.map(cut)) };
  return { dates: cut(dates), hours: data.hours.map(cut), share: data.share.map(cut), parts, free: true };
}

// The albums or songs each of the chart's artists splits into: those big enough beside the artists shown, so
// deselecting artists (or showing fewer) splits the rest more finely (agg.topParts)
function partsOf(artists, kind) {
  const off = new Set(hiddenIn($("chart-rolling")));
  return agg.topParts(rangePlays(), artists, kind, artists.filter((a) => !off.has(a)));
}

// The brush's backdrop: the view's top 10 of all time over the whole history, in miniature (see
// brush.setBrushBands). It never changes with the period, the window or the chart's artists, so its bands and its
// ends hold still. Artists in the chart keep their colors from it; the rest take the colors it leaves free. Lit (pinned, or
// hovered anywhere) artists are strong while the rest dim, as in the chart.
const BRUSH_ARTISTS = 10;
const BRUSH_WINDOW = 30; // days, for the backdrop's own rolling average
let brushFocus = null; // the artist lit by hover, in the chart, a legend or a list
let brushMemo = null;
export let brushMorph = null; // set while a preset or step renders: the new bands wait for the window, then morph in
// morph: see setBrushBands (the first argument, the chart's data, is no longer read: the backdrop has its own)
export function paintBrush(_raw, morph = brushMorph) {
  if (!state.plays?.length || !state.chartNames) return;
  if (brushMemo?.plays !== state.plays) {
    const names = agg.topArtists(state.plays, BRUSH_ARTISTS).map((a) => a.name);
    const raw = agg.rolling(state.plays, names, BRUSH_WINDOW, false);
    brushMemo = { plays: state.plays, names, raw, data: agg.blur(raw, 12), bands: null };
  }
  const { names, raw, data } = brushMemo;
  const { dates, share } = data;
  if (!dates.length) return;
  // The edges are the same every time, so they're worked out once
  if (!brushMemo.bands) {
    const total = dates.map((_, k) => names.reduce((t, _n, i) => t + (share[i][k] ?? 0), 0));
    let acc = new Float64Array(dates.length);
    const edges = names.map((_n, i) => {
      const lo = Array.from(acc);
      acc = acc.map((a, k) => a + (share[i][k] ?? 0));
      const frac = (v, k) => (share[i][k] == null || total[k] <= 0 ? null : v / total[k]);
      return { lo: lo.map(frac), hi: Array.from(acc, frac) };
    });
    const days = dates.map(agg.dayIndex);
    const lead = Math.max(0, agg.leadIn(dates.map((_, k) => names.reduce((t, _n, i) => t + (raw.hours[i][k] ?? 0), 0))));
    brushMemo.bands = { edges, days, start: Math.max(extent().lo, days[lead]), end: days[days.length - 1] };
  }
  const { edges, days, start, end } = brushMemo.bands;
  const inChart = new Set(state.chartNames.filter((a) => state.colorSlots.has(a)));
  const shown = new Set([...inChart].filter((a) => !state.hidden.includes(a)));
  const lit = new Set([...state.pinned, brushFocus].filter((a) => a != null && shown.has(a)));
  // The rest take, in rank order, the colors no band here has: first those the chart leaves free, then those of
  // chart artists outside the top 10, so no two bands share one. They aren't the chart's artists, so only their
  // own name lights them, never a color they happen to share
  const mine = new Set(names.filter((n) => inChart.has(n)).map((n) => state.colorSlots.get(n)));
  const used = new Set([...inChart].map((a) => state.colorSlots.get(a)));
  const spare = [...Array(10).keys()].filter((s) => !mine.has(s)).sort((a, b) => used.has(a) - used.has(b)); // (10 series colors)
  let next = 0;
  const slotOf = (n) => (inChart.has(n) ? state.colorSlots.get(n) : spare[next++]);
  const bands = names.map((n, i) => ({
    ...edges[i],
    color: `var(--series-${slotOf(n) + 1})`,
    look: lit.has(n) ? "lit" : lit.size ? "dim" : "rest",
  }));
  setBrushBands({ start, end, days, bands }, morph);
}

// When you listened, split into the chart's artists (same colors, pins and hover; keyed in the period bar)
export function paintClock(plays) {
  if (!mixArgs || putOff($("chart-clock").closest(".card"), () => paintClock())) return;
  plays ??= shownPlays();
  const [artists, , includeOther, pins] = mixArgs;
  const keyed = artists.filter((a) => state.colorSlots.has(a));
  const slots = keyed.map((n) => state.colorSlots.get(n));
  const hover = (name) => focusArtist($("chart-rolling"), name);
  // Smoothed as the rolling chart is: its curve rounding, and its blur as a share of its window, taken as a share of
  // tune.clockReach hours (4, so High blurs about an hour), but never less than a light smoothing (tune.clockMinBlur
  // and tune.clockCurve)
  const { sigma = 0, curve = 0 } = state.shownSmooth ?? {};
  const hours = Math.max(tune.clockMinBlur, sigma >= 0.5 ? (sigma / state.shownWindow) * tune.clockReach : 0);
  renderClock($("chart-clock"), agg.clockBy(plays, keyed, 1), keyed, slots, pins, hover, new Set(state.hidden), includeOther, hours, Math.max(tune.clockCurve, curve));
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
export function paintMonthly(plays) {
  if (!mixArgs || putOff($("chart-monthly").closest(".card"), () => paintMonthly())) return;
  plays ??= shownPlays();
  const [artists, , , pins] = mixArgs;
  // mixArgs can lag a render behind the colors, so leave out any artist without a slot yet
  const keyed = artists.filter((a) => state.colorSlots.has(a));
  // Deselected artists keep their (empty) series, so unticking one shrinks its bars in place instead of redrawing the chart
  const slots = keyed.map((n) => state.colorSlots.get(n));
  const hover = (name) => focusArtist($("chart-rolling"), name);
  const span = agg.monthSpan(plays, tune.maxBars);
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
  const { items, count } = rangeTotals();
  const plays = new Map(artists.map((n) => [n, items.get(n)?.n ?? 0]));
  if (includeOther) plays.set("Everyone else", count - [...new Set(artists)].reduce((t, n) => t + (items.get(n)?.n ?? 0), 0));
  // A genre's picture is its biggest artist in the period, so it follows the period
  const covers = state.dim === "genre" ? genreCoversIn(rangePlays()) : state.covers;
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
    cover: covers ? (n) => covers.get(n) : null,
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
// Newcomers take the lowest free slot, but not one just vacated by an artist leaving the chart while another is
// free: the leaver shrinks away as they grow in, and the same color on both would read as one band changing. (With
// every color in use, they take the vacated one.) An artist coming back keeps their old slot on the same terms.
// A pin is the exception: one arriving with a slot was handed it (a part opened in its own view takes its band's
// color, see openPart), so it takes that slot even though its band has just left.
let shownSlots = new Map(); // artist → slot, as last drawn
function assignSlots(artists) {
  const slots = new Array(artists.length);
  const used = new Set();
  const here = new Set(artists);
  const vacated = new Set([...shownSlots].filter(([a]) => !here.has(a)).map(([, slot]) => slot));
  const take = (i, slot) => {
    slots[i] = slot;
    used.add(slot);
    state.colorSlots.set(artists[i], slot);
  };
  const order = [...artists.keys()].sort((a, b) => state.pinned.includes(artists[b]) - state.pinned.includes(artists[a]));
  for (const i of order) {
    const had = state.colorSlots.get(artists[i]);
    if (had !== undefined && !used.has(had) && (shownSlots.has(artists[i]) || !vacated.has(had) || state.pinned.includes(artists[i]))) take(i, had);
  }
  const SLOTS = 10; // one per series color
  for (const i of order) {
    if (slots[i] !== undefined) continue;
    let slot = 0;
    while (slot < SLOTS && (used.has(slot) || vacated.has(slot))) slot++;
    if (slot >= SLOTS) {
      const had = state.colorSlots.get(artists[i]);
      slot = had !== undefined && !used.has(had) ? had : 0;
      while (used.has(slot)) slot++;
    }
    take(i, slot);
  }
  shownSlots = new Map(artists.map((a, i) => [a, slots[i]]));
  return slots;
}

// The period's top n artists plus the pinned ones. Pins outside the top n join at the end, on top of
// the stack in the next colors, so the artists already shown keep theirs. They push out the
// lowest-ranked unpinned artists, keeping n artists (or as many as are pinned, if that's more).
// plays: null for the period's (from rangeTotals, kept per period)
export function chartArtists(plays, n) {
  const top = plays
    ? agg.topArtists(plays, n).map((a) => a.name)
    : [...rangeTotals().items].sort((a, b) => b[1].hours - a[1].hours).slice(0, n).map(([name]) => name);
  const extra = state.pinned.filter((a) => !top.includes(a));
  const keep = Math.max(n, state.pinned.length) - extra.length;
  for (let i = top.length - 1; top.length > keep && i >= 0; i--) {
    if (!state.pinned.includes(top[i])) top.splice(i, 1);
  }
  return [...top, ...extra];
}

// Whole bands, or each split into its albums or songs (a genre's also into its artists). The buttons on offer follow
// the view (see splitKind).
export function syncSplit() {
  const group = $("rolling-split");
  const genre = state.dim === "genre";
  // The row is always there; a track can't be split, so its view offers only Whole
  group.querySelector('[data-split="album"]').hidden = (state.dim !== "artist" && !genre) || !state.raw?.some((p) => p.album);
  group.querySelector('[data-split="artist"]').hidden = !genre;
  group.querySelector('[data-split="track"]').hidden = state.dim === "track";
  const kind = splitKind() ?? "";
  for (const b of group.children) b.setAttribute("aria-pressed", b.dataset.split === kind);
}
for (const btn of document.querySelectorAll("#rolling-split button")) {
  btn.addEventListener("click", () => {
    const to = btn.dataset.split || null;
    if (to === splitKind()) return;
    state.split = { ...state.split, [state.dim]: to };
    syncSplit();
    renderRollingChart(currentZoom($("chart-rolling")), true, null, false);
  });
}

// Whether any of the chart or its Hours per week card is on screen (one render draws both). A sweep's in-between
// steps are each a full render, so with neither on screen they're skipped: the sweep keeps its clock (the sliders'
// thumbs and the bar's backdrop still glide) and draws only its end. Scrolled into view partway, the next step
// morphs on from what's drawn.
const onScreen = new Set();
const seen = new IntersectionObserver((entries) => {
  for (const e of entries) e.isIntersecting ? onScreen.add(e.target) : onScreen.delete(e.target);
});
for (const id of ["chart-rolling", "chart-rolling-hours"]) seen.observe($(id));
const chartSeen = () => onScreen.size > 0;

// Sweeps through every blur radius between the old strength and the current one (state.smoothify), rather than
// tweening each point straight from the old curve to the new, which would just crossfade them
export function sweepSmoothing(from) {
  const days = WINDOWS[$("window").value];
  const zoom = currentZoom($("chart-rolling"));
  const span = spanDays(zoom, rawMemo?.raw.dates ?? []);
  const [s0, s1] = [from, state.smoothify].map((k) => smoothSigma(days, k, span));
  const [c0, c1] = [from, state.smoothify].map((k) => smoothCurve(k, span));
  // (a blur radius under half a day counts as half a day: "off" to a little is a small change)
  const total = scaledMs(s0, s1, MORPH_MS, undefined, 0.5);
  return sweep((t, ms) => {
    if (t < 1 && !chartSeen()) return;
    const look = { sigma: s0 + (s1 - s0) * t, smooth: c0 + (c1 - c0) * t };
    renderRollingChart(currentZoom($("chart-rolling")), { ms, easing: "linear" }, look);
    if (t === 1) paintClock(); // the clock follows the new smoothing once, at the end
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
    const sigma = smoothSigma(state.shownWindow, "auto", span);
    const curve = smoothCurve("auto", span);
    if (Math.abs(sigma - state.shownSmooth.sigma) < 0.2 && Math.abs(curve - state.shownSmooth.curve) < 0.02) return;
    cancelSweep();
    renderRollingChart(zoom, { ms: GROW_MS, easing: EASE_OUT.echarts }, { sigma, smooth: curve });
    paintClock();
  }, 150);
});

// The slider's thumb (and its number) travelling from window `from` to `to` days over the sweep's time, on the
// same curve and log scale, for a change the page makes (a period button); a drag moves the thumb itself.
// The thumb needs a fractional value on the way, so its step is lifted while it glides.
let glideRaf = 0;
function endGlide(to = WINDOWS[$("window").value]) {
  cancelAnimationFrame(glideRaf);
  if (!$("window")._glide) return;
  for (const input of windowSliders) {
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
}
function glideWindow(from, to, ms) {
  if (!ms) return;
  // A window size's place on the slider: between two steps in proportion to the log of its size
  const place = (w) => {
    const i = Math.max(0, Math.min(WINDOWS.length - 2, WINDOWS.findLastIndex((x) => x <= w)));
    return i + Math.max(0, Math.min(1, Math.log(w / WINDOWS[i]) / Math.log(WINDOWS[i + 1] / WINDOWS[i])));
  };
  const labels = windowSliders.map((input) => {
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
    return label;
  });
  const t0 = performance.now();
  const tick = (now) => {
    const t = Math.max(0, Math.min(1, (now - t0) / ms));
    const e = t * t * (3 - 2 * t); // the sweep's own curve
    const w = from * (to / from) ** e;
    const at = place(w);
    windowSliders.forEach((input, i) => {
      input.value = at;
      input.style.setProperty("--p", at / (WINDOWS.length - 1));
      labels[i].style.setProperty("--p", at / (WINDOWS.length - 1));
      labels[i].textContent = Math.round(w);
    });
    if (t < 1) glideRaf = requestAnimationFrame(tick);
    else endGlide(to);
  };
  tick(t0);
}

// A new window size: sweep through the sizes in between, evenly spaced on a log scale like the slider's
// ticks. Every step uses the same points (the window fixed on `grid`), so ECharts can tween each point; the
// first step is drawn without animation to put the old window on those points. Edges the old window didn't
// reach appear at once there.
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
  const end = agg.rolling(state.plays, state.chartNames, to, $("include-other").checked);
  // A bigger window has fewer points (none until its first window fills, none after its last), so the range
  // shown shrinks to them and a smaller one's widens back to the period. The range travels there on the
  // sweep's clock, over the points of the smaller window (which reach both ranges): on the bigger one's, the
  // lines past its last point would vanish at the first step, and the range snap in. The bigger window's
  // points take over once the sweep lands, where what they leave out is off screen.
  const z0 = zoom();
  const z1 = clampZoom(periodZoom(), end.dates);
  const grid = Math.min(from, to);
  const moves = Number.isFinite(z0?.[0]) && (z0[0] !== z1[0] || z0[1] !== z1[1]);
  // While it moves, every step draws the same points, over both ranges, so none is filtered in or out
  const stretch = moves ? [Math.min(z0[0], z1[0]), Math.max(z0[1], z1[1])] : null;
  const at = (t) => (moves ? travel(z0, z1, t) : zoom());
  renderRollingChart(at(0), false, { window: from, grid, stretch });
  paintBrush(end, { delay: 0, ms: total });
  return sweep((t, ms) => {
    if (t < 1 && !chartSeen()) return;
    const window = t === 1 ? to : Math.round(from * (to / from) ** t);
    renderRollingChart(at(t), { ms, easing: "linear" }, { window, grid, stretch });
  }, total, sweepSteps(total)).then((done) => {
    if (!done || (grid === to && !stretch)) return done;
    // The last step's tween ends a frame or so after the sweep (ECharts draws on the next frame), so the
    // handover waits a step more. Anything drawn meanwhile has already left these points behind.
    const mark = renders;
    return new Promise((resolve) => setTimeout(() => {
      if (renders === mark) renderRollingChart(zoom(), false, { window: to, grid: to });
      resolve(true);
    }, total / sweepSteps(total)));
  });
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
    // A new artist count morphs too: artists grow in or shrink away (each step of a drag carries on from the last)
    pending = requestAnimationFrame(() => {
      if (id === "window") return sweepWindow(true, to);
      brushMorph = { ms: MORPH_MS }; // the bar's backdrop morphs with the chart
      renderRollingChart(currentZoom($("chart-rolling")), dur(MORPH_MS));
      brushMorph = null;
    });
  });
}

// The hours card's slider moves the chart's, which carries both
$("hours-window").addEventListener("input", () => {
  $("window").value = $("hours-window").value;
  $("window").dispatchEvent(new Event("input"));
});

// A click on one of the window's notches (or where its number shows) goes to that size, the way a click on the track would
for (const tick of windowSliders.flatMap((input) => [...input.closest(".slider").querySelectorAll(".ticks [data-v]")])) {
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
  // The chart morphs with the bar's backdrop: a pin's outline and shade fade in, an artist new to it grows in
  renderRollingChart(currentZoom($("chart-rolling")), dur(MORPH_MS));
  brushMorph = null;
}

// Unpinning is always a click on something of the artist's, so they go straight to being hovered
function unpin(name) {
  state.pinned = state.pinned.filter((a) => a !== name);
  brushMorph = { ms: MORPH_MS };
  // Hovering a pinned artist doesn't tell the page (they're lit already), so say so before the key's chips are
  // rebuilt unpinned: otherwise they'd show unhovered for a beat before the hover reaches them
  focusArtist($("chart-rolling"), name);
  holdFocus($("chart-rolling"), name);
  renderRollingChart(currentZoom($("chart-rolling")), dur(MORPH_MS));
  holdFocus($("chart-rolling"), null);
  brushMorph = null;
}

// Other modules read these live through their imports, but only this one can assign them
export const setBrushMorph = (m) => (brushMorph = m);
export const setBrushFocus = (name) => (brushFocus = name);
export const clearMixArgs = () => (mixArgs = null);

// The period: presets, steps, the length buttons and the year menu in the sticky bar, and the graphs
// following the bar's window live as it's dragged.
import * as agg from "./aggregate.js";
import { currentZoom, setZoom } from "./charts.js";
import { setupBrush, setBrushRange } from "./brush.js";
import { dur, CHASE_MS, MORPH_MS, PAN_MS, scaledMs, EASE_IN_OUT, EASE_OUT } from "./motion.js";
import { $, state, RESIZE_LOOK, extent, presetRange, presetOf, presetLabel, rangePlays, hooks } from "./state.js";
import { periodZoom, clampZoom, rollingSub, WINDOWS, rawMemo, renderRollingChart, paintBrush, mixArgs, renderMix, chartArtists, sweepSmoothing, sweepWindow, setBrushMorph } from "./rollingview.js";
import { paintArtistKey } from "./key.js";

const renderAll = (...a) => hooks.renderAll(...a); // main.js
const renderDependents = () => hooks.renderDependents(); // main.js

const fmtDay = (d, opts = { month: "short", day: "numeric", year: "numeric" }) => agg.dayToDate(d).toLocaleDateString(undefined, opts);
const spanOf = (r) => r.hi - r.lo + 1;

// The bar's text and buttons, and the brush's window, for the current range
export function syncPeriod(frame = true) {
  const label = $("year-label");
  // A length picked from the buttons (3m, 1y…) names the day it starts, rather than "Custom"
  const len = [...$("period-resize").children].some((b) => sameRange(state.range, resized(state.range, b.dataset.len)));
  const text = presetOf(state.range) === null && len ? fmtDay(state.range.lo) : presetLabel();
  if (label.textContent !== text) {
    // A date is wider than a year, so the button grows or shrinks to fit, pushing the controls to its left along
    const button = $("year-button"), was = button.getBoundingClientRect().width;
    label.textContent = text;
    label.classList.remove("swap");
    void label.offsetWidth; // restart the swap animation
    label.classList.add("swap");
    const now = button.getBoundingClientRect().width;
    if (was && Math.abs(now - was) > 0.5 && dur(MORPH_MS)) {
      button.animate({ width: [`${was}px`, `${now}px`] }, { duration: dur(MORPH_MS), easing: EASE_IN_OUT.css });
    }
  }
  const p = presetOf(state.range);
  const sel = $("year-filter");
  sel.selectedIndex = p === null ? -1 : [...sel.options].findIndex((o) => o.value === p);
  const e = extent();
  $("year-prev").disabled = p === null ? state.range.lo <= e.lo : sel.selectedIndex <= 0;
  $("year-next").disabled = p === null ? state.range.hi >= e.hi : sel.selectedIndex >= sel.options.length - 1;
  for (const b of $("period-resize").children) b.setAttribute("aria-pressed", sameRange(state.range, resized(state.range, b.dataset.len)));
  if (frame) setBrushRange(state.range);
}

const sameRange = (a, b) => a.lo === b.lo && a.hi === b.hi;

// The window `len` long ("30d", "3m" or "1y"), ending where it ends now: the right edge stays put and the
// left edge moves, so the buttons rescale the window back from the most recent day. Months and years are
// calendar ones. A history shorter than that gives what there is.
function resized(range, len) {
  const e = extent();
  const [, n, unit] = len.match(/(\d+)([dmy])/);
  if (unit === "d") return { lo: Math.max(e.lo, range.hi - n + 1), hi: range.hi };
  const months = unit === "y" ? n * 12 : +n;
  const after = agg.dayToDate(range.hi + 1); // the day after the window; the new window starts `months` before it
  const lo = agg.dayIndex(new Date(after.getFullYear(), after.getMonth() - months, after.getDate()).getTime());
  return { lo: Math.max(e.lo, lo), hi: range.hi };
}

let resizeRun = 0; // a newer click drops the period change a sweep was about to start
$("period-resize").addEventListener("click", (e) => {
  ++resizeRun;
  const b = e.target.closest("button");
  if (!b) return;
  const look = RESIZE_LOOK[state.dim][b.dataset.len];
  const range = resized(state.range, b.dataset.len);
  const windowWas = $("window").value;
  const sliceChanges = look && String(WINDOWS.indexOf(look.window)) !== windowWas;
  if (!sameRange(range, state.range)) {
    // The window frame and the chart travel to the new period together first, drawn at the old slice size,
    // and the new artists morph in. Then the slice size and smoothing change (see retune), when every artist
    // has data across the period (swept earlier, the old artists would leave the new period's left edge empty).
    const was = state.range;
    setRange(range);
    if (!sliceChanges && !retunes(look)) return;
    const trip = panMs(was) + dur(MORPH_MS); // (panMs reads the new range as the destination)
    const mine = resizeRun;
    return void setTimeout(() => mine === resizeRun && retune(look, windowWas), trip + 60);
  }
  // Already that long: there's no trip, so the slice size sweeps as if the slider moved (or the smoothing alone morphs)
  retune(look, windowWas);
});

const retunes = (look) => look?.smooth !== undefined && look.smooth !== state.smoothify;

// A period button's slice size and smoothing, as two sweeps one after the other, so each is a plain change
// of one thing: the slice size (slider and chart), then the smoothing (the select and the chart's blur)
function retune(look, windowWas) {
  if (!look) return;
  const setSlice = () => ($("window").value = WINDOWS.indexOf(look.window));
  const smoothly = retunes(look);
  const setSmooth = () => {
    const from = state.smoothify;
    state.smoothify = look.smooth;
    $("smoothify").value = String(look.smooth);
    return from;
  };
  const slice = String(WINDOWS.indexOf(look.window)) !== windowWas;
  const then = (p, next) => p.then((done) => done !== false && next());
  const sliceSweep = () => {
    setSlice();
    return slice ? sweepWindow(true) : Promise.resolve(true);
  };
  const smoothSweep = () => sweepSmoothing(setSmooth());
  if (!smoothly) {
    sliceSweep();
    if (!slice) renderRollingChart(currentZoom($("chart-rolling")), true);
  } else then(sliceSweep(), smoothSweep);
}

// A preset or a step: the chart and the window frame travel to the new period together (one clock: the frame
// is placed from the chart's own pan, frame by frame), then the artists change
function setRange(range, animate = true) {
  ++resizeRun; // drops a period change a button's sequence was about to make
  const was = state.range;
  state.range = range;
  const from = animate && was ? was : false;
  const travels = from && panMs(from) > 0;
  // (the frame is the pan's, unless there's no pan to follow)
  syncPeriod(!travels);
  settleRange(from);
}

// The graphs, lists and stats take on state.range: the chart pans from the range `from`, the frame with it, then
// the bands morph
function settleRange(from) {
  const pan = panMs(from);
  // Like the chart: the window slides across first, then the bands behind it morph to the new artists
  setBrushMorph(pan ? { delay: pan, ms: MORPH_MS } : null);
  renderAll(undefined, from);
  setBrushMorph(null);
}

export function setPeriod(value) {
  setRange(presetRange(value));
}

// With a length button picked (3m, 1y…) on a stretch that isn't a preset, a year keeps that length: the window
// moves to end where the year does (its last day, or the history's for the year in progress)
function pickPeriod(value) {
  const b = presetOf(state.range) === null && [...$("period-resize").children].find((c) => sameRange(state.range, resized(state.range, c.dataset.len)));
  if (b && value !== "all") return setRange(resized(presetRange(value), b.dataset.len));
  setPeriod(value);
}
$("year-filter").addEventListener("change", (e) => pickPeriod(e.target.value));
// Presets run All time, oldest year … newest year, so stepping walks through them in order. From a stretch
// the brush picked there's no next preset, so a step moves the window along by its own length instead.
function stepPeriod(dir) {
  const sel = $("year-filter");
  if (sel.selectedIndex >= 0) return setPeriod(sel.options[sel.selectedIndex + dir].value);
  const e = extent();
  // A length picked from the buttons stays that length: the window moves by its own months or days, and
  // resized() cuts it short against either end of the history exactly as the button would
  const b = [...$("period-resize").children].find((c) => sameRange(state.range, resized(state.range, c.dataset.len)));
  if (b) {
    const [, n, unit] = b.dataset.len.match(/(\d+)([dmy])/);
    let hi;
    if (unit === "d") hi = state.range.hi + dir * n;
    else {
      const after = agg.dayToDate(state.range.hi + 1), months = (unit === "y" ? 12 : 1) * n;
      hi = agg.dayIndex(new Date(after.getFullYear(), after.getMonth() + dir * months, after.getDate()).getTime()) - 1;
    }
    return setRange(resized({ lo: 0, hi: Math.min(e.hi, Math.max(hi, e.lo)) }, b.dataset.len));
  }
  const n = spanOf(state.range);
  const lo = Math.min(e.hi - n + 1, Math.max(e.lo, state.range.lo + dir * n));
  setRange({ lo, hi: lo + n - 1 });
}
$("year-prev").addEventListener("click", () => stepPeriod(-1));
$("year-next").addEventListener("click", () => stepPeriod(1));

// The brush: the graphs follow the window as it's dragged. The chart's range only slides when the artists
// stay the same (liveRender), so a drag is cheap and the rest settles as the artists change.
let livePending = 0;
let dragLen = undefined; // while the window is dragged: the length button it started on (null for none) if it moves whole
setupBrush((range) => {
  if (dragLen === undefined) {
    const old = state.range, b = [...$("period-resize").children].find((c) => sameRange(old, resized(old, c.dataset.len)));
    dragLen = b && spanOf(range) === spanOf(old) ? b.dataset.len : null;
  }
  // A window that started on 3m, 6m, 1y... stays that length (in calendar months) as it moves, as a step does
  if (dragLen) range = resized({ lo: 0, hi: range.hi }, dragLen);
  state.range = range;
  syncPeriod();
  cancelAnimationFrame(livePending);
  livePending = requestAnimationFrame(liveRender);
  return range;
}, (...a) => { dragLen = undefined; return paintBrush(...a); });

// The period menu: the hidden select's options, shown in a menu that lives in the sticky bar, so it
// moves with the bar on scroll (a native dropdown can end up off screen)
function openYearMenu() {
  const menu = $("year-menu");
  menu.replaceChildren(
    ...[...$("year-filter").options].map((o) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.tabIndex = -1;
      li.dataset.value = o.value;
      li.setAttribute("aria-selected", o.selected);
      li.textContent = o.text;
      li.addEventListener("click", () => chooseYear(o.value));
      return li;
    })
  );
  menu.hidden = false;
  $("year-button").setAttribute("aria-expanded", "true");
  const current = menu.querySelector('[aria-selected="true"]');
  current?.scrollIntoView({ block: "nearest" });
  current?.focus();
}

function closeYearMenu(refocus = false) {
  if ($("year-menu").hidden) return;
  $("year-menu").hidden = true;
  $("year-button").setAttribute("aria-expanded", "false");
  if (refocus) $("year-button").focus();
}

function chooseYear(value) {
  closeYearMenu(true);
  if (value !== presetOf(state.range)) pickPeriod(value);
}

$("year-button").addEventListener("click", () => ($("year-menu").hidden ? openYearMenu() : closeYearMenu()));
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".year-picker")) closeYearMenu();
});
$("year-menu").addEventListener("keydown", (e) => {
  const items = [...$("year-menu").children];
  const i = items.indexOf(document.activeElement);
  if (e.key === "Escape") closeYearMenu(true);
  else if (e.key === "Tab") closeYearMenu();
  else if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    if (i >= 0) chooseYear(items[i].dataset.value);
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    items[Math.min(items.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))].focus();
  } else if (e.key === "Home" || e.key === "End") {
    e.preventDefault();
    items[e.key === "Home" ? 0 : items.length - 1].focus();
  }
});

// A preset or step pans the chart sideways between periods of about the same length, and zooms when the length
// changes, taking longer the more doublings it is (3 months to 2 years is three; see scaledMs)

// `from` is the range being left, to animate from (false to just draw)
export function panMs(from) {
  return from ? scaledMs(spanOf(from), spanOf(state.range), PAN_MS) : dur(PAN_MS);
}

// The brush moved the window. Everything the range feeds is redrawn; the rolling chart only slides to the
// new range while its artists stay the same, and redraws (with the new artists) when they change.
// The chart's range slides every frame, which is cheap. The rest (new artists, lists, stats, the other
// charts) is a few frames of work, so it runs at most every LIVE_MS while the window moves, and once more
// when it stops. The chart and the rest go in separate frames, so neither waits on the other.
// How often depends on how slow this machine finds it: the work gets at most a third of the time.
const LIVE_MS = 90;
let liveAt = 0;
let liveCost = 0;
let liveTimer = 0;
let liveDeps = 0;
let liveTail = null; // the chart's own followers (the mix bar and the bar's backdrop), put off to the next frame
function liveRender() {
  if (!state.plays || !state.range) return;
  setZoom($("chart-rolling"), clampZoom(periodZoom(), rawMemo?.raw.dates));
  clearTimeout(liveTimer);
  const wait = liveAt + Math.max(LIVE_MS, liveCost * 3) - performance.now();
  if (wait <= 0) liveSettle();
  else liveTimer = setTimeout(liveSettle, wait);
}

function liveSettle() {
  liveAt = performance.now();
  liveSettleChart();
  const chartCost = performance.now() - liveAt;
  liveAt += chartCost;
  liveCost = chartCost;
  cancelAnimationFrame(liveDeps);
  liveDeps = requestAnimationFrame(() => {
    const t0 = performance.now();
    renderDependents();
    if (liveTail) liveTail();
    liveTail = null;
    const cost = performance.now() - t0;
    liveCost = chartCost + cost;
    liveAt = Math.max(liveAt, t0) + cost;
  });
}

function liveSettleChart() {
  const n = Number($("n-artists").value);
  const artists = chartArtists(rangePlays(), n);
  if (state.chartNames && artists.join("\u0000") === state.chartNames.join("\u0000") && mixArgs) {
    $("rolling-sub").textContent = rollingSub(n, WINDOWS[$("window").value], $("include-other").checked);
    renderMix(...mixArgs);
  } else {
    // New artists morph in while the range keeps sliding, the backdrop in the bar with them
    const ms = dur(CHASE_MS);
    renderRollingChart(periodZoom(), ms && { ms, live: true }, null, false);
    liveTail = () => {
      if (mixArgs) renderMix(...mixArgs);
      paintArtistKey();
      paintBrush(undefined, ms ? { ms, ease: EASE_OUT.js } : null);
    };
  }
}

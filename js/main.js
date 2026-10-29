import { parseFiles, filesFromDataTransfer } from "./parse.js";
import * as agg from "./aggregate.js";
import { renderRolling, renderMonthly, renderClock, disposeAll, currentZoom, setZoom, focusArtist, onFocusChange, onSelectionChange, onZoomChange } from "./charts.js";
import { setupBrush, setBrushData, setBrushRange, setBrushBands } from "./brush.js";
import { sweep, cancelSweep, dur, flip, MORPH_MS } from "./motion.js";
import { updateMix, setupMix, highlightMix } from "./mix.js";
import { renderList, renderTiles } from "./lists.js";
import { buildSummary, submissionKey } from "./summary.js";
import { renderCommunity } from "./community.js";
import * as api from "./api.js";
import { savePlays, loadPlays, clearPlays } from "./store.js";

const $ = (id) => document.getElementById(id);

// range: the period every graph shows, { lo, hi } as inclusive day indices (see agg.dayIndex). The brush picks
// it, and the presets in the dropdown are just ranges (a year, or all time).
// pinned: artists the reader added to the rolling chart through the search; artists: every artist, by hours;
// colorSlots: the palette slot (0-7) each artist last had in the rolling chart, so colors follow the artist
const state = {
  plays: null, range: null, view: "you", key: null, shared: null, rollingMode: "share", smoothify: "auto",
  pinned: [], hidden: [], artists: [], colorSlots: new Map(),
};

// ---------- Loading ----------

function setStatus(msg, isError = false) {
  $("status").textContent = msg;
  $("status").classList.toggle("error", isError);
}

async function load(files) {
  try {
    setStatus("Reading files…");
    const plays = await parseFiles(files, setStatus);
    await open(plays);
    savePlays(plays);
    if ($("share-optin").checked) share();
    else refreshShareState();
  } catch (err) {
    console.error(err);
    setStatus(err.message, true);
  }
}

async function open(plays) {
  state.plays = plays;
  state.artists = agg.topArtists(plays, Infinity);
  state.pinned = [];
  state.colorSlots = new Map();
  state.key = await submissionKey(plays);
  state.shared = null;
  setStatus("");
  showDashboard();
}

// Returning visitor: reopen the data remembered on this device
(async () => {
  const plays = await loadPlays();
  if (!plays || state.plays) return;
  await open(plays);
  refreshShareState();
})();

const dz = $("dropzone");
dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
dz.addEventListener("dragleave", () => dz.classList.remove("over"));
dz.addEventListener("drop", async (e) => {
  e.preventDefault();
  dz.classList.remove("over");
  load(await filesFromDataTransfer(e.dataTransfer));
});
// Dropping anywhere on the landing page shouldn't navigate the browser to the file
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());
$("file-input").addEventListener("change", (e) => load([...e.target.files]));

$("reset").addEventListener("click", () => {
  clearPlays();
  state.plays = state.key = state.shared = null;
  state.pinned = [];
  state.artists = [];
  state.colorSlots = new Map();
  $("file-input").value = "";
  showView("you");
});

// ---------- Views ----------

function showView(view) {
  state.view = view;
  $("tab-you").classList.toggle("active", view === "you");
  $("tab-community").classList.toggle("active", view === "community");
  $("landing").hidden = !(view === "you" && !state.plays);
  $("dashboard").hidden = !(view === "you" && state.plays);
  $("community").hidden = view !== "community";
  if (view === "community") renderCommunity(state.plays);
}

$("tab-you").addEventListener("click", () => showView("you"));
$("tab-community").addEventListener("click", () => showView("community"));

// ---------- Sharing ----------

function renderShareState(text) {
  $("share-state").textContent = text ?? (state.shared ? "Shared with the community ✓" : "Not shared with the community");
  // Sharing starts from the stats page; removing lives on the Community page
  $("share-toggle").hidden = state.shared !== false;
  $("community-leave").hidden = !state.shared;
  $("community-leave-state").textContent = text ?? "Your listening summary is in the community pool.";
}

async function refreshShareState() {
  try {
    state.shared = await api.isShared(state.key);
    renderShareState();
  } catch (err) {
    console.error(err);
    renderShareState("Community unavailable right now");
  }
}

async function share() {
  renderShareState("Sharing…");
  try {
    await api.submitSummary(state.key, buildSummary(state.plays));
    state.shared = true;
    renderShareState();
  } catch (err) {
    console.error(err);
    renderShareState(`Couldn't share: ${err.message}`);
  }
}

async function unshare() {
  if (!confirm("Remove your listening summary from the community pool?")) return;
  renderShareState("Removing…");
  try {
    await api.deleteSummary(state.key);
    state.shared = false;
    renderShareState();
    if (state.view === "community") renderCommunity(state.plays);
  } catch (err) {
    console.error(err);
    renderShareState(`Couldn't remove: ${err.message}`);
  }
}

$("share-toggle").addEventListener("click", share);
$("share-remove").addEventListener("click", unshare);
$("share-preview").addEventListener("click", () => {
  // One line per artist/track entry so it's easy to scan
  const entries = Object.entries(buildSummary(state.plays)).map(([k, v]) =>
    `  "${k}": ` +
    (Array.isArray(v) && Array.isArray(v[0]) ? `[\n${v.map((x) => "    " + JSON.stringify(x)).join(",\n")}\n  ]` : JSON.stringify(v))
  );
  $("preview-json").textContent = `{\n${entries.join(",\n")}\n}`;
  $("preview-dialog").showModal();
});
$("preview-close").addEventListener("click", () => $("preview-dialog").close());

// ---------- Dashboard ----------

// The days the history covers, as day indices
const extent = () => ({ lo: agg.dayIndex(state.plays[0].t), hi: agg.dayIndex(state.plays[state.plays.length - 1].t) });

// A preset's range: "all" is the whole history, a year is January 1 to December 31 (or as much of it as exists)
function presetRange(value) {
  const e = extent();
  if (value === "all") return e;
  const lo = agg.dayIndex(new Date(+value, 0, 1).getTime()), hi = agg.dayIndex(new Date(+value, 11, 31).getTime());
  return { lo: Math.max(lo, e.lo), hi: Math.min(hi, e.hi) };
}

// The preset the range is exactly, or null for a stretch the reader chose with the brush
function presetOf(range) {
  for (const o of $("year-filter").options) {
    const r = presetRange(o.value);
    if (r.lo === range.lo && r.hi === range.hi) return o.value;
  }
  return null;
}

const fmtDay = (d, opts = { month: "short", day: "numeric", year: "numeric" }) => agg.dayToDate(d).toLocaleDateString(undefined, opts);
const rangeText = () => `${fmtDay(state.range.lo)} – ${fmtDay(state.range.hi)}`;
const spanOf = (r) => r.hi - r.lo + 1;
// "All time", a year, or "Custom" for anything the brush picked
const presetLabel = () => {
  const p = presetOf(state.range);
  return p === null ? "Custom" : p === "all" ? "All time" : p;
};

function showDashboard() {
  showView("you");
  const sel = $("year-filter");
  sel.replaceChildren(new Option("All time", "all"), ...agg.years(state.plays).map((y) => new Option(y, y)));
  const e = extent();
  setBrushData(e.lo, e.hi);
  // Open on the most recent year; "All time" is one click (or ‹ steps) away
  state.range = null;
  setPeriod(sel.options[sel.options.length - 1].value);
}

// The bar's text and buttons, and the brush's window, for the current range
function syncPeriod() {
  // Everything in the bar that can be pushed sideways when the text changes width glides to its new spot
  const slid = () => new Map([
    ["next", $("year-next")],
    ["dates", $("period-range").querySelector(".dates")],
    ["days", $("period-range").querySelector(".days")],
  ].filter(([, el]) => el));
  const before = new Map([...slid()].map(([k, el]) => [k, el.getBoundingClientRect()]));
  const label = $("year-label");
  const text = presetLabel();
  if (label.textContent !== text) {
    label.textContent = text;
    label.classList.remove("swap");
    void label.offsetWidth; // restart the swap animation
    label.classList.add("swap");
  }
  const p = presetOf(state.range);
  const sel = $("year-filter");
  sel.selectedIndex = p === null ? -1 : [...sel.options].findIndex((o) => o.value === p);
  const e = extent();
  $("year-prev").disabled = p === null ? state.range.lo <= e.lo : sel.selectedIndex <= 0;
  $("year-next").disabled = p === null ? state.range.hi >= e.hi : sel.selectedIndex >= sel.options.length - 1;
  const n = spanOf(state.range);
  $("period-range").replaceChildren(
    Object.assign(document.createElement("span"), { className: "dates", textContent: rangeText() }),
    Object.assign(document.createElement("span"), { className: "days", textContent: `${n.toLocaleString()} ${n === 1 ? "day" : "days"}` })
  );
  if (before.size) flip(before, slid(), { ms: MORPH_MS * 0.7 });
  for (const b of $("period-resize").children) b.setAttribute("aria-pressed", sameRange(state.range, resized(state.range, +b.dataset.months)));
  setBrushRange(state.range);
}

const sameRange = (a, b) => a.lo === b.lo && a.hi === b.hi;

// The window `months` calendar months long, ending where it ends now: the right edge stays put and the
// left edge moves, so the buttons rescale the window back from the most recent day. A history shorter than
// that gives what there is.
function resized(range, months) {
  const e = extent();
  const after = agg.dayToDate(range.hi + 1); // the day after the window; the new window starts `months` before it
  const lo = agg.dayIndex(new Date(after.getFullYear(), after.getMonth() - months, after.getDate()).getTime());
  return { lo: Math.max(e.lo, lo), hi: range.hi };
}

$("period-resize").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) setRange(resized(state.range, +b.dataset.months));
});

// A preset or a step: the chart scrolls (or zooms) to the new period, then the artists change
function setRange(range, animate = true) {
  const was = state.range;
  state.range = range;
  // The brush window slides in step with the chart's pan
  const pan = panMs(animate && was ? was : false);
  $("brush-track").style.setProperty("--slide-ms", `${pan}ms`);
  syncPeriod();
  // Like the chart: the window slides across first, then the bands behind it morph to the new artists
  brushMorph = pan ? { delay: pan, ms: MORPH_MS } : null;
  renderAll(undefined, animate && was ? was : false);
  brushMorph = null;
}

function setPeriod(value) {
  setRange(presetRange(value));
}

$("year-filter").addEventListener("change", (e) => setPeriod(e.target.value));
// Presets run All time, oldest year … newest year, so stepping walks through them in order. From a stretch
// the brush picked there's no next preset, so a step moves the window along by its own length instead.
function stepPeriod(dir) {
  const sel = $("year-filter");
  if (sel.selectedIndex >= 0) return setPeriod(sel.options[sel.selectedIndex + dir].value);
  const e = extent(), n = spanOf(state.range);
  const lo = Math.min(e.hi - n + 1, Math.max(e.lo, state.range.lo + dir * n));
  setRange({ lo, hi: lo + n - 1 });
}
$("year-prev").addEventListener("click", () => stepPeriod(-1));
$("year-next").addEventListener("click", () => stepPeriod(1));

// The brush: the graphs follow the window as it's dragged. The chart's range only slides when the artists
// stay the same (liveRender), so a drag is cheap and the rest settles as the artists change.
let livePending = 0;
setupBrush((range) => {
  state.range = range;
  syncPeriod();
  cancelAnimationFrame(livePending);
  livePending = requestAnimationFrame(liveRender);
}, paintBrush);

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
  if (value !== presetOf(state.range)) setPeriod(value);
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

// Hairline under the period bar once it's pinned to the top
window.addEventListener("scroll", () => {
  const bar = document.querySelector(".filters.sticky");
  bar.classList.toggle("stuck", bar.getBoundingClientRect().top <= 0 && window.scrollY > 0);
}, { passive: true });

// A preset or step pans the chart sideways between periods of about the same length, and zooms (a longer
// trip) when the length changes a lot, as between all time and a year
const PAN_MS = 900;
const ZOOM_MS = 1400;

// `from` is the range being left, to animate from (false to just draw)
function panMs(from) {
  const ratio = from ? spanOf(from) / spanOf(state.range) : 1;
  return dur(ratio > 1.5 || ratio < 1 / 1.5 ? ZOOM_MS : PAN_MS);
}

function renderAll(keepZoom, from = false) {
  renderDependents();
  const ms = panMs(from);
  renderRollingChart(keepZoom ?? periodZoom(), from && ms > 0 && { ms, easing: "cubicInOut", pan: true });
}

// The brush moved the window. Everything the range feeds is redrawn; the rolling chart only slides to the
// new range while its artists stay the same, and redraws (with the new artists) when they change.
// The chart's range slides every frame, which is cheap. The rest (new artists, lists, stats, the other
// charts) is a few frames of work, so it runs at most every LIVE_MS while the window moves, and once more
// when it stops.
// How often depends on how slow this machine finds it: the work gets at most a third of the time.
const LIVE_MS = 90;
let liveAt = 0;
let liveCost = 0;
let liveTimer = 0;
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
  liveSettleWork();
  liveCost = performance.now() - liveAt;
  liveAt += liveCost;
}

function liveSettleWork() {
  renderDependents();
  const n = Number($("n-artists").value);
  const artists = chartArtists(rangePlays(), n);
  if (state.chartNames && artists.join("\u0000") === state.chartNames.join("\u0000") && mixArgs) {
    $("rolling-sub").textContent = rollingSub(n, WINDOWS[$("window").value], $("include-other").checked);
    renderMix(...mixArgs);
  } else renderRollingChart(periodZoom());
}

// The plays in the period
const rangePlays = () => agg.filterRange(state.plays, state.range.lo, state.range.hi);

// The period's plays without the artists deselected in the rolling chart's legend
function shownPlays() {
  const plays = rangePlays();
  if (!state.hidden.length) return plays;
  const hidden = new Set(state.hidden);
  return plays.filter((p) => !hidden.has(p.artist));
}

// Everything that follows the legend's selection: stats, top lists, monthly hours and the clock
// (the mix bar does too, in renderMix, since it's drawn from the chart's artists)
function renderDependents() {
  const plays = shownPlays();
  renderStats(plays);
  renderTopList($("top-artists"), agg.topArtists(plays, 10), (a) => `${a.plays.toLocaleString()} plays`, (a) => a.name, true);
  renderTopList($("top-tracks"), agg.topTracks(plays, 10), (t) => t.artist, (t) => t.artist);
  renderMonthly($("chart-monthly"), agg.monthly(plays));
  renderClock($("chart-clock"), agg.clock(plays));
  paintTopLists();
}

// Deselecting artists in the legend removes them from the other graphs too
onSelectionChange($("chart-rolling"), (hidden) => {
  if (hidden.join("\u0000") === state.hidden.join("\u0000")) return;
  state.hidden = hidden;
  if (!state.plays) return;
  renderDependents();
  if (mixArgs) renderMix(...mixArgs);
  paintBrush();
});

function renderStats(plays) {
  if (!plays.length) {
    renderTiles($("stats"), [
      { label: "Hours listened", value: "0", sub: "no artists shown", hero: true },
      { label: "Plays", value: "0", sub: "" },
      { label: "Artists", value: "0", sub: "unique" },
      { label: "Tracks", value: "0", sub: "unique" },
    ]);
    return;
  }
  const s = agg.summary(plays);
  const fmtDate = (d) => d.toLocaleDateString(undefined, { year: "numeric", month: "short" });
  renderTiles($("stats"), [
    { label: "Hours listened", value: Math.round(s.hours).toLocaleString(), sub: `${fmtDate(s.first)} – ${fmtDate(s.last)}`, hero: true },
    { label: "Plays", value: s.plays.toLocaleString(), sub: `${s.activeDays.toLocaleString()} days with music` },
    { label: "Artists", value: s.artists.toLocaleString(), sub: "unique" },
    { label: "Tracks", value: s.tracks.toLocaleString(), sub: "unique" },
  ]);
}

// artistOf: which artist a row belongs to, highlighted in the rolling chart while the row is hovered.
// pinnable: clicking a row pins or unpins that artist. paintTopLists colors the rows afterwards.
function renderTopList(ol, items, detail, artistOf, pinnable = false) {
  const max = items[0]?.hours || 1;
  renderList(
    ol,
    items.map((item) => ({
      name: item.name,
      key: `${item.name}\u0000${artistOf(item)}`, // the same row in another period glides instead of being redrawn
      detail: detail(item),
      value: `${Math.round(item.hours).toLocaleString()} h`,
      frac: item.hours / max,
    }))
  );
  ol.classList.toggle("pinnable", pinnable);
  ol._artists = items.map(artistOf);
  [...ol.children].forEach((li, i) => {
    li.addEventListener("pointerenter", () => focusArtist($("chart-rolling"), artistOf(items[i])));
    li.addEventListener("pointerleave", () => focusArtist($("chart-rolling"), null));
    if (pinnable) {
      li.tabIndex = 0;
      li.setAttribute("role", "button");
      li.addEventListener("click", () => togglePin(artistOf(items[i])));
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); togglePin(artistOf(items[i])); }
      });
      const mark = document.createElement("span");
      mark.className = "pin-mark";
      mark.innerHTML = PIN_SVG; // constant markup, no user data
      li.append(mark);
    }
  });
}

const PIN_SVG = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M9.5 1.5 14.5 6.5 12.6 7.4 10.7 10.2 11 12 9.9 13.1 7.5 10.7 3.4 14.8 2.5 13.9 6.6 9.8 4.2 7.4 5.3 6.3 7.1 6.6 9.9 4.7 10.8 2.8Z"/></svg>';

function togglePin(name) {
  if (state.pinned.includes(name)) unpin(name);
  else pin(name);
}

// Rows take their artist's color in the rolling chart (the bars match the stack above); artists outside
// the chart stay gray. Pinned artists' rows are highlighted, tracks included.
function paintTopLists() {
  for (const id of ["top-artists", "top-tracks"]) {
    const ol = $(id);
    [...ol.children].forEach((li, i) => {
      const name = ol._artists?.[i];
      const slot = state.chartNames?.includes(name) ? state.colorSlots.get(name) : undefined;
      if (slot === undefined) li.style.removeProperty("--c");
      else li.style.setProperty("--c", `var(--series-${slot + 1})`);
      const pinned = state.pinned.includes(name);
      li.classList.toggle("pinned", pinned);
      if (ol.classList.contains("pinnable")) {
        li.setAttribute("aria-pressed", pinned);
        li.title = pinned ? "Click to unpin" : "Click to pin to the chart";
      }
    });
  }
}

// ---------- Rolling chart (the original rolling_window.py) ----------

// The period as the chart's zoom range, start of the first day to end of the last
function periodZoom() {
  return [agg.dayToDate(state.range.lo).getTime(), agg.dayToDate(state.range.hi + 1).getTime() - 1];
}

// The rolling chart has no points before its first window is full or after its last, so a range reaching
// past them (all time, or a period at either end of the history) is trimmed to the points that exist
function clampZoom(zoom, dates) {
  if (!dates?.length) return zoom;
  return [Math.max(zoom[0], dates[0]), Math.min(zoom[1], dates[dates.length - 1])];
}

function rollingSub(n, target, includeOther) {
  return (state.rollingMode === "share"
    ? `Share of listening time, ${target}-day rolling window` +
      (includeOther ? "" : state.pinned.length ? ", among the artists shown" : `, among your top ${n} artists`)
    : `Hours per week, ${target}-day rolling average`) +
    (presetOf(state.range) === "all" ? "" : `, top artists of ${presetLabel() === "Custom" ? "the selected period" : presetLabel()}`);
}

// Fills a slider's track up to the thumb, places its notches, and marks the notch it sits on
function paintSlider(input) {
  const at = (v) => (v - input.min) / (input.max - input.min);
  input.style.setProperty("--p", at(input.value));
  for (const tick of input.closest(".slider").querySelectorAll(".ticks [data-v]")) {
    tick.style.setProperty("--p", at(tick.dataset.v));
    tick.classList.toggle("on", tick.dataset.v === input.value);
  }
}

// Smoothing windows in days; the slider steps through these, evenly spaced
const WINDOWS = [7, 15, 30, 45, 90, 180];

// The rolling data last computed, so a sweep through blur radii doesn't redo it for every step
let rawMemo = null;
const SMOOTH_CURVE = [0, 0.5, 0.6, 0.75, 0.85]; // curve rounding per smoothify strength
// "auto" scales both the blur and the curve rounding with how much time is on screen (see agg.autoAmount)
// Auto's curve rounding: scaled with the amount up to high, then on toward max
const autoCurve = (a) => (a <= 1 ? a * SMOOTH_CURVE[3] : SMOOTH_CURVE[3] + (a - 1) * (SMOOTH_CURVE[4] - SMOOTH_CURVE[3]));
const smoothCurve = (strength, span) => (strength === "auto" ? autoCurve(agg.autoAmount(span)) : SMOOTH_CURVE[strength]);
// Days on screen: the zoom range, or the whole timeline when there isn't one (all time)
const spanDays = (zoom, dates) =>
  (Number.isFinite(zoom?.[0]) ? zoom[1] - zoom[0] : dates[dates.length - 1] - dates[0]) / 86400000 || 0;

// look: optional overrides for the steps of a sweep. { window, grid } draws the chart of another window
// size on the points of window `grid`; { sigma, smooth } sets the blur radius and curve rounding.
function renderRollingChart(zoom, morph = false, look = null) {
  if (!look) cancelSweep(); // any other render ends a sweep in progress
  const n = Number($("n-artists").value);
  const target = WINDOWS[$("window").value];
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
  const key = [state.plays.length, window, grid, includeOther, ...artists].join("\u0000");
  if (rawMemo?.key !== key) rawMemo = { key, raw: agg.rolling(state.plays, artists, window, includeOther, grid) };
  const raw = rawMemo.raw;
  if (Number.isFinite(zoom?.[0])) zoom = clampZoom(zoom, raw.dates);
  const span = spanDays(zoom, raw.dates);
  const sigma = look?.sigma ?? agg.smoothifySigma(window, strength, span);
  const curve = look?.smooth ?? smoothCurve(strength, span);
  state.shownSmooth = { sigma, curve }; // what the zoom hook compares against
  // Auto says which strength it has landed on
  const amount = agg.autoAmount(span);
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
  };
  mixArgs = [artists, slots, includeOther, pins]; // fresh before renderRolling, which can report a new selection
  renderRolling($("chart-rolling"), data, names, window, zoom, state.rollingMode, includeOther, morph, pins, slots, curve);
  if (!look) {
    // the steps of a sweep change neither the artists nor their colors
    paintTopLists();
    renderMix(artists, slots, includeOther, pins);
    paintBrush();
  }
}

// The brush's backdrop: the rolling chart's own data over the whole history, in miniature (see
// brush.setBrushBands). Same artists, colors and stacking, with deselected artists left out, and lit
// (pinned, or hovered anywhere) artists strong while the rest dim, as in the chart.
let brushFocus = null; // the artist lit by hover, in the chart, a legend or a list
let brushMemo = null;
let brushMorph = null; // set while a preset or step renders: the new bands wait for the window, then morph in
function paintBrush() {
  const raw = rawMemo?.raw;
  if (!raw || !state.chartNames || !raw.dates.length) return;
  if (brushMemo?.raw !== raw) brushMemo = { raw, data: agg.blur(raw, 12) };
  const { dates, share } = brushMemo.data;
  const names = $("include-other").checked ? [...state.chartNames, "Everyone else"] : state.chartNames;
  const rows = names.map((_, i) => i).filter((i) => !state.hidden.includes(names[i]));
  const lit = new Set([...state.pinned, brushFocus].filter((a) => a != null && rows.some((i) => names[i] === a)));
  const total = dates.map((_, k) => rows.reduce((t, i) => t + (share[i][k] ?? 0), 0));
  let acc = new Float64Array(dates.length);
  const bands = rows.map((i) => {
    const lo = Array.from(acc);
    acc = acc.map((a, k) => a + (share[i][k] ?? 0));
    const frac = (v, k) => (share[i][k] == null || total[k] <= 0 ? null : v / total[k]);
    const hi = Array.from(acc, frac);
    return {
      lo: lo.map(frac),
      hi,
      color: names[i] === "Everyone else" ? "var(--other)" : `var(--series-${state.colorSlots.get(names[i]) + 1})`,
      look: lit.has(names[i]) ? "lit" : lit.size ? "dim" : "rest",
    };
  });
  const days = dates.map(agg.dayIndex);
  // The timeline begins where the drawn artists' listening does, not where the chart's data does (that's the
  // same for every artist set, so charts can morph), so a smaller window can cut off more
  const lead = Math.max(0, agg.leadIn(dates.map((_, k) => names.reduce((t, _n, i) => t + (raw.hours[i][k] ?? 0), 0))));
  setBrushBands({ start: Math.max(extent().lo, days[lead]), days, bands }, brushMorph);
}

// The listening mix bar: the same artists, colors and per-day hours as the chart above, over the period
let mixMemo = null;
let mixArgs = null; // the last renderMix arguments, to redraw the bar when only the legend's selection changed
function renderMix(artists, slots, includeOther, pins) {
  mixArgs = [artists, slots, includeOther, pins];
  const key = [state.plays.length, includeOther, ...artists].join("\u0000");
  if (mixMemo?.key !== key) mixMemo = { key, table: agg.dailyTable(state.plays, artists, includeOther) };
  // Deselected artists drop out of the bar, and the rest fill it
  const all = includeOther ? [...artists, "Everyone else"] : artists;
  const rows = all.map((_, i) => i).filter((i) => !state.hidden.includes(all[i]));
  updateMix({
    table: { ...mixMemo.table, prefix: rows.map((i) => mixMemo.table.prefix[i]) },
    names: rows.map((i) => all[i]),
    slots: slots && rows.map((i) => slots[i]),
    pins,
    hasOther: includeOther,
    periodLabel: presetLabel(),
    lo: state.range.lo,
    hi: state.range.hi,
  });
}
setupMix((name) => focusArtist($("chart-rolling"), name));
onFocusChange($("chart-rolling"), (name) => {
  highlightMix(name);
  brushFocus = name;
  paintBrush();
});

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
function chartArtists(plays, n) {
  const top = agg.topArtists(plays, n).map((a) => a.name);
  const extra = state.pinned.filter((a) => !top.includes(a));
  const keep = Math.max(n, state.pinned.length) - extra.length;
  for (let i = top.length - 1; top.length > keep && i >= 0; i--) {
    if (!state.pinned.includes(top[i])) top.splice(i, 1);
  }
  return [...top, ...extra];
}

for (const btn of document.querySelectorAll("#rolling-mode button")) {
  btn.addEventListener("click", () => {
    state.rollingMode = btn.dataset.mode;
    for (const b of document.querySelectorAll("#rolling-mode button")) b.setAttribute("aria-pressed", b === btn);
    renderRollingChart(currentZoom($("chart-rolling")), true);
  });
}

$("smoothify").addEventListener("change", (e) => {
  const from = state.smoothify;
  state.smoothify = e.target.value === "auto" ? "auto" : Number(e.target.value);
  if (state.smoothify === from) return;
  // Sweep through every blur radius in between, rather than tweening each point straight from the old
  // curve to the new, which would just crossfade them
  const days = WINDOWS[$("window").value];
  const zoom = currentZoom($("chart-rolling"));
  const span = spanDays(zoom, rawMemo?.raw.dates ?? []);
  const [s0, s1] = [from, state.smoothify].map((k) => agg.smoothifySigma(days, k, span));
  const [c0, c1] = [from, state.smoothify].map((k) => smoothCurve(k, span));
  sweep((t, ms) => {
    const look = { sigma: s0 + (s1 - s0) * t, smooth: c0 + (c1 - c0) * t };
    renderRollingChart(currentZoom($("chart-rolling")), { ms, easing: "linear" }, look);
  });
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
    const sigma = agg.smoothifySigma(state.shownWindow, "auto", span);
    const curve = smoothCurve("auto", span);
    if (Math.abs(sigma - state.shownSmooth.sigma) < 0.2 && Math.abs(curve - state.shownSmooth.curve) < 0.02) return;
    cancelSweep();
    renderRollingChart(zoom, { ms: 250, easing: "linear" }, { sigma, smooth: curve });
  }, 150);
});

// The "Everyone else" toggle stands in for its legend entry, so hovering it highlights the band
const otherToggle = $("include-other").closest("label");
otherToggle.addEventListener("pointerenter", () => {
  if ($("include-other").checked) focusArtist($("chart-rolling"), "Everyone else");
});
otherToggle.addEventListener("pointerleave", () => focusArtist($("chart-rolling"), null));

// A new window size: sweep through the sizes in between, evenly spaced on a log scale like the slider's
// ticks. Every step uses the points of the final chart (the window fixed on `grid`), so ECharts can tween
// each point; the first step is drawn without animation to put the old window on those points. Edges
// the old window didn't reach appear at once there.
function sweepWindow() {
  const zoom = () => currentZoom($("chart-rolling"));
  const from = state.shownWindow, to = WINDOWS[$("window").value];
  if (!from || from === to) return renderRollingChart(zoom());
  cancelSweep();
  renderRollingChart(zoom(), false, { window: from, grid: to });
  sweep((t, ms) => {
    const window = t === 1 ? to : Math.round(from * (to / from) ** t);
    renderRollingChart(zoom(), { ms, easing: "linear" }, { window, grid: to });
  });
}

let pending = 0;
for (const id of ["n-artists", "window", "include-other"]) {
  $(id).addEventListener("input", () => {
    cancelAnimationFrame(pending);
    // The artist-count slider re-renders continuously as it drags, so it doesn't animate
    pending = requestAnimationFrame(() =>
      id === "window" ? sweepWindow() : renderRollingChart(currentZoom($("chart-rolling")), id === "include-other"));
  });
}

// ---------- Artist search: pin any artist into the rolling chart ----------

const MAX_PINS = 10; // one per series color
// Case- and accent-insensitive, so "beyonce" finds Beyoncé
const fold = (s) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const fmtArtistHours = (h) => (h < 1 ? "<1 h" : `${Math.round(h).toLocaleString()} h`);
let results = [];
let active = -1;

function pin(name) {
  if (state.pinned.includes(name) || state.pinned.length >= MAX_PINS) return;
  state.pinned = [...state.pinned, name];
  renderRollingChart(currentZoom($("chart-rolling")));
}

function unpin(name) {
  state.pinned = state.pinned.filter((a) => a !== name);
  renderRollingChart(currentZoom($("chart-rolling")));
}

// Up to 8 matches: names starting with the query, then a word starting with it, then anywhere.
// state.artists is sorted by hours and the sort is stable, so ties stay biggest first.
function searchArtists(query) {
  const q = fold(query.trim());
  if (!q) return [];
  const found = [];
  for (const a of state.artists) {
    const at = fold(a.name).indexOf(q);
    if (at < 0) continue;
    const rank = at === 0 ? 0 : /[\s\-&(./,]/.test(a.name[at - 1]) ? 1 : 2;
    found.push({ ...a, at, len: q.length, rank });
  }
  return found.sort((a, b) => a.rank - b.rank).slice(0, 8);
}

function setActive(i) {
  active = i;
  const opts = [...$("artist-results").querySelectorAll('[role="option"]')];
  opts.forEach((li, k) => li.setAttribute("aria-selected", k === i));
  if (opts[i]) {
    $("artist-search").setAttribute("aria-activedescendant", opts[i].id);
    opts[i].scrollIntoView({ block: "nearest" });
  } else $("artist-search").removeAttribute("aria-activedescendant");
  // Preview the artist in the chart if they're already in it
  focusArtist($("chart-rolling"), results[i]?.name ?? null);
}

function showResults() {
  const input = $("artist-search");
  const list = $("artist-results");
  results = searchArtists(input.value);
  if (!input.value.trim()) return closeResults();

  const full = state.pinned.length >= MAX_PINS;
  const note = (text) => {
    const li = document.createElement("li");
    li.className = "note";
    li.textContent = text;
    return li;
  };
  const items = results.map((a, i) => {
    const pinned = state.pinned.includes(a.name);
    const li = document.createElement("li");
    li.id = `artist-opt-${i}`;
    li.setAttribute("role", "option");
    if (full && !pinned) li.setAttribute("aria-disabled", "true");
    const name = document.createElement("span");
    name.className = "name";
    // Bold the match. Folding can change a name's length (rarely), and then the indexes don't line up
    if (fold(a.name).length === a.name.length) {
      const mark = document.createElement("mark");
      mark.textContent = a.name.slice(a.at, a.at + a.len);
      name.append(a.name.slice(0, a.at), mark, a.name.slice(a.at + a.len));
    } else name.textContent = a.name;
    const detail = document.createElement("span");
    detail.className = "detail";
    detail.textContent = pinned ? "Pinned" : state.chartNames?.includes(a.name) ? "In chart" : fmtArtistHours(a.hours);
    li.append(name, detail);
    // pointerdown would blur the input and close the list before the click lands
    li.addEventListener("pointerdown", (e) => e.preventDefault());
    li.addEventListener("pointerenter", () => setActive(i));
    li.addEventListener("click", () => choose(i));
    return li;
  });
  list.replaceChildren(
    ...(full ? [note(`${MAX_PINS} artists pinned. Unpin one to add another.`)] : []),
    ...(items.length ? items : [note("No artists match")])
  );
  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
  setActive(results.length ? 0 : -1);
}

function closeResults() {
  if ($("artist-results").hidden) return;
  $("artist-results").hidden = true;
  $("artist-search").setAttribute("aria-expanded", "false");
  $("artist-search").removeAttribute("aria-activedescendant");
  focusArtist($("chart-rolling"), null);
  results = [];
  active = -1;
}

function choose(i) {
  const a = results[i];
  if (!a || (state.pinned.length >= MAX_PINS && !state.pinned.includes(a.name))) return;
  $("artist-search").value = "";
  closeResults();
  pin(a.name);
}

$("artist-search").addEventListener("input", showResults);
$("artist-search").addEventListener("focus", showResults);
$("artist-search").addEventListener("blur", closeResults);
$("artist-search").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!results.length) return;
    setActive((active + (e.key === "ArrowDown" ? 1 : results.length - 1)) % results.length);
  } else if (e.key === "Enter") {
    e.preventDefault();
    choose(active);
  } else if (e.key === "Escape") {
    e.preventDefault();
    if ($("artist-results").hidden) $("artist-search").value = "";
    closeResults();
  }
});

// ---------- Theme ----------

// Series palettes, chosen from the dot beside the legend. "Default" is the stylesheet's own --series-N
// colors; the others override them on <body>, so the root keeps the stylesheet values to preview from.
// The checked ones pass the data-viz palette validator's hard gates in both modes, ordered for
// adjacent stacked bands.
const PALETTES = {
  current: { label: "Default" },
  earth: {
    label: "Earth",
    light: ["#386ca5", "#b5543a", "#04988e", "#d4932b", "#7d5a9e", "#6f8f3a", "#c06c84", "#96691b", "#5b7a8c", "#c9a27a"],
    dark: ["#4074ae", "#b5543a", "#04988e", "#c58513", "#825fa4", "#6f8f3a", "#c06c84", "#96691b", "#5f8197", "#bf9568"],
  },
  jewel: {
    label: "Jewel",
    light: ["#2b5ea7", "#d96a4f", "#0495a8", "#b83a55", "#d18f1d", "#1d8a63", "#7650ad", "#6d8c25", "#5a6f7e", "#a0763a"],
    dark: ["#3e71bc", "#d96a4f", "#0495a8", "#bc3e58", "#c68401", "#1d8a63", "#805ab8", "#6d8c25", "#6a8191", "#a8803f"],
  },
  ember: {
    label: "Ink & ember",
    light: ["#32548f", "#c9a227", "#2d7fae", "#d9733f", "#23a7aa", "#a84a5a", "#73a665", "#6c599c", "#7a8f9f", "#b8714f"],
    dark: ["#4d71af", "#b48f0a", "#2d7fae", "#d9733f", "#23a7aa", "#ad4f5e", "#71a463", "#7764a8", "#8aa0b0", "#c07c5a"],
  },
  soft: {
    label: "Soft",
    light: ["#4379b2", "#59a14f", "#b774a5", "#f28e2b", "#46beb7", "#e15759", "#d1ae21", "#f2919b", "#9c755f", "#bab0ac"],
    dark: ["#4379b2", "#59a14f", "#b774a5", "#d77806", "#28a8a2", "#e15759", "#b09100", "#d1747e", "#9c755f", "#8f8682"],
  },
  // Not validated: some fail the colorblind or contrast checks. One list serves both modes.
  morandi: { label: "Morandi", unchecked: true, colors: ["#8e9aaf", "#c59d8f", "#9bb0a5", "#d4b483", "#a9889e", "#7d9a8c", "#c9a9a6", "#a3a07e", "#b7a5c9", "#8d8d86"] },
  pastel: { label: "Pastel", unchecked: true, colors: ["#a7c7e7", "#f8b4a6", "#b5e0c9", "#f6d58e", "#d4b5e8", "#f4b6cf", "#a8dadc", "#e2c6a1", "#cfe3a0", "#c7c3e8"] },
  nord: { label: "Nord", unchecked: true, colors: ["#5e81ac", "#d08770", "#a3be8c", "#b48ead", "#ebcb8b", "#88c0d0", "#bf616a", "#8fbcbb", "#81a1c1", "#a6a38e"] },
  solarized: { label: "Solarized", unchecked: true, colors: ["#268bd2", "#cb4b16", "#2aa198", "#d33682", "#b58900", "#6c71c4", "#859900", "#dc322f", "#657b83", "#93a1a1"] },
  seventies: { label: "70s", unchecked: true, colors: ["#3a6b7e", "#d9822b", "#7a8b3a", "#c4492d", "#e3b23c", "#6b4e3d", "#a65e46", "#9a9a5b", "#b5651d", "#5f7a61"] },
  bauhaus: { label: "Bauhaus", unchecked: true, colors: ["#1f4e9c", "#d62828", "#f2b705", "#222222", "#4f8a8b", "#e76f51", "#7d7d7d", "#8a5a9f", "#f28c28", "#2e8b57"] },
  synthwave: { label: "Synthwave", unchecked: true, colors: ["#ff2a6d", "#05d9e8", "#d300c5", "#f9c80e", "#7a04eb", "#00ff9f", "#ff6c11", "#2de2e6", "#ff9de1", "#3a86ff"] },
  riso: { label: "Riso print", unchecked: true, colors: ["#0078bf", "#ff48b0", "#ffe800", "#00a95c", "#ff6c2f", "#765ba7", "#f15060", "#3d5588", "#00838a", "#ff9a9a"] },
  sunset: { label: "Sunset", unchecked: true, colors: ["#2a1250", "#3d1e6d", "#6a2c70", "#9b3675", "#c94b6d", "#e86a5b", "#f28f4b", "#f6b545", "#f9d65c", "#fce38a"] },
  ocean: { label: "Ocean", unchecked: true, colors: ["#06182e", "#0b2545", "#13315c", "#1d4e89", "#2a6f97", "#2c8c99", "#42a6a0", "#7bc6b5", "#b8e0d2", "#d9efe6"] },
  viridis: { label: "Viridis", unchecked: true, colors: ["#440154", "#482878", "#3e4989", "#31688e", "#26828e", "#1f9e89", "#35b779", "#6ece58", "#b5de2b", "#fde725"] },
  greens: { label: "Spotify greens", unchecked: true, colors: ["#1db954", "#168d40", "#57d27f", "#0f5e2c", "#8fe3a8", "#2f7d4f", "#b9f0c9", "#4a9e6b", "#6fdc94", "#0a3d1d"] },
  accent: { label: "Gray + accent", unchecked: true, colors: ["#e4572e", "#9aa0a6", "#b8bcc1", "#7d838a", "#cfd2d6", "#6b7178", "#a9aeb3", "#888e95", "#c1c5ca", "#767c83"] },
  mono: { label: "Monochrome blue", unchecked: true, colors: ["#0b3d91", "#1f5fbf", "#3a7fd9", "#5d9be6", "#86b6ef", "#a9cbf4", "#2c4f7c", "#6f8fb5", "#14284b", "#c9def7"] },
};

const isDark = () => {
  const root = document.documentElement;
  return root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
};

// The 10 colors a palette shows in the current theme in the current theme
function paletteColors(key) {
  const p = PALETTES[key];
  if (p.colors) return p.colors;
  if (p.light) return p[isDark() ? "dark" : "light"];
  const css = getComputedStyle(document.documentElement);
  return Array.from({ length: 10 }, (_, i) => css.getPropertyValue(`--series-${i + 1}`).trim());
}

// The choice is a per-device convenience; storage can be unavailable, so it's best effort
let paletteKey = "current";
try { paletteKey = localStorage.getItem("palette") ?? "current"; } catch {}
if (!PALETTES[paletteKey]) paletteKey = "current";

function applyPalette() {
  const style = document.body.style;
  const colors = paletteKey === "current" ? null : paletteColors(paletteKey);
  for (let i = 0; i < 10; i++) {
    if (colors) style.setProperty(`--series-${i + 1}`, colors[i]);
    else style.removeProperty(`--series-${i + 1}`);
  }
  // The picker is a pill of the chart's colors, blended left to right and back round to the first, so
  // its hover drift loops seamlessly (style.css). An image, not the background shorthand, which would
  // reset the stylesheet's size and repeat.
  const c = paletteColors(paletteKey);
  $("palette-button").style.backgroundImage = `linear-gradient(to right, ${[...c, c[0]].join(", ")})`;
}

function choosePalette(key) {
  paletteKey = key;
  try { localStorage.setItem("palette", key); } catch {}
  closePaletteMenu(true);
  rerenderForTheme();
}

function openPaletteMenu() {
  const menu = $("palette-menu");
  const option = (key) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "palette-option";
    b.setAttribute("role", "menuitemradio");
    b.setAttribute("aria-checked", key === paletteKey);
    const check = document.createElement("span");
    check.className = "check";
    check.textContent = key === paletteKey ? "✓" : "";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = PALETTES[key].label;
    const strip = document.createElement("span");
    strip.className = "strip";
    for (const col of paletteColors(key)) {
      const sw = document.createElement("span");
      sw.style.background = col;
      strip.append(sw);
    }
    b.append(check, name, strip);
    b.addEventListener("click", () => choosePalette(key));
    return b;
  };
  const group = (text) => {
    const g = document.createElement("div");
    g.className = "group";
    g.textContent = text;
    return g;
  };
  const keys = Object.keys(PALETTES);
  menu.replaceChildren(
    ...keys.filter((k) => !PALETTES[k].unchecked).map(option),
    group("Not colorblind-checked"),
    ...keys.filter((k) => PALETTES[k].unchecked).map(option)
  );
  menu.hidden = false;
  $("palette-button").setAttribute("aria-expanded", "true");
  menu.querySelector('[aria-checked="true"]')?.focus();
}

function closePaletteMenu(refocus = false) {
  if ($("palette-menu").hidden) return;
  $("palette-menu").hidden = true;
  $("palette-button").setAttribute("aria-expanded", "false");
  if (refocus) $("palette-button").focus();
}

$("palette-button").addEventListener("click", () => ($("palette-menu").hidden ? openPaletteMenu() : closePaletteMenu()));
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".palette-picker")) closePaletteMenu();
});
$("palette-menu").addEventListener("keydown", (e) => {
  const items = [...$("palette-menu").querySelectorAll(".palette-option")];
  const i = items.indexOf(document.activeElement);
  if (e.key === "Escape") closePaletteMenu(true);
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
  }
});
applyPalette();

$("theme-toggle").addEventListener("click", () => {
  document.documentElement.dataset.theme = isDark() ? "light" : "dark";
  rerenderForTheme();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", rerenderForTheme);

function rerenderForTheme() {
  applyPalette();
  const zoom = state.plays ? currentZoom($("chart-rolling")) : undefined;
  disposeAll();
  if (state.plays) renderAll(zoom);
  if (state.view === "community") renderCommunity(state.plays);
}

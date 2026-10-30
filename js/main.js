import { parseFiles, filesFromDataTransfer } from "./parse.js";
import * as agg from "./aggregate.js";
import { currentZoom, setZoom, focusArtist, focusMonthly, focusClock, onFocusChange, onSelectionChange, hiddenIn, setHidden } from "./charts.js";
import { setupBrush, setBrushData, setBrushRange, brushRange, glideBrushRange } from "./brush.js";
import { dur, FADE_MS, CHASE_MS, MORPH_MS, PAN_MS, scaledMs, EASE_IN_OUT, EASE_OUT } from "./motion.js";
import { setupMix, highlightMix } from "./mix.js";
import { buildSummary, submissionKey } from "./summary.js";
import { renderCommunity } from "./community.js";
import * as api from "./api.js";
import { savePlays, loadPlays, clearPlays } from "./store.js";
import { forgetCovers } from "./covers.js";
import { $, state, noun, START_WINDOW, RESIZES, RESIZE_LOOK, extent, presetRange, presetOf, presetLabel, rangePlays, shownPlays, hooks } from "./state.js";
import "./theme.js"; // its controls wire themselves up
import { periodZoom, clampZoom, rollingSub, WINDOWS, rawMemo, renderRollingChart, brushMorph, paintBrush, paintClock, paintMonthly, mixArgs, renderMix, chartArtists, sweepSmoothing, sweepWindow, pin, setBrushMorph, setBrushFocus, clearMixArgs } from "./rollingview.js";
import { paintFocus, paintArtistKey, closeResults } from "./key.js";

// The modules under this one call these back through hooks (state.js)
Object.assign(hooks, { renderAll, renderDependents, paintArtistKey });

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
  state.raw = plays;
  state.pinned = [];
  state.hidden = [];
  state.colorSlots = new Map();
  state.dims = new Map();
  state.dim = "artist";
  $("window").value = START_WINDOW;
  setHidden($("chart-rolling"), []);
  applyDim();
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
  forgetCovers();
  state.raw = state.plays = state.key = state.shared = null;
  state.pinned = [];
  state.artists = [];
  state.colorSlots = new Map();
  state.dims = new Map();
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
  // The settings act on loaded data, so there's nothing to show before an upload
  $("settings-button").hidden = !state.plays;
  closeSettings();
  if (view === "community") renderCommunity(state.raw);
}

// The settings menu: sharing and forgetting the loaded data, behind the gear in the top bar
function openSettings() {
  $("settings-menu").hidden = false;
  $("settings-button").setAttribute("aria-expanded", "true");
  $("settings-menu").querySelector(".settings-item:not([hidden])")?.focus({ preventScroll: true });
}

function closeSettings(refocus = false) {
  if ($("settings-menu").hidden) return;
  $("settings-menu").hidden = true;
  $("settings-button").setAttribute("aria-expanded", "false");
  if (refocus) $("settings-button").focus();
}

$("settings-button").addEventListener("click", () => ($("settings-menu").hidden ? openSettings() : closeSettings()));
// Any choice closes the menu (its own handler runs as well)
$("settings-menu").addEventListener("click", (e) => {
  if (e.target.closest(".settings-item")) closeSettings();
});
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".settings")) closeSettings();
});
$("settings-menu").addEventListener("keydown", (e) => {
  const items = [...$("settings-menu").querySelectorAll(".settings-item:not([hidden])")];
  const i = items.indexOf(document.activeElement);
  if (e.key === "Escape") closeSettings(true);
  else if (e.key === "Tab") closeSettings();
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  }
});

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
    await api.submitSummary(state.key, buildSummary(state.raw));
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
    if (state.view === "community") renderCommunity(state.raw);
  } catch (err) {
    console.error(err);
    renderShareState(`Couldn't remove: ${err.message}`);
  }
}

$("share-toggle").addEventListener("click", share);
$("share-remove").addEventListener("click", unshare);
$("share-preview").addEventListener("click", () => {
  // One line per artist/track entry so it's easy to scan
  const entries = Object.entries(buildSummary(state.raw)).map(([k, v]) =>
    `  "${k}": ` +
    (Array.isArray(v) && Array.isArray(v[0]) ? `[\n${v.map((x) => "    " + JSON.stringify(x)).join(",\n")}\n  ]` : JSON.stringify(v))
  );
  $("preview-json").textContent = `{\n${entries.join(",\n")}\n}`;
  $("preview-dialog").showModal();
});
$("preview-close").addEventListener("click", () => $("preview-dialog").close());

// ---------- Artists, tracks or albums ----------

// A track or album is called by its name, with its artist after it where more than one artist has that name
// (an "Intro", a "Greatest Hits"). Worked out once per view and kept.
let keyedMemo = new Map();

// Up to five of an item's track IDs, most played first: the picture lookup tries them in turn (covers.js)
const PICTURE_TRACKS = 5;
const countId = (ids, id) => id && ids.set(id, (ids.get(id) ?? 0) + 1);
const topIds = (ids) => [...ids].sort((a, b) => b[1] - a[1]).slice(0, PICTURE_TRACKS).map(([id]) => id);

function keyedPlays(dim) {
  const memo = keyedMemo.get(dim);
  if (memo?.raw === state.raw) return memo;
  if (dim === "artist") {
    // An artist's photo is found through their most-played tracks
    const ids = new Map();
    for (const p of state.raw) {
      if (!ids.has(p.artist)) ids.set(p.artist, new Map());
      countId(ids.get(p.artist), p.id);
    }
    const cover = new Map([...ids].map(([name, m]) => [name, { kind: "artist", name, ids: topIds(m) }]));
    const out = { raw: state.raw, plays: state.raw, owner: null, title: null, album: null, cover };
    keyedMemo.set(dim, out);
    return out;
  }
  const nameOf = dim === "track" ? (p) => p.track : (p) => p.album || "Unknown album";
  const artistsOf = new Map();
  for (const p of state.raw) {
    const n = nameOf(p);
    if (!artistsOf.has(n)) artistsOf.set(n, new Set());
    artistsOf.get(n).add(p.artist);
  }
  const keys = new Map(); // name + artist -> what the view calls it
  const owner = new Map(); // what the view calls it -> artist
  const title = new Map(); // what the view calls it -> its own name, without the artist
  const albums = new Map(); // what the view calls it -> album -> { n: plays from it, ids: its track IDs -> plays }
  const plays = state.raw.map((p) => {
    const n = nameOf(p), id = n + "\u0000" + p.artist;
    let key = keys.get(id);
    if (key === undefined) {
      key = artistsOf.get(n).size > 1 || n === "Everyone else" ? `${n} · ${p.artist}` : n;
      keys.set(id, key);
      owner.set(key, p.artist);
      title.set(key, n);
      albums.set(key, new Map());
    }
    const on = albums.get(key), a = on.get(p.album) ?? { n: 0, ids: new Map() };
    a.n++;
    countId(a.ids, p.id);
    on.set(p.album, a);
    return { ...p, artist: key, by: p.artist };
  });
  // A track on several albums (a single, then the album) is called by the one it was played from most, and
  // shows that album's cover, found through its tracks (data saved before IDs were kept has none)
  const most = new Map([...albums].map(([k, m]) => [k, [...m].sort((a, b) => b[1].n - a[1].n)[0]]));
  const album = dim === "track" ? new Map([...most].map(([k, [name]]) => [k, name || undefined])) : null;
  // No album, no cover
  const cover = new Map([...most].map(([k, [name, a]]) => [k, name ? { kind: "album", name: owner.get(k), album: name, ids: topIds(a.ids) } : undefined]));
  const out = { raw: state.raw, plays, owner, title, album, cover };
  keyedMemo.set(dim, out);
  return out;
}

// Puts the view's plays and words in place (the graphs are drawn by the caller)
function applyDim() {
  ({ plays: state.plays, owner: state.owner, title: state.titles, album: state.albums, cover: state.covers } = keyedPlays(state.dim));
  state.artists = agg.topArtists(state.plays, Infinity);
  const w = noun();
  $("n-label").textContent = w.Many;
  $("artist-search").placeholder = `Pin ${w.a}…`;
  $("artist-search").setAttribute("aria-label", `Search ${w.many} to pin to the chart`);
  $("rolling-title").textContent = `Top ${w.Many} View`;
  $("clock-note").textContent = `${w.who} you listen to through each day of the week, as a share of that time, in your local time zone (better with a smaller window size)`;
  // The older account-data export has no albums
  $("view-tabs").querySelector('[data-dim="album"]').hidden = !state.raw.some((p) => p.album);
  for (const b of $("view-tabs").children) b.setAttribute("aria-pressed", b.dataset.dim === state.dim);
  $("period-resize").replaceChildren(
    ...RESIZES[state.dim].map((len) => {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.len = len;
      b.textContent = len.toUpperCase();
      b.setAttribute("aria-pressed", "false");
      return b;
    })
  );
}

// Another view: its pins, hidden names and colors come back as the reader left them, and every graph morphs
// from the old view's names to the new one's
function setDim(dim) {
  if (dim === state.dim || !state.raw) return;
  // hidden: the names hidden in the chart now; kept: every name the chart keeps hidden, shown or not
  state.dims.set(state.dim, {
    pinned: state.pinned, hidden: state.hidden, kept: hiddenIn($("chart-rolling")), colorSlots: state.colorSlots,
  });
  const saved = state.dims.get(dim);
  state.dim = dim;
  state.pinned = saved?.pinned ?? [];
  state.colorSlots = saved?.colorSlots ?? new Map();
  state.hidden = saved?.hidden ?? [];
  setHidden($("chart-rolling"), saved?.kept ?? []);
  closeResults();
  applyDim();
  // The other charts wait for the rolling chart's new names (its followers draw them), rather than drawing the
  // old view's names over the new plays first
  clearMixArgs();
  syncPeriod(); // the period buttons are the view's own
  renderDependents();
  setBrushMorph({ ms: MORPH_MS });
  renderRollingChart(periodZoom(), true);
  setBrushMorph(null);
}

// The white behind a solid segmented control's chosen button (its ::before, style.css) slides to whichever
// button is pressed now, also when the buttons themselves change (a view's own period lengths) and the chosen
// one sits somewhere else. With none pressed it fades where it is; coming back, it fades in at its button
// rather than sliding from where it faded.
function segThumbs() {
  for (const group of document.querySelectorAll(".segmented.solid")) {
    let shown = false;
    const place = () => {
      const b = [...group.children].find((c) => c.getAttribute("aria-pressed") === "true" && !c.hidden);
      if (!b || !b.offsetWidth) {
        group.style.setProperty("--thumb-o", 0);
        shown = false;
        return;
      }
      if (!shown) {
        group.classList.add("thumb-still");
        void group.offsetWidth; // the jump lands before the slide comes back
      }
      group.style.setProperty("--thumb-x", `${b.offsetLeft}px`);
      group.style.setProperty("--thumb-w", `${b.offsetWidth}px`);
      group.style.setProperty("--thumb-o", 1);
      if (!shown) requestAnimationFrame(() => group.classList.remove("thumb-still"));
      shown = true;
    };
    new MutationObserver(place).observe(group, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-pressed", "hidden"] });
    new ResizeObserver(place).observe(group);
    place();
  }
}
segThumbs();

$("view-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) setDim(b.dataset.dim);
});

// ---------- Dashboard ----------

const fmtDay = (d, opts = { month: "short", day: "numeric", year: "numeric" }) => agg.dayToDate(d).toLocaleDateString(undefined, opts);
const spanOf = (r) => r.hi - r.lo + 1;
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
function syncPeriod(frame = true) {
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

function setPeriod(value) {
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
function panMs(from) {
  return from ? scaledMs(spanOf(from), spanOf(state.range), PAN_MS) : dur(PAN_MS);
}

function renderAll(keepZoom, from = false) {
  renderDependents();
  const ms = panMs(from);
  const frame = brushRange(), to = state.range;
  renderRollingChart(keepZoom ?? periodZoom(), from && ms > 0 && { ms, easing: EASE_IN_OUT.echarts, pan: true, onFrame: (e) => glideBrushRange(frame, to, e) });
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

// Everything that follows the legend's selection: monthly hours and the clock
// (the mix bar does too, in renderMix, since it's drawn from the chart's artists)
function renderDependents() {
  const plays = shownPlays();
  paintMonthly(plays);
  paintClock(plays);
  paintFocus();
}

// Deselecting artists in the legend removes them from the other graphs too
onSelectionChange($("chart-rolling"), (hidden) => {
  if (hidden.join("\u0000") === state.hidden.join("\u0000")) return;
  state.hidden = hidden;
  if (!state.plays) return;
  renderDependents();
  if (mixArgs) renderMix(...mixArgs);
  paintArtistKey();
  paintBrush(undefined, brushMorph ?? { ms: MORPH_MS });
});

setupMix((name) => focusArtist($("chart-rolling"), name));
onFocusChange($("chart-rolling"), (name) => {
  highlightMix(name);
  paintFocus(name);
  focusMonthly($("chart-monthly"), name);
  focusClock($("chart-clock"), name);
  setBrushFocus(name);
  paintBrush(undefined, brushMorph ?? { ms: FADE_MS });
});

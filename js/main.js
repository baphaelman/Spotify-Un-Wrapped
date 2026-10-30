import { parseFiles, filesFromDataTransfer } from "./parse.js";
import * as agg from "./aggregate.js";
import { renderRolling, renderMonthly, renderClock, disposeAll, currentZoom, setZoom, focusArtist, toggleArtist, showArtists, focusMonthly, focusClock, onFocusChange, onSelectionChange, onZoomChange, hiddenIn, setHidden } from "./charts.js";
import { setupBrush, setBrushData, setBrushRange, setBrushBands, brushRange, glideBrushRange } from "./brush.js";
import { sweep, cancelSweep, dur, flip, FADE_MS, GROW_MS, CHASE_MS, MORPH_MS, PAN_MS, scaledMs, sweepSteps, EASE_IN_OUT, EASE_OUT } from "./motion.js";
import { updateMix, setupMix, highlightMix } from "./mix.js";
import { buildSummary, submissionKey } from "./summary.js";
import { renderCommunity } from "./community.js";
import * as api from "./api.js";
import { savePlays, loadPlays, clearPlays } from "./store.js";
import { forgetCovers } from "./covers.js";

const $ = (id) => document.getElementById(id);

// range: the period every graph shows, { lo, hi } as inclusive day indices (see agg.dayIndex). The brush picks
// it, and the presets in the dropdown are just ranges (a year, or all time).
// pinned: artists the reader added to the rolling chart through the search; artists: every artist, by hours;
// colorSlots: the palette slot (0-7) each artist last had in the rolling chart, so colors follow the artist
// raw: the plays as loaded. plays: the same plays as the current view (dim) sees them, where "artist" can be a
// track or an album (see keyedPlays); owner: each track's or album's artist in that view. dims: the pins,
// hidden names and colors each view had when the reader left it.
const state = {
  raw: null, plays: null, range: null, view: "you", key: null, shared: null, rollingMode: "share", smoothify: "auto",
  pinned: [], hidden: [], artists: [], colorSlots: new Map(), dim: "artist", owner: null, dims: new Map(),
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

// Each view is the same page over the plays keyed another way. The tracks view's plays carry the track in
// `artist` (and the real artist in `by`), the albums view's the album, so every graph, list, and the period
// bar's slider, search, key and pins work on any of them unchanged. Only the words differ.
const NOUN = {
  artist: { one: "artist", many: "artists", Many: "Artists", a: "an artist", who: "Who" },
  track: { one: "track", many: "tracks", Many: "Tracks", a: "a track", who: "What" },
  album: { one: "album", many: "albums", Many: "Albums", a: "an album", who: "What" },
};
const noun = () => NOUN[state.dim];

// The "Days per slice" slider's first step (see WINDOWS). Switching views keeps both it and the period as they
// are; only the period buttons on offer change. Tracks come and go faster than artists, so their buttons go
// shorter, and their graphs are smoothed sooner.
const START_WINDOW = 3;
const RESIZES = {
  artist: ["3m", "6m", "1y", "2y"],
  track: ["30d", "3m", "6m", "1y"],
  album: ["3m", "6m", "1y", "2y"],
};
// What each period button also sets on the graphs: the days per slice, and the smoothing where it names one
// (Off 0 … Max 4); left out, the smoothing stays as it is. A shorter period gets a finer slice.
const RESIZE_LOOK = {
  artist: { "3m": { window: 15 }, "6m": { window: 30 }, "1y": { window: 45 }, "2y": { window: 75 } },
  track: { "30d": { window: 15 }, "3m": { window: 30 }, "6m": { window: 45, smooth: 1 }, "1y": { window: 45, smooth: 2 } },
};
RESIZE_LOOK.album = RESIZE_LOOK.artist;
const autoSpans = () => (state.dim === "track" ? agg.TRACK_AUTO_SPAN : undefined);

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
  mixArgs = null;
  syncPeriod(); // the period buttons are the view's own
  renderDependents();
  brushMorph = { ms: MORPH_MS };
  renderRollingChart(periodZoom(), true);
  brushMorph = null;
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
  brushMorph = pan ? { delay: pan, ms: MORPH_MS } : null;
  renderAll(undefined, from);
  brushMorph = null;
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

// The plays in the period
const rangePlays = () => agg.filterRange(state.plays, state.range.lo, state.range.hi);

// The period's plays without the artists deselected in the rolling chart's legend
function shownPlays() {
  const plays = rangePlays();
  if (!state.hidden.length) return plays;
  const hidden = new Set(state.hidden);
  return plays.filter((p) => !hidden.has(p.artist));
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

// The hovered artist lights everything that belongs to them, as pinning does: their chip in the period bar's
// key (the mix bar is lit in mix.js)
let listFocus = null;
function paintFocus(name = listFocus) {
  listFocus = name;
  for (const item of document.querySelectorAll("#artist-key [data-artist]")) {
    item.classList.toggle("focus", name != null && item.dataset.artist === name);
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
const WINDOWS = [7, 15, 30, 45, 75, 90, 180];

// The rolling data last computed, so a sweep through blur radii doesn't redo it for every step
let rawMemo = null;
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
function renderRollingChart(zoom, morph = false, look = null, followers = !look) {
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
  const key = [state.dim, state.plays.length, window, grid, includeOther, ...artists].join("\u0000");
  if (rawMemo?.key !== key) rawMemo = { key, raw: agg.rolling(state.plays, artists, window, includeOther, grid) };
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
let brushMorph = null; // set while a preset or step renders: the new bands wait for the window, then morph in
// raw: another rolling result to draw instead of the chart's (the end of a window sweep); morph: see setBrushBands
function paintBrush(raw = rawMemo?.raw, morph = brushMorph) {
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
function paintClock(plays = shownPlays()) {
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
function paintMonthly(plays = shownPlays()) {
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

// The artist key in the period bar, for every graph: a chip per artist in the rolling chart, in its order and
// colors. The box shows or hides the artist everywhere, clicking the name pins or unpins them, and hovering lights
// them everywhere. Pinned chips are tinted and outlined. It's led by a box that shows or hides every
// unpinned artist at once. Chips that stay glide to their new places when the artists change.
function paintArtistKey() {
  if (!mixArgs) return;
  const [artists, , , pins] = mixArgs;
  // mixArgs can lag a render behind the colors, so leave out any artist without a slot yet
  const keyed = artists.filter((a) => state.colorSlots.has(a));
  const hover = (name) => focusArtist($("chart-rolling"), name);
  const key = $("artist-key");
  const chips = (root) => new Map([...root.querySelectorAll("[data-artist]")].map((el) => [el.dataset.artist, el]));
  const before = new Map([...chips(key)].map(([n, el]) => [n, el.getBoundingClientRect()]));
  // The chips are rebuilt, so a CSS transition can't run: a chip whose outline or tint changes (pinned or
  // unpinned, shown or hidden) fades from how it looked to how it looks now
  const looks = (el) => {
    const cs = getComputedStyle(el);
    return { borderColor: cs.borderColor, backgroundColor: cs.backgroundColor, opacity: cs.opacity };
  };
  const looked = new Map([...chips(key)].map(([n, el]) => [n, looks(el)]));
  // The boxes' minus (and the all box's plus) fades the same way. The box under the
  // pointer is rebuilt too, and a new element can miss :hover until the pointer moves, so .hover stands in
  const boxes = (root) => [...chips(root), ["\u0000all", root.querySelector(".legend-all")]].filter(([, el]) => el);
  const boxOf = (unit) => unit.querySelector(".swatch") ?? unit;
  const marked = new Map(boxes(key).map(([n, el]) => [n, { parts: markLooks(el), hover: boxOf(el).matches(":hover, .hover") }]));
  // Rebuilding drops keyboard focus, so it goes back to the same control in the new chip
  const focused = key.contains(document.activeElement) ? document.activeElement : null;
  const refocus = focused && [focused.closest("[data-artist]")?.dataset.artist, focused.className];

  const items = keyed.map((n) => {
    const off = state.hidden.includes(n);
    const pinned = !off && pins.has(n);
    const item = document.createElement("span");
    item.className = "legend-item mix-legend-item pinnable" + (pinned ? " pinned" : "") + (off ? " hidden-artist" : "");
    item.style.setProperty("--c", `var(--series-${state.colorSlots.get(n) + 1})`);
    item.dataset.artist = n;
    item.title = off ? `Show ${n}` : pinned ? `Unpin ${n}` : `Pin ${n}`;
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "swatch";
    sw.setAttribute("aria-pressed", !off);
    sw.title = off ? `Show ${n}` : `Hide ${n}`;
    sw.setAttribute("aria-label", sw.title);
    sw.addEventListener("click", (e) => {
      e.stopPropagation();
      hover(null);
      pins.hide(n);
    });
    const label = document.createElement("button");
    label.type = "button";
    label.className = "name";
    label.textContent = n; // artist names come from user files
    label.dataset.text = n; // read by the CSS that reserves the bold width
    label.setAttribute("aria-label", item.title);
    item.append(sw, label);
    item.addEventListener("pointerenter", () => hover(n));
    item.addEventListener("pointerleave", () => hover(null));
    item.addEventListener("click", () => (off ? pins.hide(n) : pins.toggle(n)));
    return item;
  });
  // Everyone else comes last, in gray, like its band on top of the stack. It isn't an artist, so it can't be
  // pinned: a click anywhere on it shows or hides it, and it's dimmed while hidden, like a hidden artist
  const otherOn = $("include-other").checked;
  const rest = document.createElement("span");
  rest.className = "legend-item mix-legend-item pinnable other-chip" + (otherOn ? "" : " hidden-artist");
  rest.style.setProperty("--c", "var(--other)");
  rest.dataset.artist = "Everyone else";
  const restSw = document.createElement("button");
  restSw.type = "button";
  restSw.className = "swatch";
  restSw.setAttribute("aria-pressed", otherOn);
  restSw.tabIndex = -1; // the name is the one control, so it's a single tab stop
  const restName = document.createElement("button");
  restName.type = "button";
  restName.className = "name";
  restName.textContent = restName.dataset.text = "Everyone else";
  restName.setAttribute("aria-pressed", otherOn);
  rest.title = otherOn ? "Hide everyone else" : "Show everyone else, in gray";
  restName.setAttribute("aria-label", rest.title);
  rest.append(restSw, restName);
  rest.addEventListener("pointerenter", () => otherOn && hover("Everyone else"));
  rest.addEventListener("pointerleave", () => hover(null));
  rest.addEventListener("click", () => {
    hover(null);
    $("include-other").checked = !otherOn;
    $("include-other").dispatchEvent(new Event("input"));
  });
  items.push(rest);
  // As in the rolling chart, the box leaves shown pinned artists alone (a hidden one it brings back like the
  // rest). Checked when they're all shown, a plus when some can come back; a click shows them all, or hides
  // them all once they're all shown
  const top = keyed.filter((n) => !pins.has(n) || state.hidden.includes(n));
  const on = top.filter((n) => !state.hidden.includes(n)).length;
  const box = document.createElement("button");
  box.type = "button";
  box.className = "legend-item legend-all";
  box.setAttribute("role", "checkbox");
  box.setAttribute("aria-checked", on === top.length ? "true" : on ? "mixed" : "false");
  box.title = `${on === top.length ? "Hide" : "Show"} all top ${noun().many}`;
  box.setAttribute("aria-label", box.title);
  const mark = document.createElement("span");
  mark.className = "all-box";
  const glyph = document.createElement("span");
  glyph.className = "all-glyph";
  glyph.classList.toggle("plus", on !== top.length);
  mark.append(glyph);
  box.append(mark);
  box.addEventListener("click", () => showArtists($("chart-rolling"), top, on !== top.length));
  key.replaceChildren(...(top.length ? [box] : []), ...items);
  flip(before, chips(key));
  for (const [n, el] of boxes(key)) {
    if (!marked.get(n)?.hover) continue;
    const b = boxOf(el);
    b.classList.add("hover");
    b.addEventListener("pointerleave", () => b.classList.remove("hover"), { once: true });
  }
  if (refocus) {
    const [n, cls] = refocus;
    const chip = n == null ? null : chips(key).get(n);
    (n == null ? key.querySelector(".legend-all") : chip?.querySelector(`[class="${cls}"]`) ?? chip?.querySelector(".name"))?.focus({ preventScroll: true });
  }
  paintFocus();
  if (!dur(GROW_MS)) return;
  for (const [n, el] of chips(key)) {
    const was = looked.get(n);
    if (!was) continue;
    const now = looks(el);
    if (Object.keys(now).every((k) => now[k] === was[k])) continue;
    el.animate([was, now], { duration: GROW_MS, easing: EASE_OUT.css });
  }
  for (const [n, el] of boxes(key)) {
    const was = marked.get(n)?.parts;
    if (!was) continue;
    markLooks(el).forEach((now, i) => {
      if (Object.keys(now.look).every((k) => now.look[k] === was[i].look[k])) return;
      now.el.animate([was[i]?.look ?? now.look, now.look], { duration: GROW_MS, easing: EASE_OUT.css, pseudoElement: now.pseudo });
    });
  }
}

// How a key box's marks look: an artist box's fill and its hover minus (::before), and the upright that
// makes the all box's minus a plus
const MARK_PARTS = [[".swatch", undefined], [".swatch", "::before"], [".all-glyph", "::after"]];
function markLooks(unit) {
  return MARK_PARTS.flatMap(([sel, pseudo]) => {
    const el = unit.querySelector(sel);
    if (!el) return [];
    const cs = getComputedStyle(el, pseudo);
    return [{ el, pseudo, look: { backgroundColor: cs.backgroundColor, opacity: cs.opacity } }];
  });
}

// The listening mix bar: the same artists, colors and per-day hours as the chart above, over the period
let mixMemo = null;
let mixArgs = null; // the last renderMix arguments, to redraw the bar when only the legend's selection changed
function renderMix(artists, slots, includeOther, pins) {
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
setupMix((name) => focusArtist($("chart-rolling"), name));
onFocusChange($("chart-rolling"), (name) => {
  highlightMix(name);
  paintFocus(name);
  focusMonthly($("chart-monthly"), name);
  focusClock($("chart-clock"), name);
  brushFocus = name;
  paintBrush(undefined, brushMorph ?? { ms: FADE_MS });
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

// Sweeps through every blur radius between the old strength and the current one (state.smoothify), rather than
// tweening each point straight from the old curve to the new, which would just crossfade them
function sweepSmoothing(from) {
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
function sweepWindow(glide = false, to = WINDOWS[$("window").value]) {
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

// Up to 8 matches: names starting with the query, then a word starting with it, then anywhere.
// state.artists is sorted by hours and the sort is stable, so ties stay biggest first.
function searchArtists(query) {
  const q = fold(query.trim());
  if (!q) return [];
  const found = [];
  for (const a of state.artists) {
    const at = fold(a.name).indexOf(q);
    // Tracks and albums are found by their artist too, after every match on the name
    if (at < 0 && state.owner && fold(state.owner.get(a.name)).includes(q)) found.push({ ...a, at: -1, rank: 3 });
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
    if (a.at >= 0 && fold(a.name).length === a.name.length) {
      const mark = document.createElement("mark");
      mark.textContent = a.name.slice(a.at, a.at + a.len);
      name.append(a.name.slice(0, a.at), mark, a.name.slice(a.at + a.len));
    } else name.textContent = a.name;
    const detail = document.createElement("span");
    detail.className = "detail";
    const status = pinned ? "Pinned" : state.chartNames?.includes(a.name) ? "In chart" : fmtArtistHours(a.hours);
    // A track or album says whose it is, unless its name already does
    const by = state.owner?.get(a.name);
    detail.textContent = by && !a.name.endsWith(` · ${by}`) ? `${by} · ${status}` : status;
    li.append(name, detail);
    // pointerdown would blur the input and close the list before the click lands
    li.addEventListener("pointerdown", (e) => e.preventDefault());
    li.addEventListener("pointerenter", () => setActive(i));
    li.addEventListener("click", () => choose(i));
    return li;
  });
  list.replaceChildren(
    ...(full ? [note(`${MAX_PINS} ${noun().many} pinned. Unpin one to add another.`)] : []),
    ...(items.length ? items : [note(`No ${noun().many} match`)])
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

// Series palettes, chosen from the dot at the head of the period bar's artist key. "Default" is the stylesheet's own --series-N
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
  // Bring the chosen palette into view inside the menu, without scrolling the page down to it
  const chosen = menu.querySelector('[aria-checked="true"]');
  if (chosen) {
    chosen.focus({ preventScroll: true });
    menu.scrollTop = Math.max(0, chosen.offsetTop - (menu.clientHeight - chosen.offsetHeight) / 2);
  }
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

let themeSwapping = false;
function flipTheme() {
  document.documentElement.dataset.theme = isDark() ? "light" : "dark";
  rerenderForTheme();
}
// The page changes theme through a circle at the toggle: light grows out of it, or shrinks back into it going dark.
// The charts are redrawn, not restyled, so this is what keeps them from snapping.
$("theme-toggle").addEventListener("click", async () => {
  const root = document.documentElement;
  if (!document.startViewTransition || !dur(MORPH_MS) || themeSwapping) return flipTheme();
  const b = $("theme-toggle").getBoundingClientRect();
  const x = b.left + b.width / 2, y = b.top + b.height / 2;
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const toDark = !isDark();
  const icon = $("theme-toggle").querySelector("svg"), ink = getComputedStyle(icon).color;
  themeSwapping = true;
  root.classList.add("theme-swap");
  root.classList.toggle("to-dark", toDark);
  const t = document.startViewTransition(flipTheme);
  try {
    await t.ready;
    // Light spreads out from the toggle; going dark, the light is drawn back into it. Held at its end (fill), or the
    // old light page shows whole for a frame before the transition is torn down.
    const open = `circle(${r}px at ${x}px ${y}px)`, shut = `circle(0px at ${x}px ${y}px)`;
    const anim = root.animate(
      { clipPath: toDark ? [open, shut] : [shut, open] },
      { duration: MORPH_MS, easing: EASE_IN_OUT.css, fill: "forwards", pseudoElement: toDark ? "::view-transition-old(root)" : "::view-transition-new(root)" }
    );
    // Going dark the icon still sits on the light page until the circle closes, so its ink follows the circle
    const inked = toDark && icon.animate({ color: [ink, getComputedStyle(icon).color] }, { duration: MORPH_MS, easing: EASE_IN_OUT.css });
    await t.finished;
    if (inked) inked.cancel();
    anim.cancel(); // or its held end carries into the next flip, hiding that one's old page
  } catch {}
  root.classList.remove("theme-swap", "to-dark");
  themeSwapping = false;
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", rerenderForTheme);

function rerenderForTheme() {
  applyPalette();
  const zoom = state.plays ? currentZoom($("chart-rolling")) : undefined;
  disposeAll();
  if (state.plays) renderAll(zoom);
  if (state.view === "community") renderCommunity(state.raw);
}

import { parseFiles, filesFromDataTransfer } from "./parse.js";
import * as agg from "./aggregate.js";
import { focusArtist, focusMonthly, focusClock, onFocusChange, onSelectionChange, hiddenIn, setHidden } from "./charts.js";
import { setBrushData, brushRange, glideBrushRange } from "./brush.js";
import { FADE_MS, MORPH_MS, EASE_IN_OUT } from "./motion.js";
import { setupMix, highlightMix } from "./mix.js";
import { buildSummary, submissionKey } from "./summary.js";
import { renderCommunity } from "./community.js";
import * as api from "./api.js";
import { savePlays, loadPlays, clearPlays } from "./store.js";
import { forgetCovers } from "./covers.js";
import { askGenres } from "./genres.js";
import { $, state, noun, NOUN, START_WINDOW, RESIZES, extent, shownPlays, hooks } from "./state.js";
import { keyedPlays } from "./views.js";
import "./theme.js"; // its controls wire themselves up
import { periodZoom, renderRollingChart, brushMorph, paintBrush, paintClock, paintMonthly, mixArgs, renderMix, setBrushMorph, setBrushFocus, clearMixArgs, syncSplit, MAX_PINS } from "./rollingview.js";
import { paintFocus, paintArtistKey, closeResults } from "./key.js";
import { syncPeriod, setPeriod, panMs } from "./period.js";
import { closeHelp } from "./guide.js";

// The modules under this one call these back through hooks (state.js)
Object.assign(hooks, { renderAll, renderDependents, paintArtistKey, openPart });
// The views parts were opened from, latest last: the back button returns to the latest, a step at a time, and
// picking a view from the tabs (or opening other data) forgets them
let viewTrail = [];

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
  setBack([]);
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
  // The controls are about the loaded data, so there's nothing to show before an upload
  $("controls-button").hidden = !state.plays;
  // The guide points at the stats page's controls
  $("help-button").hidden = $("dashboard").hidden;
  closeControls();
  closeHelp();
  if (view === "community") renderCommunity(state.raw);
}

// The settings behind the gear in the top bar: sharing and forgetting the loaded data
function openControls() {
  $("controls-panel").hidden = false;
  $("controls-button").setAttribute("aria-expanded", "true");
  $("controls-panel").querySelector(".controls-item:not([hidden])")?.focus({ preventScroll: true });
}

function closeControls(refocus = false) {
  if ($("controls-panel").hidden) return;
  $("controls-panel").hidden = true;
  $("controls-button").setAttribute("aria-expanded", "false");
  if (refocus) $("controls-button").focus();
}

$("controls-button").addEventListener("click", () => ($("controls-panel").hidden ? openControls() : closeControls()));
// Any choice closes the panel (its own handler runs as well)
$("controls-panel").addEventListener("click", (e) => {
  if (e.target.closest(".controls-item")) closeControls();
});
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".controls")) closeControls();
});
$("controls-panel").addEventListener("keydown", (e) => {
  const items = [...$("controls-panel").querySelectorAll(".controls-item:not([hidden])")];
  const i = items.indexOf(document.activeElement);
  if (e.key === "Escape") closeControls(true);
  else if (e.key === "Tab") closeControls();
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

// ---------- Views: genres, artists, albums or tracks ----------

// Asks for the genres this device doesn't know yet, once the genres view is first opened, and redraws it as they
// arrive: at most every REGENRE_MS, so the bands morph in steps rather than twitching with each answer
const REGENRE_MS = 3000;
let regenreTimer = 0;
let genresAsked = null; // the plays asked about
function startGenres() {
  if (genresAsked === state.raw) return;
  genresAsked = state.raw;
  const onChange = () => {
    if (regenreTimer) return;
    regenreTimer = setTimeout(regenre, REGENRE_MS);
  };
  askGenres(state.raw, onChange, agg.filterRange(state.raw, state.range.lo, state.range.hi)).finally(() => {
    if (!regenreTimer) regenre();
  });
}
function regenre() {
  regenreTimer = 0;
  if (state.dim !== "genre" || !state.raw) return;
  applyDim();
  renderDependents();
  renderRollingChart(periodZoom(), true);
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
  syncSplit();
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
// from the old view's names to the new one's. find: optional, returns the name in the new view to pin (and show)
// as well, once its names are in place
function setDim(dim, find = null, slot) {
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
  const key = find?.();
  if (key != null) {
    // (the oldest pin gives way if they're all taken)
    state.pinned = state.pinned.filter((n) => n !== key).slice(-(MAX_PINS - 1)).concat(key);
    state.hidden = state.hidden.filter((n) => n !== key);
    setHidden($("chart-rolling"), (saved?.kept ?? []).filter((n) => n !== key));
    // It keeps the color it was clicked in, taking the slot from whoever had it there (they get a free one)
    if (slot !== undefined) {
      state.colorSlots = new Map([...state.colorSlots].filter(([n, s]) => s !== slot && n !== key));
      state.colorSlots.set(key, slot);
    }
  }
  // The other charts wait for the rolling chart's new names (its followers draw them), rather than drawing the
  // old view's names over the new plays first
  clearMixArgs();
  syncPeriod(); // the period buttons are the view's own
  if (dim === "genre") startGenres();
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

// A part clicked in the rolling chart (an artist's album or song, or an album's song): its own view, with it pinned.
// Names there are told apart by their artist; an album's songs belong to the album's artist. It takes its
// band's color, so the eye can follow it through the morph.
function openPart(artist, kind, name) {
  const by = state.dim === "artist" ? artist : state.owner?.get(artist);
  const slot = state.colorSlots.get(artist);
  const from = state.dim;
  // (a genre's artist is called by their own name in the artists view)
  setDim(kind, kind === "artist" ? () => name : () => [...state.titles].find(([key, title]) => title === name && state.owner.get(key) === by)?.[0], slot);
  if (state.dim !== from) setBack([...viewTrail, from]);
}

function setBack(trail) {
  viewTrail = trail;
  const to = trail.at(-1);
  $("view-back").disabled = !to;
  $("view-back").setAttribute("aria-label", to ? `Back to ${NOUN[to].Many}` : "Back");
  $("view-back").title = to ? `Back to ${NOUN[to].Many}` : "";
}
$("view-back").addEventListener("click", () => {
  const to = viewTrail.at(-1);
  if (!to) return;
  setBack(viewTrail.slice(0, -1));
  setDim(to);
});

$("view-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  setBack([]);
  setDim(b.dataset.dim);
});

// ---------- Dashboard ----------

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

function renderAll(keepZoom, from = false) {
  renderDependents();
  const ms = panMs(from);
  const frame = brushRange(), to = state.range;
  renderRollingChart(keepZoom ?? periodZoom(), from && ms > 0 && { ms, easing: EASE_IN_OUT.echarts, pan: true, onFrame: (e) => glideBrushRange(frame, to, e) });
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

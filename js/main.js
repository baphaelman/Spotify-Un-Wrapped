import { parseFiles, filesFromDataTransfer } from "./parse.js";
import * as agg from "./aggregate.js";
import { renderRolling, renderMonthly, renderClock, disposeAll, currentZoom } from "./charts.js";
import { renderList, renderTiles } from "./lists.js";
import { buildSummary, submissionKey } from "./summary.js";
import { renderCommunity } from "./community.js";
import * as api from "./api.js";

const $ = (id) => document.getElementById(id);

const state = { plays: null, year: "all", view: "you", key: null, shared: null };

// ---------- Loading ----------

function setStatus(msg, isError = false) {
  $("status").textContent = msg;
  $("status").classList.toggle("error", isError);
}

async function load(files) {
  try {
    setStatus("Reading files…");
    state.plays = await parseFiles(files, setStatus);
    state.key = await submissionKey(state.plays);
    state.shared = null;
    setStatus("");
    showDashboard();
    if ($("share-optin").checked) share();
    else refreshShareState();
  } catch (err) {
    console.error(err);
    setStatus(err.message, true);
  }
}

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
  state.plays = state.key = state.shared = null;
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
  const btn = $("share-toggle");
  btn.hidden = state.shared === null;
  btn.textContent = state.shared ? "Remove my data" : "Share with community";
  btn.className = state.shared ? "ghost" : "primary";
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
  } catch (err) {
    console.error(err);
    renderShareState(`Couldn't remove: ${err.message}`);
  }
}

$("share-toggle").addEventListener("click", () => (state.shared ? unshare() : share()));
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

function showDashboard() {
  showView("you");
  const sel = $("year-filter");
  sel.replaceChildren(new Option("All time", "all"), ...agg.years(state.plays).map((y) => new Option(y, y)));
  sel.value = state.year = "all";
  renderAll();
}

$("year-filter").addEventListener("change", (e) => {
  state.year = e.target.value;
  renderAll();
});

function renderAll(keepZoom) {
  const plays = agg.filterYear(state.plays, state.year);
  renderStats(plays);
  renderTopList($("top-artists"), agg.topArtists(plays, 10), (a) => `${a.plays.toLocaleString()} plays`);
  renderTopList($("top-tracks"), agg.topTracks(plays, 10), (t) => t.artist);
  renderRollingChart(keepZoom ?? periodZoom());
  renderMonthly($("chart-monthly"), agg.monthly(plays));
  renderClock($("chart-clock"), agg.clock(plays));
}

function renderStats(plays) {
  const s = agg.summary(plays);
  const fmtDate = (d) => d.toLocaleDateString(undefined, { year: "numeric", month: "short" });
  renderTiles($("stats"), [
    { label: "Hours listened", value: Math.round(s.hours).toLocaleString(), sub: `${fmtDate(s.first)} – ${fmtDate(s.last)}`, hero: true },
    { label: "Plays", value: s.plays.toLocaleString(), sub: `${s.activeDays.toLocaleString()} days with music` },
    { label: "Artists", value: s.artists.toLocaleString(), sub: "unique" },
    { label: "Tracks", value: s.tracks.toLocaleString(), sub: "unique" },
  ]);
}

function renderTopList(ol, items, detail) {
  const max = items[0]?.hours || 1;
  renderList(
    ol,
    items.map((item) => ({
      name: item.name,
      detail: detail(item),
      value: `${Math.round(item.hours).toLocaleString()} h`,
      frac: item.hours / max,
    }))
  );
}

// ---------- Rolling chart (the original rolling_window.py) ----------

function periodZoom() {
  if (state.year === "all") return undefined;
  return [new Date(+state.year, 0, 1).getTime(), new Date(+state.year, 11, 31).getTime()];
}

function renderRollingChart(zoom) {
  const n = Number($("n-artists").value);
  const window = Number($("window").value);
  const includeOther = $("include-other").checked;
  $("n-artists-out").textContent = n;
  $("window-out").textContent = `${window}d`;

  // Top artists come from the selected period; the timeline always spans all data, zoomed to the period
  const artists = agg.topArtists(agg.filterYear(state.plays, state.year), n).map((a) => a.name);
  const data = agg.rolling(state.plays, artists, window, includeOther);
  const names = includeOther ? [...artists, "Everyone else"] : artists;

  $("rolling-sub").textContent =
    `Share of listening time, ${window}-day rolling window` +
    (includeOther ? "" : `, among your top ${n} artists`) +
    (state.year === "all" ? "" : `, top artists of ${state.year}`);
  renderRolling($("chart-rolling"), data, names, window, zoom);
}

let pending = 0;
for (const id of ["n-artists", "window", "include-other"]) {
  $(id).addEventListener("input", () => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => renderRollingChart(currentZoom($("chart-rolling"))));
  });
}

// ---------- Theme ----------

$("theme-toggle").addEventListener("click", () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  rerenderForTheme();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", rerenderForTheme);

function rerenderForTheme() {
  const zoom = state.plays ? currentZoom($("chart-rolling")) : undefined;
  disposeAll();
  if (state.plays) renderAll(zoom);
  if (state.view === "community") renderCommunity(state.plays);
}

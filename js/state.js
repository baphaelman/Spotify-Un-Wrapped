// The page's state and the small readers every part of the page shares: the plays in the period, the
// presets, and the words for the current view (artists, tracks or albums).
// hooks: functions main.js registers at startup, so the modules under it can call back up without importing it.
import * as agg from "./aggregate.js";

export const $ = (id) => document.getElementById(id);

// range: the period every graph shows, { lo, hi } as inclusive day indices (see agg.dayIndex). The brush picks
// it, and the presets in the dropdown are just ranges (a year, or all time).
// pinned: artists the reader added to the rolling chart through the search; artists: every artist, by hours;
// colorSlots: the palette slot (0-7) each artist last had in the rolling chart, so colors follow the artist
// raw: the plays as loaded. plays: the same plays as the current view (dim) sees them, where "artist" can be a
// track or an album (see keyedPlays); owner: each track's or album's artist in that view. dims: the pins,
// hidden names and colors each view had when the reader left it.
export const state = {
  raw: null, plays: null, range: null, view: "you", key: null, shared: null, rollingMode: "share", smoothify: "auto",
  pinned: [], hidden: [], artists: [], colorSlots: new Map(), dim: "artist", owner: null, dims: new Map(),
};

// Each view is the same page over the plays keyed another way. The tracks view's plays carry the track in
// `artist` (and the real artist in `by`), the albums view's the album, so every graph, list, and the period
// bar's slider, search, key and pins work on any of them unchanged. Only the words differ.
const NOUN = {
  artist: { one: "artist", many: "artists", Many: "Artists", a: "an artist", who: "Who" },
  track: { one: "track", many: "tracks", Many: "Tracks", a: "a track", who: "What" },
  album: { one: "album", many: "albums", Many: "Albums", a: "an album", who: "What" },
};
export const noun = () => NOUN[state.dim];

// The "Days per slice" slider's first step (see WINDOWS). Switching views keeps both it and the period as they
// are; only the period buttons on offer change. Tracks come and go faster than artists, so their buttons go
// shorter, and their graphs are smoothed sooner.
export const START_WINDOW = 3;
export const RESIZES = {
  artist: ["3m", "6m", "1y", "2y"],
  track: ["30d", "3m", "6m", "1y"],
  album: ["3m", "6m", "1y", "2y"],
};
// What each period button also sets on the graphs: the days per slice, and the smoothing where it names one
// (Off 0 … Max 4); left out, the smoothing stays as it is. A shorter period gets a finer slice.
export const RESIZE_LOOK = {
  artist: { "3m": { window: 15 }, "6m": { window: 30 }, "1y": { window: 45 }, "2y": { window: 75 } },
  track: { "30d": { window: 15 }, "3m": { window: 30 }, "6m": { window: 45, smooth: 1 }, "1y": { window: 45, smooth: 2 } },
};
RESIZE_LOOK.album = RESIZE_LOOK.artist;
export const autoSpans = () => (state.dim === "track" ? agg.TRACK_AUTO_SPAN : undefined);

// The days the history covers, as day indices
export const extent = () => ({ lo: agg.dayIndex(state.plays[0].t), hi: agg.dayIndex(state.plays[state.plays.length - 1].t) });

// A preset's range: "all" is the whole history, a year is January 1 to December 31 (or as much of it as exists)
export function presetRange(value) {
  const e = extent();
  if (value === "all") return e;
  const lo = agg.dayIndex(new Date(+value, 0, 1).getTime()), hi = agg.dayIndex(new Date(+value, 11, 31).getTime());
  return { lo: Math.max(lo, e.lo), hi: Math.min(hi, e.hi) };
}

// The preset the range is exactly, or null for a stretch the reader chose with the brush
export function presetOf(range) {
  for (const o of $("year-filter").options) {
    const r = presetRange(o.value);
    if (r.lo === range.lo && r.hi === range.hi) return o.value;
  }
  return null;
}

// "All time", a year, or "Custom" for anything the brush picked
export const presetLabel = () => {
  const p = presetOf(state.range);
  return p === null ? "Custom" : p === "all" ? "All time" : p;
};

// The plays in the period
export const rangePlays = () => agg.filterRange(state.plays, state.range.lo, state.range.hi);

// The period's plays without the artists deselected in the rolling chart's legend
export function shownPlays() {
  const plays = rangePlays();
  if (!state.hidden.length) return plays;
  const hidden = new Set(state.hidden);
  return plays.filter((p) => !hidden.has(p.artist));
}

// Set by main.js at startup (renderAll, renderDependents, paintArtistKey)
export const hooks = {};

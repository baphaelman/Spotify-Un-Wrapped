// The page's state and the small readers every part of the page shares: the plays in the period, the
// presets, and the words for the current view (genres, artists, albums or tracks).
// hooks: functions main.js registers at startup, so the modules under it can call back up without importing it.
import * as agg from "./aggregate.js";

export const $ = (id) => document.getElementById(id);

// range: the period every graph shows, { lo, hi } as inclusive day indices (see agg.dayIndex). The brush picks
// it, and the presets in the dropdown are just ranges (a year, or all time).
// pinned: artists the reader added to the rolling chart through the search; artists: every artist, by hours;
// colorSlots: the palette slot (0-9) each artist last had in the rolling chart, so colors follow the artist
// raw: the plays as loaded. plays: the same plays as the current view (dim) sees them, where "artist" can be a
// track, an album or a genre (see views.js); owner: each track's or album's artist in that view. dims: the pins,
// hidden names and colors each view had when the reader left it. sample: the plays are the sample data (sample.js),
// which is never remembered on this device nor shared with the community.
export const state = {
  raw: null, plays: null, range: null, view: "you", key: null, shared: null, smoothify: "auto",
  pinned: [], hidden: [], artists: [], colorSlots: new Map(), dim: "artist", owner: null, dims: new Map(),
  split: { artist: "track", album: "track", genre: "artist" }, sample: false,
};

// split: what the rolling chart splits each band into, per view: "album", "track" (songs), "artist", or null for
// whole bands. Each view keeps its own choice, so an album opened from an artist's breakdown arrives broken down by
// song. An artist splits into albums or songs, an album into songs, a genre into its artists, albums or songs, a
// track not at all.
const SPLITS = { artist: ["album", "track"], album: ["track"], genre: ["artist", "album", "track"] };
export const splitKind = () => {
  const to = state.split[state.dim];
  return SPLITS[state.dim]?.includes(to) ? to : null;
};

// Each view is the same page over the plays keyed another way. The tracks view's plays carry the track in
// `artist` (and the real artist in `by`), the albums view's the album, so every graph, list, and the period
// bar's slider, search, key and pins work on any of them unchanged. Only the words differ.
export const NOUN = {
  artist: { one: "artist", many: "artists", Many: "Artists", a: "an artist", who: "Who" },
  track: { one: "track", many: "tracks", Many: "Tracks", a: "a track", who: "What" },
  album: { one: "album", many: "albums", Many: "Albums", a: "an album", who: "What" },
  genre: { one: "genre", many: "genres", Many: "Genres", a: "a genre", who: "What" },
};
export const noun = () => NOUN[state.dim];

// The gray catch-all is "Everyone else" everywhere, the Genres view included (there it also holds the artists with no genre)
export const OTHER = "Everyone else";
export const otherLabel = () => OTHER;
export const shownName = (n) => (n === OTHER ? otherLabel() : n);

// An item's color while it's one of the rolling chart's artists, as a CSS value; null for the rest, which stay gray
export const chartColor = (key) => {
  const slot = state.chartNames?.includes(key) ? state.colorSlots?.get(key) : undefined;
  return slot === undefined ? null : `var(--series-${slot + 1})`;
};

// The "Days per slice" slider's first step (see WINDOWS). Switching views keeps both it and the period as they
// are, and every view offers the same period buttons, so the bar never changes between tabs. Tracks come and go
// faster than artists, so their graphs get finer slices and are smoothed sooner (RESIZE_LOOK).
export const START_WINDOW = 3;
export const RESIZES = ["30d", "3m", "6m", "1y", "2y"];
// What each period button also sets on the graphs: the days per slice, and the smoothing where it names one
// (Off 0 … Max 4); left out, the smoothing stays as it is. A shorter period gets a finer slice.
export const RESIZE_LOOK = {
  artist: { "30d": { window: 7 }, "3m": { window: 15 }, "6m": { window: 30 }, "1y": { window: 45 }, "2y": { window: 75 } },
  track: { "30d": { window: 15 }, "3m": { window: 30 }, "6m": { window: 45, smooth: 1 }, "1y": { window: 45, smooth: 2 }, "2y": { window: 75, smooth: 2 } },
};
RESIZE_LOOK.album = RESIZE_LOOK.genre = RESIZE_LOOK.artist;

// The days the history covers, as day indices: all of it, in every view (the genres view's plays leave some out)
export const extent = () => ({ lo: agg.dayIndex(state.raw[0].t), hi: agg.dayIndex(state.raw[state.raw.length - 1].t) });

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

// itemTotals over the period, worked out once per period: the chart's artists, the mix bar and the list all read it
let totalsMemo = null;
export function rangeTotals() {
  const { lo, hi } = state.range;
  if (totalsMemo?.plays !== state.plays || totalsMemo.lo !== lo || totalsMemo.hi !== hi) {
    const plays = rangePlays();
    totalsMemo = { plays: state.plays, lo, hi, count: plays.length, items: agg.itemTotals(plays) };
  }
  return totalsMemo;
}

// The period's plays without the artists deselected in the rolling chart's legend
export function shownPlays() {
  const plays = rangePlays();
  if (!state.hidden.length) return plays;
  const hidden = new Set(state.hidden);
  return plays.filter((p) => !hidden.has(p.artist));
}

// Set by main.js at startup (renderAll, renderDependents, paintArtistKey, openPart, paintSunburst, paintRankRace)
export const hooks = {};

// Cards well off screen aren't redrawn on every change (each step of a drag of the period window, a sweep), only as
// they come back near the screen: the latest paint asked for while a card is away is kept, and run as the card comes
// within half a screen of view, before it shows. `putOff(card, paint)` returns true when it kept the paint for
// later, false when the caller should paint now. `paint` must draw from the state as it is when it runs.
const away = new Set(), owed = new Map(), watched = new WeakSet();
const nearScreen = new IntersectionObserver((entries) => {
  for (const e of entries) {
    // (a card that isn't laid out, as in the hidden dashboard, paints when asked, as it always has)
    if (!e.isIntersecting && e.boundingClientRect.height > 0) {
      away.add(e.target);
      continue;
    }
    away.delete(e.target);
    const paint = owed.get(e.target);
    owed.delete(e.target);
    paint?.();
  }
}, { rootMargin: "50% 0px" });
export function putOff(card, paint) {
  if (!watched.has(card)) {
    watched.add(card);
    nearScreen.observe(card);
  }
  if (!away.has(card)) {
    owed.delete(card);
    return false;
  }
  owed.set(card, paint);
  return true;
}
// Whether a card has a paint waiting, so what it shows is out of date anyway
export const owes = (card) => owed.has(card);

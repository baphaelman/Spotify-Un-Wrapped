// The page's state and the small readers every part of the page shares: the plays in the period, the
// presets, and the words for the current view (genres, artists, albums or tracks).
// hooks: functions main.js registers at startup, so the modules under it can call back up without importing it.
import * as agg from "./aggregate.js";
import { easeInOut, travel, MORPH_MS, dur, drawStill } from "./motion.js";

export const $ = (id) => document.getElementById(id);

// range: the period every graph shows, { lo, hi } as inclusive day indices (see agg.dayIndex). The brush picks
// it, and the presets in the dropdown are just ranges (a year, or all time).
// pinned: artists the reader added to the rolling chart through the search; artists: every artist, by hours;
// colorSlots: the palette slot (0-9) each artist last had in the rolling chart, so colors follow the artist
// raw: the plays as loaded. plays: the same plays as the current view (dim) sees them, where "artist" can be a
// track, an album or a genre (see views.js); owner: each track's or album's artist in that view. dims: the pins,
// hidden names and colors each view had when the reader left it. sample: the plays are the sample data (sample.js),
// which is never remembered on this device nor shared with the community. mixArgs: the last renderMix arguments,
// [artists, slots, includeOther, pins] (pins: { has, toggle }), so the graphs that follow the rolling chart redraw
// with its artists and pin through it; rollingview.js sets it, null before the first draw and after a reset.
export const state = {
  raw: null, plays: null, range: null, view: "you", key: null, shared: null, smoothify: "auto",
  pinned: [], hidden: [], artists: [], colorSlots: new Map(), dim: "artist", owner: null, dims: new Map(),
  split: { artist: "track", album: "track", genre: "artist" }, sample: false, mixArgs: null,
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
// Smoothing windows in days; the slider steps through these, evenly spaced
export const WINDOWS = [7, 15, 30, 45, 75, 90, 180];
export const MAX_PINS = 10; // one per series color
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

// The pan: a preset or a step slides every graph to the new period together, on one clock (main.js starts it with
// the rolling chart's). onPan(fn) follows it: fn(p) at its start (p.e 0), each frame, and its end (p.done; p.cut when
// something else cut it short), where p is { from, to, e, at, done }: from and to the ranges, e the eased progress,
// and at the range on screen (fractional days), travelling as the rolling chart's zoom does. A pan started while one
// is in flight takes over from the range on screen. onPan returns a function that stops following.
export let pan = null;
const panners = new Set();
export function onPan(fn) {
  panners.add(fn);
  return () => panners.delete(fn);
}
export function startPan(from, to, ms) {
  if (pan) cancelAnimationFrame(pan.raf);
  const p = (pan = { from, to, ms, e: 0, at: { ...from }, done: false, raf: 0 });
  const t0 = performance.now();
  const tell = () => [...panners].forEach((fn) => fn(p));
  const tick = (now) => {
    const t = Math.min(1, (now - t0) / ms);
    p.e = easeInOut(t);
    const [lo, edge] = travel([from.lo, from.hi + 1], [to.lo, to.hi + 1], p.e);
    p.at = { lo, hi: edge - 1 };
    if (t >= 1) [p.done, pan] = [true, null];
    tell();
    if (!p.done) p.raf = requestAnimationFrame(tick);
  };
  tell();
  p.raf = requestAnimationFrame(tick);
}
// Lands the pan in flight at once (something else moved the view: a drag, a redraw)
export function endPan() {
  const p = pan;
  if (!p) return;
  cancelAnimationFrame(p.raf);
  Object.assign(p, { e: 1, at: { ...p.to }, done: true, cut: true });
  pan = null;
  [...panners].forEach((fn) => fn(p));
}

// Set by main.js at startup (renderAll, renderDependents, paintArtistKey, openPart, paintSunburst, paintRankRace)
export const hooks = {};

// Cards well off screen aren't redrawn on every change (each step of a drag of the period window, a sweep), only as
// they come back near the screen: the latest paint asked for while a card is away is kept, and run as the card comes
// within half a screen of view, before it shows. `putOff(card, paint)` returns true when it kept the paint for
// later, false when the caller should paint now. `paint` must draw from the state as it is when it runs.
const away = new Set(), owed = new Map(), watched = new WeakSet();
const lastPaint = new Map(); // card -> the paint it last asked for (unloadAll)
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
    if (paint) owedChanged(e.target);
    showLooks(e.target);
  }
}, { rootMargin: "50% 0px" });
export function putOff(card, paint) {
  if (!watched.has(card)) {
    watched.add(card);
    nearScreen.observe(card);
  }
  lastPaint.set(card, paint);
  // (an idle paint drawing a card it already drew since the last change, as Every play's paint draws Every day too, is
  // up to date: nothing's owed, or the two would owe each other forever)
  if (idling && away.has(card) && paidAt.get(card) === changes) return true;
  if (!idling) changes++;
  if (!away.has(card)) {
    if (owed.delete(card)) owedChanged(card);
    return false;
  }
  const was = owed.has(card);
  owed.set(card, paint);
  if (!was) owedChanged(card);
  if (!idling) {
    idleSoon();
    // (the open graph's neighbours go sooner: once the change's own morph is done, a frame at a time)
    const rank = hooks.paintRank?.(card);
    if (rank != null) soon(card, () => pay(card), rank, dur(MORPH_MS));
  }
  return true;
}
// A change of look (a hover) for a card that's away waits until it comes back, after its paint: look(card, key, fn)
// runs fn now if the card is near the screen, or keeps it (the latest per key) for then
const looks = new Map(); // card -> key -> fn
export function look(card, key, fn) {
  if (!card || !away.has(card)) return fn();
  (looks.get(card) ?? looks.set(card, new Map()).get(card)).set(key, fn);
}
function showLooks(card) {
  const fns = looks.get(card);
  looks.delete(card);
  for (const fn of fns?.values() ?? []) fn();
}
// Bring a card back at once, ahead of the observer, its held paint run now (the gallery measures a card's plot as it
// flies it open, so the plot must be drawn for the period as it is)
export function bringBack(card) {
  away.delete(card);
  const paint = owed.get(card);
  owed.delete(card);
  paint?.();
  if (paint) owedChanged(card);
  showLooks(card);
}
// Run what cards owe now (each different paint once, in turn), leaving them away, so later paints wait again: the
// gallery's tiles copy the rolling chart's drawing (thumbs.js), which mustn't redraw off screen every frame of a drag
export function catchUp(...cards) {
  const paints = [...new Set(cards.map((c) => owed.get(c)).filter(Boolean))];
  if (!paints.length) return;
  const were = cards.filter((c) => away.delete(c));
  for (const c of cards) if (owed.delete(c)) owedChanged(c);
  for (const paint of paints) paint();
  for (const c of were) away.add(c);
}
// Every card away from the screen owes its last paint again, as after a change, so the idle paints draw them all anew
// (a Visual tweak: to watch them fill, or open a card before they have)
export function unloadAll() {
  changes++;
  for (const [card, paint] of lastPaint) {
    if (!away.has(card) || owed.has(card)) continue;
    owed.set(card, paint);
    owedChanged(card);
  }
  if (owed.size) idleSoon();
}
// Whether a card has a paint waiting, so what it shows is out of date anyway
export const owes = (card) => owed.has(card);
// (one listener, told each time a card starts or stops owing a paint: the gallery's "ready" dots)
let owedFn = null;
export const onOwedChange = (fn) => (owedFn = fn);
const owedChanged = (card) => owedFn?.(card, owed.has(card));

// Held paints run anyway once the page has been still a while, one per idle moment, cards left away, so a card opened
// later is already drawn and its opening doesn't stall on its paint (the gallery's cards wait off screen all the
// time). `prefer(card)` puts a card first and runs it soon (the tile under the cursor); `holdIdle(true)` stops them
// until `holdIdle(false)` (a flight: a paint mid-flight would freeze it).
const SETTLE_MS = 1000; // (after the last paint put off: a drag puts one off every frame, and what moved still animates)
const idle = typeof requestIdleCallback === "function" ? (fn, timeout) => requestIdleCallback(fn, { timeout }) : (fn) => setTimeout(fn, 50);
const unidle = typeof cancelIdleCallback === "function" ? cancelIdleCallback : clearTimeout;
let settleTimer = 0, idleTask = 0, idleHeld = false, preferred = null;
let changes = 0, idling = false; // (paints put off outside idle ones, and whether an idle one is running)
const paidAt = new WeakMap(); // card -> `changes` when an idle paint last drew it
function idleSoon(wait = SETTLE_MS) {
  clearTimeout(settleTimer);
  unidle(idleTask);
  idleTask = 0;
  if (!idleHeld) settleTimer = setTimeout(idleNext, wait);
}
function idleNext(timeout = 2000) {
  unidle(idleTask);
  idleTask = idle(() => {
    idleTask = 0;
    if (idleHeld || !owed.size) return;
    const card = owed.has(preferred) ? preferred : owed.keys().next().value;
    preferred = null;
    pay(card);
    if (owed.size) idleNext();
  }, timeout);
}
// A card's held paint, run now, the card left away
function pay(card) {
  const paint = owed.get(card);
  if (!paint) return;
  // (cards owing the same paint, as Top … View and Hours per week share the rolling chart's, are all paid by it)
  const paid = [...owed].filter(([, p]) => p === paint).map(([c]) => c);
  const were = paid.filter((c) => away.delete(c));
  for (const c of paid) owed.delete(c);
  idling = true;
  const start = performance.now();
  try {
    drawStill(paint); // (at once: no one sees it)
  } finally {
    idling = false;
  }
  hooks.perf?.("idle", card, start);
  for (const c of paid) settleNow(c);
  for (const c of were) away.add(c);
  for (const c of paid) paidAt.set(c, changes);
  for (const c of paid) owedChanged(c);
}
// Whatever a card drawn off screen still set moving (an ECharts option's own duration, a CSS transition) ends now,
// at its end: its elements' animations finish, and its charts' clocks run past each animation's end, so each ends
// as it would, its last frame drawn and its done called (zrender's clips, private API, on the pinned 5.6.0)
function settleNow(card) {
  for (const a of card.getAnimations({ subtree: true })) {
    try {
      a.finish();
    } catch {} // (an endless one can't)
  }
  for (const el of card.querySelectorAll("[_echarts_instance_]")) {
    const zr = echarts.getInstanceByDom(el)?.getZr(), clock = zr?.animation;
    if (!clock) continue;
    const now = performance.now();
    for (let clip = clock._head; clip; ) {
      const next = clip.next;
      if (!clip.loop && !clip._paused) {
        if (!clip._inited) clip.step(now, 0);
        if (clip.step(clip._startTime + clip._pausedTime + clip._life + 1, 0)) {
          clip.ondestroy?.();
          clock.removeClip(clip);
        }
      }
      clip = next;
    }
    zr.refresh();
  }
}
export function prefer(card) {
  if (!owed.has(card)) return;
  preferred = card;
  if (!idleHeld) {
    clearTimeout(settleTimer);
    idleNext(300);
  }
}
export function holdIdle(on) {
  idleHeld = on;
  if (on) {
    clearTimeout(settleTimer);
    unidle(idleTask);
    idleTask = 0;
  } else {
    if (owed.size) idleSoon();
    pumpSoon();
  }
}

// What a change leaves to draw, in order, a frame at a time: soon(key, paint, rank, wait) runs paint after wait ms,
// lower ranks first, as many a frame as fit in SOON_MS (at least one), each key once (a newer paint replaces its
// older one but keeps its place: its time and rank, if sooner, so asking again never puts one off), none mid-flight
// (holdIdle). The graph you're looking at draws in the change itself; then come the
// grid's thumbnails on screen (thumbs.js, rank 1), the open graph's neighbours (gallery.js paintRank, 2) and the
// thumbnails of the grid you'll go back to (3); the rest wait for idle moments, as above.
const SOON_MS = 8;
const soonQ = new Map(); // key -> { paint, rank, at }
let soonTimer = 0;
export function soon(key, paint, rank = 1, wait = 0) {
  const was = soonQ.get(key), at = performance.now() + wait;
  soonQ.set(key, { paint, rank: Math.min(rank, was?.rank ?? rank), at: Math.min(at, was?.at ?? at) });
  pumpSoon();
}
function pumpSoon() {
  if (soonTimer || idleHeld || !soonQ.size) return;
  let at = Infinity;
  for (const x of soonQ.values()) at = Math.min(at, x.at);
  // (just after a frame is drawn, so the frame's own work goes first)
  soonTimer = setTimeout(() => requestAnimationFrame(() => setTimeout(runSoon)), Math.max(0, at - performance.now()));
}
function runSoon() {
  soonTimer = 0;
  const start = performance.now();
  while (!idleHeld && performance.now() - start < SOON_MS) {
    const now = performance.now();
    let next = null;
    for (const [key, x] of soonQ) if (x.at <= now && (!next || x.rank < next[1].rank)) next = [key, x];
    if (!next) break;
    soonQ.delete(next[0]);
    next[1].paint();
    hooks.perf?.("soon", next[0], now, next[1].rank); // (perf.js, with ?perf)
  }
  pumpSoon();
}

// The page's last card: every item of the view (genres, artists, albums or tracks) over the period, by hours.
// Tracks over all time run to thousands, so the list is drawn a chunk at a time: the first on each repaint, and
// the next whenever the reader scrolls near its end (or presses "See more"). A repaint keeps as many rows as were
// shown, so the list morphs in place rather than collapsing under the reader. No pictures, so no lookups.
// Like the key's chips, hovering a row lights its item everywhere, and clicking it pins or unpins it.
import { $, state, noun, putOff, rangeTotals, chartColor } from "./state.js";
import { renderList, appendList } from "./lists.js";
import { focusArtist } from "./charts.js";
import { mixArgs, MAX_PINS } from "./rollingview.js";
import { hoursText } from "./format.js";

const CHUNK = 60;
const NEAR_PX = 600; // how far below the screen the next chunk starts loading
let ranked = []; // [item, ms, plays], most hours first
let shown = CHUNK;
let shownRaw = null, shownDim = null; // the data and view the shown count belongs to

// The chart picks its artists after the list is drawn, so the key's repaint recolors the rows already shown,
// and marks the pinned ones (the rows stay, so their outline fades in or out)
export function recolorRanking() {
  for (const li of $("ranking-list").children) {
    const c = chartColor(li._key);
    if (c) li.style.setProperty("--c", c);
    else li.style.removeProperty("--c");
  }
  markRows();
}

// Each row says what a click does: unpin it, pin it, or nothing while every pin is taken (as in the search)
function markRows(rows = $("ranking-list").children) {
  const full = state.pinned.length >= MAX_PINS;
  for (const li of rows) {
    const pinned = state.pinned.includes(li._key);
    li.classList.add("pinnable");
    li.classList.toggle("pinned", pinned);
    li.tabIndex = 0;
    li.setAttribute("role", "button");
    li.setAttribute("aria-pressed", pinned);
    li.toggleAttribute("aria-disabled", full && !pinned);
    const label = li.querySelector(".name");
    label._tip ??= label.title; // the name and detail, as makeRow put them
    const hint = pinned ? "Click to unpin" : full ? `${MAX_PINS} ${noun().many} pinned. Unpin one to add another` : "Click to pin";
    label.title = `${hint} · ${label._tip}`;
  }
}

// The item hovered anywhere on the page (the chart, the key, the mix) is shaded here too
export function focusRanking(name) {
  for (const li of $("ranking-list").children) li.classList.toggle("focus", name != null && li._key === name);
}

const rowOf = ([key, ms, plays]) => {
  const n = Math.round(plays);
  const count = `${n.toLocaleString()} play${n === 1 ? "" : "s"}`;
  const by = state.owner?.get(key);
  return {
    color: chartColor(key),
    key,
    name: state.titles?.get(key) ?? key,
    detail: by ? `${by} · ${count}` : count,
    value: hoursText(ms),
    frac: ms / (ranked[0]?.[1] || 1),
  };
};

// The period's items less the ones deselected in the chart (shownPlays), from the totals kept per period
export function paintRanking() {
  if (putOff($("ranking-card"), () => paintRanking())) return;
  const hidden = new Set(state.hidden);
  const ms = new Map(), count = new Map();
  for (const [k, e] of rangeTotals().items) {
    if (hidden.has(k)) continue;
    ms.set(k, e.ms);
    count.set(k, e.plays);
  }
  ranked = [...ms].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v, count.get(k)]);
  // Switching views or data starts the list over at its first chunk
  if (shownRaw !== state.raw || shownDim !== state.dim) {
    shownRaw = state.raw;
    shownDim = state.dim;
    shown = CHUNK;
  }
  const words = noun();
  $("ranking-title").textContent = `All your ${words.many}`;
  $("ranking-note").textContent = ranked.length
    ? `${ranked.length.toLocaleString()} ${ranked.length === 1 ? words.one : words.many} in this period, by hours played`
    : `No ${words.many} in this period`;
  const ol = $("ranking-list");
  ol.style.setProperty("--rank-w", `${String(ranked.length).length + 0.5}ch`);
  renderList(ol, ranked.slice(0, shown).map(rowOf));
  markRows();
  syncMore();
}

function more() {
  if (shown >= ranked.length) return;
  const start = Math.min(shown, $("ranking-list").children.length);
  shown += CHUNK;
  appendList($("ranking-list"), ranked.slice(start, shown).map(rowOf), start);
  markRows([...$("ranking-list").children].slice(start));
  syncMore();
  // The observer only speaks when the sentinel crosses its margin, so if a chunk didn't push it out, add another
  requestAnimationFrame(() => {
    if ($("ranking-sentinel").getBoundingClientRect().top < innerHeight + NEAR_PX && state.view === "you") more();
  });
}

function syncMore() {
  const left = ranked.length - shown;
  const btn = $("ranking-more");
  btn.hidden = left <= 0;
  btn.textContent = `See more (${left.toLocaleString()} left)`;
}

// Pinning goes through the chart's own pins, which repaint the key and so these rows (recolorRanking)
function toggle(li) {
  const pins = mixArgs?.[3];
  if (!pins || (!pins.has(li._key) && state.pinned.length >= MAX_PINS)) return;
  pins.toggle(li._key);
}

const list = $("ranking-list");
let hovered = null;
list.addEventListener("pointerover", (e) => {
  const li = e.target.closest("li");
  if (!li || li === hovered) return;
  hovered = li;
  focusArtist($("chart-rolling"), li._key); // an item outside the chart has nothing there to light
});
list.addEventListener("pointerleave", () => {
  hovered = null;
  focusArtist($("chart-rolling"), null);
});
list.addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (li) toggle(li);
});
list.addEventListener("keydown", (e) => {
  const li = e.target.closest("li");
  if (!li || (e.key !== "Enter" && e.key !== " ")) return;
  e.preventDefault();
  toggle(li);
});

$("ranking-more").addEventListener("click", more);
// The sentinel sits under the list: when it comes within a screen of view, the next chunk goes in
if ("IntersectionObserver" in window) {
  new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && state.plays && state.view === "you") more();
  }, { rootMargin: `0px 0px ${NEAR_PX}px 0px` }).observe($("ranking-sentinel"));
}

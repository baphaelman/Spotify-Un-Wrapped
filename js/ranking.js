// The page's last card: every item of the view (genres, artists, albums or tracks) over the period, by hours.
// Tracks over all time run to thousands, so the list is drawn a chunk at a time: the first on each repaint, and
// the next whenever the reader scrolls near its end (or presses "See more"). A repaint keeps as many rows as were
// shown, so the list morphs in place rather than collapsing under the reader. No pictures, so no lookups.
import { $, state, noun, shownPlays } from "./state.js";
import { renderList, appendList } from "./lists.js";

const CHUNK = 60;
const NEAR_PX = 600; // how far below the screen the next chunk starts loading
let ranked = []; // [item, ms, plays], most hours first
let shown = CHUNK;
let shownRaw = null, shownDim = null; // the data and view the shown count belongs to

const hoursText = (ms) => {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  return h < 10 ? `${h.toFixed(1)} h` : `${Math.round(h).toLocaleString()} h`;
};

const rowOf = ([key, ms, plays]) => {
  const n = Math.round(plays);
  const count = `${n.toLocaleString()} play${n === 1 ? "" : "s"}`;
  const by = state.owner?.get(key);
  return {
    key,
    name: state.titles?.get(key) ?? key,
    detail: by ? `${by} · ${count}` : count,
    value: hoursText(ms),
    frac: ms / (ranked[0]?.[1] || 1),
  };
};

export function paintRanking(plays = shownPlays()) {
  const ms = new Map(), count = new Map();
  for (const p of plays) {
    ms.set(p.artist, (ms.get(p.artist) ?? 0) + p.ms);
    count.set(p.artist, (count.get(p.artist) ?? 0) + (p.w ?? 1));
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
  syncMore();
}

function more() {
  if (shown >= ranked.length) return;
  const start = Math.min(shown, $("ranking-list").children.length);
  shown += CHUNK;
  appendList($("ranking-list"), ranked.slice(start, shown).map(rowOf), start);
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

$("ranking-more").addEventListener("click", more);
// The sentinel sits under the list: when it comes within a screen of view, the next chunk goes in
if ("IntersectionObserver" in window) {
  new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && state.plays && state.view === "you") more();
  }, { rootMargin: `0px 0px ${NEAR_PX}px 0px` }).observe($("ranking-sentinel"));
}

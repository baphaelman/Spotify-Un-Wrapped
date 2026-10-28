// Community page: pooled aggregates from Supabase, compared against the viewer's own data when loaded.
import * as api from "./api.js";
import * as agg from "./aggregate.js";
import { renderHistogram, renderHourLines } from "./charts.js";
import { renderList, renderTiles } from "./lists.js";

const $ = (id) => document.getElementById(id);

// Share of values strictly below x, 0..1
const below = (sorted, x) => sorted.filter((v) => v < x).length / sorted.length;
const topPct = (frac) => `Top ${Math.max(1, Math.round((1 - frac) * 100))}%`;

// 168-slot clock (weekday * 24 + hour) -> 24 hour-of-day shares summing to 1
function byHour(clock168) {
  const out = new Array(24).fill(0);
  clock168.forEach((v, i) => (out[i % 24] += v));
  const total = out.reduce((a, b) => a + b, 0) || 1;
  return out.map((v) => v / total);
}

export async function renderCommunity(plays) {
  $("community-status").textContent = "Loading community stats…";
  $("community-status").classList.remove("error");
  let stats;
  try {
    stats = await api.communityStats();
  } catch (err) {
    console.error(err);
    $("community-status").textContent = `Couldn't load community stats: ${err.message}`;
    $("community-status").classList.add("error");
    return;
  }
  $("community-status").textContent = "";

  const n = stats.contributors;
  if (n < stats.minCrowd) {
    $("community-body").hidden = true;
    $("community-empty").hidden = false;
    $("community-empty").textContent =
      `${n} ${n === 1 ? "person has" : "people have"} shared so far. ` +
      `Community charts appear once ${stats.minCrowd} people have shared, so no one's listening can be singled out.`;
    return;
  }
  $("community-empty").hidden = true;
  $("community-body").hidden = false;

  const mine = plays ? agg.summary(plays) : null;
  const myTop = plays ? agg.topArtists(plays, 500) : [];
  const myArtists = new Set(myTop.map((a) => a.name));
  const myTracks = plays ? new Set(agg.topTracks(plays, 500).map((t) => t.name + "\u0000" + t.artist)) : new Set();
  const ranks = plays ? await api.artistRanks(myTop.slice(0, 50)).catch(() => []) : [];

  // Hours-weighted share of contributors who also listen to your top 50 artists
  let mainstream = null;
  if (ranks.length) {
    const weight = myTop.slice(0, ranks.length).reduce((s, a) => s + a.hours, 0);
    mainstream = ranks.reduce((s, r, i) => s + ((r.listeners ?? 0) / n) * myTop[i].hours, 0) / (weight || 1);
  }

  const tiles = [
    { label: "Contributors", value: n.toLocaleString(), sub: `${Math.round(stats.totalHours).toLocaleString()} hours pooled`, hero: true },
  ];
  if (mine) {
    const hrs = below(stats.hours, mine.hours);
    const variety = below(stats.artistCounts, mine.artists);
    tiles.push(
      { label: "Your listening time", value: topPct(hrs), sub: `more hours than ${Math.round(hrs * n)} of ${n} people` },
      { label: "Your variety", value: topPct(variety), sub: `${mine.artists.toLocaleString()} artists, more than ${Math.round(variety * n)} of ${n} people` },
      { label: "Mainstream score", value: `${Math.round(mainstream * 100)}`, sub: "share of people who know your artists" }
    );
  } else {
    tiles.push({ label: "Compare yourself", value: "—", sub: "Load your data on Your stats" });
  }
  renderTiles($("community-stats"), tiles);

  $("hist-sub").textContent = mine
    ? "Contributors by total hours listened. The blue line is you"
    : "Contributors by total hours listened";
  renderHistogram($("chart-hist"), stats.hours, mine?.hours);

  $("fan-card").hidden = !plays;
  if (plays) {
    renderList(
      $("fan-ranks"),
      ranks.slice(0, 10).map((r, i) =>
        r.listeners
          ? {
              name: r.artist,
              detail: `${r.listeners} listeners · ${Math.round(myTop[i].hours)} h`,
              value: topPct(1 - r.above / r.listeners) + " of fans",
              frac: 1 - r.above / r.listeners,
            }
          : { name: r.artist, detail: `${Math.round(myTop[i].hours)} h`, value: `Fewer than ${stats.minCrowd} listeners`, frac: 0, muted: true }
      )
    );
  }

  renderHourLines($("chart-hours"), byHour(stats.clock), plays ? byHour(agg.clock(plays).flat()) : null);

  renderList(
    $("community-artists"),
    stats.topArtists.slice(0, 15).map((a) => ({
      name: a.artist,
      detail: `${a.hours.toLocaleString()} h total`,
      value: `${a.listeners} listeners`,
      frac: a.listeners / n,
      tag: myArtists.has(a.artist) ? "you" : null,
    }))
  );
  renderList(
    $("community-tracks"),
    stats.topTracks.slice(0, 15).map((t) => ({
      name: t.track,
      detail: t.artist,
      value: `${t.listeners} listeners`,
      frac: t.listeners / n,
      tag: myTracks.has(t.track + "\u0000" + t.artist) ? "you" : null,
    }))
  );
}

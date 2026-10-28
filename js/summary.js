// The only thing that ever leaves the browser: a small aggregate of a user's listening.
import * as agg from "./aggregate.js";

const MAX_ITEMS = 500;
const MAX_NAME = 300;
const round = (h) => Math.round(h * 100) / 100;

export function buildSummary(plays) {
  const s = agg.summary(plays);
  const clip = (str) => str.slice(0, MAX_NAME);

  // Dedupe after clipping so the server's (name) / (track, artist) keys stay unique
  const artists = new Map();
  for (const a of agg.topArtists(plays, MAX_ITEMS)) {
    const k = clip(a.name);
    artists.set(k, (artists.get(k) || 0) + a.hours);
  }
  const tracks = new Map();
  for (const t of agg.topTracks(plays, MAX_ITEMS)) {
    const k = clip(t.name) + "\u0000" + clip(t.artist);
    tracks.set(k, (tracks.get(k) || 0) + t.hours);
  }

  return {
    v: 1,
    hours: round(s.hours),
    plays: s.plays,
    activeDays: s.activeDays,
    artistsCount: s.artists,
    tracksCount: s.tracks,
    clock: agg.clock(plays).flat().map(round),
    artists: [...artists].map(([name, h]) => [name, round(h)]),
    tracks: [...tracks].map(([k, h]) => [...k.split("\u0000"), round(h)]),
  };
}

// Stable per-person key: re-uploading the same (or a newer) export yields the same key,
// because Spotify history always starts at the same first plays.
export async function submissionKey(plays) {
  const text = plays.slice(0, 200).map((p) => `${p.t}|${p.ms}|${p.track}|${p.artist}`).join("\n");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

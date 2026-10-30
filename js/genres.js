// Each artist's genres, for the Genres view (docs/genres.md). Our Supabase function (supabase/functions/genres)
// answers from a table every visitor shares, and looks up what it doesn't know yet on MusicBrainz (else Last.fm),
// a few artists a request, so a name nobody has asked about comes back "pending" and is asked again shortly.
// Never Spotify. An answer is [[genre, votes], ...], most votes first, or [] when nothing knows the artist.
// Answers are remembered on this device; only artist names and one track title each are sent.

import { SUPABASE_URL } from "./config.js";

const STORE = "unwrapped-genres";
const ENDPOINT = `${SUPABASE_URL}/functions/v1/genres`;
const BATCH = 100; // names a request, the function's limit
const AGAIN_MS = 2000; // before asking about pending names again
// The artists worth asking about: the most listened, until they hold this much of the listening, up to MAX_ARTISTS.
// The long tail past them shows as unclassified.
const COVER = 0.97;
const MAX_ARTISTS = 2000;
// Requests that failed in a row before this visit stops asking (offline, or the function isn't deployed)
const GIVE_UP_AFTER = 3;

let known = new Map(); // artist -> [[genre, votes], ...]
try {
  known = new Map(Object.entries(JSON.parse(localStorage.getItem(STORE)) ?? {}));
} catch {}

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify(Object.fromEntries(known)));
    } catch {}
  }, 500);
}

export const genresOf = (artist) => known.get(artist);

// Grows whenever answers arrive, so a view built from them knows to build again
export let genresVersion = 0;

// The artists to look up in some plays, most listened first, each with its most-played track title (it tells
// artists who share a name apart)
function wanted(raw) {
  const ms = new Map(), tracks = new Map();
  let total = 0;
  for (const p of raw) {
    total += p.ms;
    ms.set(p.artist, (ms.get(p.artist) ?? 0) + p.ms);
    if (!tracks.has(p.artist)) tracks.set(p.artist, new Map());
    const t = tracks.get(p.artist);
    t.set(p.track, (t.get(p.track) ?? 0) + p.ms);
  }
  const out = [];
  let sum = 0;
  for (const [name, m] of [...ms].sort((a, b) => b[1] - a[1])) {
    if (sum >= COVER * total || out.length >= MAX_ARTISTS) break;
    sum += m;
    const track = [...tracks.get(name)].sort((a, b) => b[1] - a[1])[0]?.[0];
    out.push(track ? { name, track } : { name });
  }
  return out;
}

let asking = null; // the plays being asked about, so a second call doesn't start a second round

// Asks about the artists in `raw` this device doesn't know yet, a batch at a time, and calls onChange after each
// batch that brought answers. Returns once there's nothing left to ask (or asking failed).
export async function askGenres(raw, onChange) {
  if (asking === raw) return;
  asking = raw;
  let todo = wanted(raw).filter((a) => !known.has(a.name));
  let failures = 0;
  while (todo.length && asking === raw && failures < GIVE_UP_AFTER) {
    const batch = todo.slice(0, BATCH);
    let answer;
    try {
      const r = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artists: batch }),
      });
      if (!r.ok) throw new Error(r.status);
      answer = await r.json();
      failures = 0;
    } catch (err) {
      failures++;
      await new Promise((go) => setTimeout(go, AGAIN_MS * failures));
      continue;
    }
    const got = Object.entries(answer.genres ?? {});
    for (const [name, genres] of got) known.set(name, genres);
    if (got.length) {
      genresVersion++;
      save();
      onChange?.();
    }
    // The pending ones go to the back, so the next request starts with names the table may already have
    const pending = new Set(answer.pending ?? []);
    todo = [...todo.slice(BATCH), ...batch.filter((a) => pending.has(a.name) && !known.has(a.name))];
    if (pending.size) await new Promise((go) => setTimeout(go, AGAIN_MS));
  }
  if (asking === raw) asking = null;
}

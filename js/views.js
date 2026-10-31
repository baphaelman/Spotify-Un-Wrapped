// The plays as each view sees them. Every view is the same page over the plays keyed another way (see state.js):
// `keyedPlays(dim)` returns them with what the view needs to name and picture its items, worked out once per view
// and kept until the plays (or, for genres, the genres known) change:
//   plays: the plays, with the view's item in `artist` (and the real artist in `by`)
//   owner: item -> its artist (tracks and albums), title: item -> its own name without the artist,
//   album: track -> the album it was played from most, cover: item -> what covers.js looks its picture up by
import { state } from "./state.js";
import { genresOf, genresVersion } from "./genres.js";
import { artistFamilies } from "./families.js";

const memo = new Map();

// Up to five of an item's track IDs, most played first: the picture lookup tries them in turn (covers.js)
const PICTURE_TRACKS = 5;
const countId = (ids, id) => id && ids.set(id, (ids.get(id) ?? 0) + 1);
const topIds = (ids) => [...ids].sort((a, b) => b[1] - a[1]).slice(0, PICTURE_TRACKS).map(([id]) => id);

export function keyedPlays(dim) {
  const kept = memo.get(dim);
  if (kept?.raw === state.raw && kept.version === (dim === "genre" ? genresVersion : undefined)) return kept;
  const out = dim === "artist" ? artistPlays() : dim === "genre" ? genrePlays() : namedPlays(dim);
  memo.set(dim, out);
  return out;
}

// The artists view: the plays as loaded. An artist's photo is found through their most-played tracks
function artistPlays() {
  const ids = new Map();
  for (const p of state.raw) {
    if (!ids.has(p.artist)) ids.set(p.artist, new Map());
    countId(ids.get(p.artist), p.id);
  }
  const cover = new Map([...ids].map(([name, m]) => [name, { kind: "artist", name, ids: topIds(m) }]));
  return { raw: state.raw, plays: state.raw, owner: null, title: null, album: null, cover };
}

// The tracks and albums views. A track or album is called by its name, with its artist after it where more than
// one artist has that name (an "Intro", a "Greatest Hits")
const nameOfIn = (dim) => (dim === "track" ? (p) => p.track : (p) => p.album || "Unknown album");
// What the tracks or albums view (dim) calls a play's track or album: (name, artist) -> key. Kept per loaded plays.
const keysMemo = new Map();
function viewKeys(dim) {
  const kept = keysMemo.get(dim);
  if (kept?.raw === state.raw) return kept.keyOf;
  const nameOf = nameOfIn(dim);
  const artistsOf = new Map();
  for (const p of state.raw) {
    const n = nameOf(p);
    if (!artistsOf.has(n)) artistsOf.set(n, new Set());
    artistsOf.get(n).add(p.artist);
  }
  const keyOf = (n, artist) => (artistsOf.get(n).size > 1 || n === "Everyone else" ? `${n} · ${artist}` : n);
  keysMemo.set(dim, { raw: state.raw, keyOf });
  return keyOf;
}

function namedPlays(dim) {
  const nameOf = nameOfIn(dim);
  const keyOf = viewKeys(dim);
  const keys = new Map(); // name + artist -> what the view calls it
  const owner = new Map(); // what the view calls it -> artist
  const title = new Map(); // what the view calls it -> its own name, without the artist
  const albums = new Map(); // what the view calls it -> album -> { n: plays from it, ids: its track IDs -> plays }
  const plays = state.raw.map((p) => {
    const n = nameOf(p), id = n + "\u0000" + p.artist;
    let key = keys.get(id);
    if (key === undefined) {
      key = keyOf(n, p.artist);
      keys.set(id, key);
      owner.set(key, p.artist);
      title.set(key, n);
      albums.set(key, new Map());
    }
    const on = albums.get(key), a = on.get(p.album) ?? { n: 0, ids: new Map() };
    a.n++;
    countId(a.ids, p.id);
    on.set(p.album, a);
    return { ...p, artist: key, by: p.artist };
  });
  // A track on several albums (a single, then the album) is called by the one it was played from most, and
  // shows that album's cover, found through its tracks (data saved before IDs were kept has none)
  const most = new Map([...albums].map(([k, m]) => [k, [...m].sort((a, b) => b[1].n - a[1].n)[0]]));
  const album = dim === "track" ? new Map([...most].map(([k, [name]]) => [k, name || undefined])) : null;
  // No album, no cover
  const cover = new Map([...most].map(([k, [name, a]]) => [k, name ? { kind: "album", name: owner.get(k), album: name, ids: topIds(a.ids) } : undefined]));
  return { raw: state.raw, plays, owner, title, album, cover };
}

// The genres view: each play goes to its artist's genre families (families.js), shared by their weight, so an
// artist who is both rock and electronic counts a part of each play in each (`ms` times the weight, and the weight
// in `w`, which counts plays). The artist stays in `by`, which the chart splits a genre's band by, and its track and
// album also come as the tracks and albums views call them (`trackKey`, `albumKey`), so a genre's band splits into
// albums or songs told apart by artist, and a part clicked opens as itself in its own view. Artists with no
// genre (yet) are left out, so no graph, list, key or search has them. A genre's picture is its most-played artist's
// photo, from the artists view.
function genrePlays() {
  const families = new Map(); // artist -> [[family, weight], ...]
  const top = new Map(); // family -> artist -> ms
  const plays = [];
  const trackOf = viewKeys("track"), albumOf = viewKeys("album");
  for (const raw of state.raw) {
    let fams = families.get(raw.artist);
    if (!fams) {
      fams = artistFamilies(genresOf(raw.artist) ?? []);
      families.set(raw.artist, fams);
    }
    if (!fams.length) continue;
    const trackKey = trackOf(raw.track, raw.artist), albumKey = albumOf(raw.album || "Unknown album", raw.artist);
    for (const [family, w] of fams) {
      const p = { ...raw, artist: family, by: raw.artist, trackKey, albumKey };
      plays.push(w === 1 ? p : { ...p, ms: raw.ms * w, w });
      if (!top.has(family)) top.set(family, new Map());
      const m = top.get(family);
      m.set(raw.artist, (m.get(raw.artist) ?? 0) + raw.ms * w);
    }
  }
  const artistCovers = keyedPlays("artist").cover;
  const cover = new Map([...top].map(([family, m]) => [family, artistCovers.get([...m].sort((a, b) => b[1] - a[1])[0][0])]));
  return { raw: state.raw, version: genresVersion, plays, owner: null, title: null, album: null, cover };
}

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
function namedPlays(dim) {
  const nameOf = dim === "track" ? (p) => p.track : (p) => p.album || "Unknown album";
  const artistsOf = new Map();
  for (const p of state.raw) {
    const n = nameOf(p);
    if (!artistsOf.has(n)) artistsOf.set(n, new Set());
    artistsOf.get(n).add(p.artist);
  }
  const keys = new Map(); // name + artist -> what the view calls it
  const owner = new Map(); // what the view calls it -> artist
  const title = new Map(); // what the view calls it -> its own name, without the artist
  const albums = new Map(); // what the view calls it -> album -> { n: plays from it, ids: its track IDs -> plays }
  const plays = state.raw.map((p) => {
    const n = nameOf(p), id = n + "\u0000" + p.artist;
    let key = keys.get(id);
    if (key === undefined) {
      key = artistsOf.get(n).size > 1 || n === "Everyone else" ? `${n} · ${p.artist}` : n;
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
// in `w`, which counts plays). The artist stays in `by`, which the chart splits a genre's band by. Artists with no
// genre (yet) are left out, so no graph, list, key or search has them. A genre's picture is its most-played artist's
// photo, from the artists view.
function genrePlays() {
  const families = new Map(); // artist -> [[family, weight], ...]
  const top = new Map(); // family -> artist -> ms
  const plays = [];
  for (const p of state.raw) {
    let fams = families.get(p.artist);
    if (!fams) {
      fams = artistFamilies(genresOf(p.artist) ?? []);
      families.set(p.artist, fams);
    }
    for (const [family, w] of fams) {
      plays.push(w === 1 ? { ...p, artist: family, by: p.artist } : { ...p, artist: family, by: p.artist, ms: p.ms * w, w });
      if (!top.has(family)) top.set(family, new Map());
      const m = top.get(family);
      m.set(p.artist, (m.get(p.artist) ?? 0) + p.ms * w);
    }
  }
  const artistCovers = keyedPlays("artist").cover;
  const cover = new Map([...top].map(([family, m]) => [family, artistCovers.get([...m].sort((a, b) => b[1] - a[1])[0][0])]));
  return { raw: state.raw, version: genresVersion, plays, owner: null, title: null, album: null, cover };
}

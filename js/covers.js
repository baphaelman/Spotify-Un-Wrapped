// Pictures for the listening mix's key, looked up by a track's ID (from the extended export's spotify_track_uri):
//   "<track id>"         its album's cover, from Spotify's public oEmbed endpoint (no key, open to any site)
//   "artist:<track id>"  its artist's photo, from our Supabase function (supabase/functions/artist-image), since
//                        the export doesn't identify artists and oEmbed only knows the track
// Each is asked for once: the answer, a URL or "" for none, is remembered on this device, and the image itself
// sits in the browser's cache. Only track IDs are sent, never any listening history.

import { SUPABASE_URL } from "./config.js";

const STORE = "unwrapped-covers";
const AT_ONCE = 4; // lookups in flight at a time

let known = new Map(); // key -> picture URL, or "" when there's none
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

// Where each kind of key is asked, and the URL in its answer
const SOURCES = {
  album: { url: (id) => `https://open.spotify.com/oembed?url=spotify:track:${encodeURIComponent(id)}`, pick: (j) => j.thumbnail_url },
  artist: { url: (id) => `${SUPABASE_URL}/functions/v1/artist-image?track=${encodeURIComponent(id)}`, pick: (j) => j.image },
};
const kindOf = (key) => (key.startsWith("artist:") ? ["artist", key.slice(7)] : ["album", key]);

const pending = new Map(); // key -> promise of its picture
const queue = [];
let running = 0;
const refused = new Set(); // sources that turned a lookup away (offline, rate limited): no more asking this visit

function pump() {
  while (running < AT_ONCE && queue.length) {
    const { key, resolve } = queue.shift();
    const [kind, id] = kindOf(key);
    if (refused.has(kind)) {
      pending.delete(key);
      resolve("");
      continue;
    }
    running++;
    fetch(SOURCES[kind].url(id))
      .then((r) => (r.ok ? r.json() : r.status === 404 ? {} : Promise.reject(r.status)))
      .then((j) => {
        known.set(key, SOURCES[kind].pick(j) ?? "");
        save();
        resolve(known.get(key));
      })
      // A failed lookup isn't remembered, so a later visit tries again
      .catch(() => {
        refused.add(kind);
        resolve("");
      })
      .finally(() => {
        pending.delete(key);
        running--;
        pump();
      });
  }
}

// The picture URL for a key, "" when there's none. Remembered answers come back at once. `soon`: it's on
// screen, so it goes ahead of the idle warm-up (main.js warmCovers)
export function coverFor(key, { soon = false } = {}) {
  if (!key) return Promise.resolve("");
  if (known.has(key)) return Promise.resolve(known.get(key));
  if (!pending.has(key)) {
    pending.set(key, new Promise((resolve) => {
      queue.push({ key, resolve });
      pump();
    }));
  }
  if (soon) {
    const i = queue.findIndex((q) => q.key === key);
    if (i > 0) queue.unshift(...queue.splice(i, 1));
  }
  return pending.get(key);
}

// The picture URL if it's already known, without asking
export const knownCover = (key) => known.get(key);

export function forgetCovers() {
  known.clear();
  try {
    localStorage.removeItem(STORE);
  } catch {}
}

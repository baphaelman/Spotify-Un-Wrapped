// Album covers for the Tracks and Albums views, from Spotify's public oEmbed endpoint (no key, open to any site).
// A cover is looked up by a track's ID (from the extended export's spotify_track_uri), once: the answer, a cover
// URL or "" for none, is remembered on this device, and the image itself sits in the browser's cache.
// Only track IDs are sent, never any listening history.

const STORE = "unwrapped-covers";
const AT_ONCE = 4; // lookups in flight at a time

let known = new Map(); // track ID -> cover URL, or "" when Spotify had none
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

const pending = new Map(); // track ID -> promise of its cover
const queue = [];
let running = 0;
let refused = false; // Spotify turned a lookup away (offline, rate limited): no more asking this visit

function pump() {
  while (running < AT_ONCE && queue.length) {
    const { id, resolve } = queue.shift();
    if (refused) {
      pending.delete(id);
      resolve("");
      continue;
    }
    running++;
    fetch(`https://open.spotify.com/oembed?url=spotify:track:${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : r.status === 404 ? {} : Promise.reject(r.status)))
      .then((j) => {
        known.set(id, j.thumbnail_url ?? "");
        save();
        resolve(known.get(id));
      })
      // A failed lookup isn't remembered, so a later visit tries again
      .catch(() => {
        refused = true;
        resolve("");
      })
      .finally(() => {
        pending.delete(id);
        running--;
        pump();
      });
  }
}

// The cover URL for a track ID, "" when there's none. Remembered answers come back at once. `soon`: it's on
// screen, so it goes ahead of the idle warm-up (main.js warmCovers)
export function coverFor(id, { soon = false } = {}) {
  if (!id) return Promise.resolve("");
  if (known.has(id)) return Promise.resolve(known.get(id));
  if (!pending.has(id)) {
    pending.set(id, new Promise((resolve) => {
      queue.push({ id, resolve });
      pump();
    }));
  }
  if (soon) {
    const i = queue.findIndex((q) => q.id === id);
    if (i > 0) queue.unshift(...queue.splice(i, 1));
  }
  return pending.get(id);
}

// The cover URL if it's already known, without asking
export const knownCover = (id) => known.get(id);

export function forgetCovers() {
  known.clear();
  try {
    localStorage.removeItem(STORE);
  } catch {}
}

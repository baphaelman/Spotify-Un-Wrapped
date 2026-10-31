// Pictures for the listening mix's key: an artist's photo, or an album's cover (a track shows its album's).
// The export identifies tracks only (spotify_track_uri, kept by parse.js as `id`), so an item is described by
//   { kind: "artist" | "album", name: its artist, album?: its title, ids: up to five of its most-played track IDs }
// and our Supabase function (supabase/functions/artist-image, deployed as smooth-endpoint) asks Spotify's Web API
// about those tracks: what was asked for through each in turn, then by name, then the other kind (an artist's
// album cover, an album's artist), skipping Spotify's blank placeholders.
// The function keeps every answer for everyone, so Spotify is asked about each picture once, ever; one it can't
// look up yet (the shared allowance is spent) is queued there and asked about again here after a wait.
// A found picture's URL is also remembered on this device, and the image itself sits in the browser's cache. Only track IDs and the artist's name are sent, never any listening history.

import { SUPABASE_URL } from "./config.js";

const STORE = "unwrapped-pictures";
const AT_ONCE = 4; // lookups in flight at a time
const ENDPOINT = `${SUPABASE_URL}/functions/v1/smooth-endpoint`;

const keyOf = (p) => `${p.kind}:${p.ids[0]}`;

let known = new Map(); // key -> picture URL, or "" when there's none (this visit only: a later one asks again)
try {
  known = new Map(Object.entries(JSON.parse(localStorage.getItem(STORE)) ?? {}).filter(([, url]) => url));
  localStorage.removeItem("unwrapped-covers"); // the first version's answers, without the fallbacks
} catch {}

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify(Object.fromEntries([...known].filter(([, url]) => url))));
    } catch {}
  }, 500);
}

const pending = new Map(); // key -> promise of its picture
const queue = [];
let running = 0;
// Lookups that failed in a row: one can be a hiccup, but after a few (offline, Spotify down) there's no more asking
// this visit
let failures = 0;
const GIVE_UP_AFTER = 3;
// Spotify's rate limit, passed on by the function as 503 + how long to wait: lookups hold until then, unless the
// wait is long, when this visit stops asking
let heldUntil = 0;
const LONGEST_WAIT_S = 120;
// A picture the function has queued is asked about again after the wait it gives, this many times a visit at most
const PENDING_TRIES = 10;

function pump() {
  const hold = heldUntil - Date.now();
  if (hold > 0) return void setTimeout(pump, hold);
  while (running < AT_ONCE && queue.length) {
    const item = queue.shift();
    const { p, key, resolve } = item;
    if (failures >= GIVE_UP_AFTER) {
      pending.delete(key);
      resolve("");
      continue;
    }
    running++;
    let again = false;
    const q = new URLSearchParams({ kind: p.kind, name: p.name ?? "", album: p.album ?? "", tracks: p.ids.join(","), track: p.ids[0] });
    fetch(`${ENDPOINT}?${q}`)
      .then(async (r) => {
        if (r.status === 503) {
          const wait = (await r.json().catch(() => ({}))).wait ?? 30;
          if (wait > LONGEST_WAIT_S) throw new Error("busy");
          heldUntil = Math.max(heldUntil, Date.now() + wait * 1000);
          queue.unshift(item); // asked again once the wait is over
          again = true;
          return;
        }
        // Queued: this minute's allowance (shared by every visitor) is spent, so ask again once it's back
        if (r.status === 202) {
          const wait = (await r.json().catch(() => ({}))).wait ?? 30;
          if (++item.tries > PENDING_TRIES) return resolve("");
          again = true;
          setTimeout(() => {
            queue.push(item);
            pump();
          }, Math.min(Math.max(wait, 5), 60) * 1000);
          return;
        }
        if (!r.ok) throw new Error(r.status);
        const j = await r.json();
        failures = 0;
        // An older deployment answers every question with an artist's photo and no `from`: it isn't an album's cover
        if (!("from" in j) && p.kind !== "artist") return resolve("");
        known.set(key, j.image ?? "");
        save();
        resolve(known.get(key));
      })
      // A failed lookup isn't remembered, so a later visit tries again
      .catch((err) => {
        failures = err.message === "busy" ? GIVE_UP_AFTER : failures + 1;
        resolve("");
      })
      .finally(() => {
        if (!again) pending.delete(key);
        running--;
        pump();
      });
  }
}

// The picture URL for an item, "" when there's none. Remembered answers come back at once. `soon`: it's on
// screen, so it goes ahead of any asked for earlier that have since scrolled or slid away
export function coverFor(p, { soon = false } = {}) {
  if (!p?.ids.length) return Promise.resolve("");
  const key = keyOf(p);
  if (known.has(key)) return Promise.resolve(known.get(key));
  if (!pending.has(key)) {
    pending.set(key, new Promise((resolve) => {
      queue.push({ p, key, resolve, tries: 0 });
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
export const knownCover = (p) => (p?.ids.length ? known.get(keyOf(p)) : undefined);

export function forgetCovers() {
  known.clear();
  try {
    localStorage.removeItem(STORE);
  } catch {}
}

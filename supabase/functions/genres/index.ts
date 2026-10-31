// Genres for the Genres view (js/genres.js; the plan is docs/genres.md). The export names artists but has no
// genres, and Spotify no longer gives them out, so they come from MusicBrainz (Last.fm as a fallback) and are kept
// for everyone in the table public.artist_genres (supabase/schema.sql), so each artist is looked up once.
//   POST { "artists": [{ "name": "<as the export spells it>", "track": "<one of their most-played titles>" }, ...],
//          "offset": <where this list starts in the page's whole list> }
// Up to 100 artists; `track` is optional and only settles a name several artists share. Answer:
//   { "genres": { "<name>": [["<genre>", <votes>], ...], ... }, "pending": ["<name>", ...] }
// `genres` has every name that's known, most votes first (an empty list when it was looked up and nothing was
// found); `pending` has the names not looked up yet. Those go on the queue (public.genre_queue), in the order given,
// and the page asks about them again a little later.
// The same function works through the queue: pg_cron posts to it once a minute with the header x-worker-key (the
// secret GENRES_WORKER_KEY), and it looks names up for about 50 s, paced to MusicBrainz's one request a second. Only
// the worker calls MusicBrainz, so visitors asking at once can't go over that limit together, and every name asked
// about is looked up even after its visitor has left.
// The matching rules are mirrored in dev/genre_coverage.py, which measures them on a real history; keep the two in
// step. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided to every function. LASTFM_API_KEY (a function
// secret) turns the Last.fm fallback on. Deployed as "genres", with JWT verification off: it's open, and holds
// nothing private.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const MAX_ARTISTS = 100;
const WORK_MS = 50_000; // a worker run looks up for this long, so runs a minute apart don't overlap
const LOOKUP_MS = 5_000; // the most one lookup can take (three paced MusicBrainz calls and Last.fm), kept in hand
const CLAIM = 5; // names a worker takes at a time, so few are left claimed when its time runs out
const MAX_ATTEMPTS = 5; // failed lookups before a name is stored as found nowhere
const NONE_STALE_MS = 30 * 86_400_000; // a "nothing found" is asked again after 30 days

type Genres = [string, number][];
type Row = { name_key: string; name: string; mbid: string | null; genres: Genres; source: "musicbrainz" | "lastfm" | "none"; fetched_at: string };

// The table's key: NFKD, accents dropped, lowercase, "&" as "and", then only letters and digits in any script
// ("DJ小女孩" keeps its CJK). A name of only punctuation ("!!!") keeps its own lowercase spelling.
const norm = (s: string) =>
  s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/&/g, "and").replace(/[^\p{L}\p{N}]/gu, "");
const keyOf = (name: string) => norm(name) || name.trim().toLowerCase();

// ---- MusicBrainz ----

const MB = "https://musicbrainz.org/ws/2";
const UA = "SpotifyUnwrapped/0.1 (https://baphaelman.github.io/Spotify-Un-Wrapped/)";
const GAP_MS = 1100; // its limit is one request a second per IP

// Over its limit (a 503): this call stops looking up, and so do others on this instance for a little while
class Busy extends Error {}
let busyUntil = 0;

// Every MusicBrainz call on this instance goes through one queue, so calls from requests answered at the same
// time are still paced
let queue: Promise<unknown> = Promise.resolve();
let lastCall = 0;
function mb(path: string): Promise<any> {
  const run = async () => {
    if (Date.now() < busyUntil) throw new Busy("MusicBrainz asked us to slow down");
    const wait = lastCall + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    const r = await fetch(`${MB}/${path}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status === 503) {
      busyUntil = Date.now() + 10_000;
      throw new Busy(`MusicBrainz 503 on ${path}`);
    }
    if (!r.ok) throw new Error(`MusicBrainz ${path} ${r.status}`);
    return path.includes("fmt=txt") ? r.text() : r.json();
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

// MusicBrainz's curated genre list (about 2,200), fetched once per instance. Only tags on it count as genres, for
// both sources, so "british" or "seen live" never do.
let genreList: Promise<Set<string>> | null = null;
function genreSet(): Promise<Set<string>> {
  genreList ??= mb("genre/all?fmt=txt")
    .then((t: string) => new Set(t.split("\n").map((g) => g.trim()).filter(Boolean)))
    .catch((err) => {
      genreList = null;
      throw err;
    });
  return genreList;
}

// A quoted Lucene phrase: inside quotes only the quote and the backslash need escaping
const phrase = (s: string) => `"${s.replace(/["\\]/g, "\\$&")}"`;

// A track title as MusicBrainz is likely to spell it: no " - Remastered 2011", no "(feat. X)"
const cleanTrack = (t: string) =>
  t.split(/\s+-\s+/)[0].replace(/\s*[(\[](feat|ft|with|prod)\.?\s[^)\]]*[)\]]/gi, "").trim();

type Tag = { name: string; count: number };
type MbArtist = { id: string; name: string; aliases?: { name: string }[]; tags?: Tag[] };

const votes = (a: MbArtist) => (a.tags ?? []).reduce((n, t) => n + Math.max(0, t.count), 0);

const mbGenres = (tags: Tag[] = [], genres: Set<string>): Genres =>
  tags
    .filter((t) => genres.has(t.name) && t.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((t): [string, number] => [t.name, t.count]);

// The artist the export means by `name`, or null
async function findArtist(name: string, track: string): Promise<MbArtist | null> {
  const key = keyOf(name);
  // 1. An unfielded quoted search, which looks in names and aliases too: a fielded artist:"Kanye West" misses him,
  //    since MusicBrainz names him "Ye" with "Kanye West" as an alias
  const found: MbArtist[] = (await mb(`artist/?${new URLSearchParams({ query: phrase(name), limit: "25", fmt: "json" })}`)).artists ?? [];
  // 2. Candidates: the name or one of the aliases is the same, ignoring case, accents and punctuation
  const same = found.filter((a) => keyOf(a.name) === key || (a.aliases ?? []).some((x) => keyOf(x.name) === key));
  if (same.length === 1) return same[0];
  // 3. Several (or none) and a track: the artist credited under this name on that recording. It can be one the
  //    artist search ranked past its first 25 (for "Dave", the UK rapper is), and is then fetched by ID.
  const title = cleanTrack(track);
  if (title) {
    const query = `recording:${phrase(title)} AND artist:${phrase(name)}`;
    const recordings = (await mb(`recording/?${new URLSearchParams({ query, limit: "25", fmt: "json" })}`)).recordings ?? [];
    // Recordings credited under this name; if any has exactly the title (the search also returns "Slime Time" for
    // "Time"), only those count
    const credited: { title: string; id: string }[] = [];
    for (const r of recordings) {
      for (const c of r["artist-credit"] ?? []) {
        if (c.artist?.id && (keyOf(c.name ?? "") === key || keyOf(c.artist.name ?? "") === key)) {
          credited.push({ title: r.title ?? "", id: c.artist.id });
        }
      }
    }
    const exact = credited.filter((x) => keyOf(cleanTrack(x.title)) === keyOf(title));
    const hits = new Map<string, number>(); // artist ID -> recordings credited to it; ties go to the best-scored
    for (const { id } of exact.length ? exact : credited) hits.set(id, (hits.get(id) ?? 0) + 1);
    let top = "", most = 0;
    for (const [id, n] of hits) if (n > most) [top, most] = [id, n];
    if (top) return same.find((a) => a.id === top) ?? (await mb(`artist/${top}?inc=tags&fmt=json`));
  }
  // 4. Otherwise the candidate with the most tag votes, usually the famous one
  return same.length ? same.reduce((a, b) => (votes(b) > votes(a) ? b : a)) : null;
}

// ---- Last.fm, for artists MusicBrainz lacks or has no genres for ----

// Last.fm's tags are free text ("Hip-Hop", "hiphop", "synthpop"), so they're matched to MusicBrainz's genres ignoring
// spaces, hyphens and case, plus a few common tags MusicBrainz spells another way or doesn't list
const ALIASES: Record<string, string> = { rap: "hip hop", rnb: "r&b", randb: "r&b" };
const tagKey = (t: string) => t.toLowerCase().replace(/[\s\-_]/g, "");
let byTagKey: Map<string, string> | null = null;
function genreOfTag(tag: string, genres: Set<string>): string | undefined {
  if (!byTagKey) {
    byTagKey = new Map([...genres].map((g) => [tagKey(g), g]));
    for (const [tag, g] of Object.entries(ALIASES)) if (genres.has(g)) byTagKey.set(tag, g);
  }
  return byTagKey.get(tagKey(tag));
}

async function lastfm(name: string, genres: Set<string>): Promise<Genres> {
  const key = Deno.env.get("LASTFM_API_KEY");
  if (!key) return [];
  const q = new URLSearchParams({ method: "artist.gettoptags", artist: name, autocorrect: "1", api_key: key, format: "json" });
  const r = await fetch(`https://ws.audioscrobbler.com/2.0/?${q}`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(8_000),
  });
  const j = await r.json().catch(() => ({}));
  if (j.error === 6) return []; // no such artist
  if (!r.ok || j.error) throw new Error(`Last.fm ${r.status} ${j.error ?? ""} ${j.message ?? ""}`);
  // Free-text tags with counts 0-100 relative to the top one; a lone tag comes as an object, not a list
  const tags = [j.toptags?.tag ?? []].flat() as { name: string; count: number | string }[];
  // Several tags can land on one genre ("rap" and "Hip-Hop"): it keeps the highest count
  const out = new Map<string, number>();
  for (const t of tags) {
    const g = genreOfTag(String(t.name), genres), n = Number(t.count);
    if (g && n >= 10 && n > (out.get(g) ?? 0)) out.set(g, n);
  }
  return [...out].sort((a, b) => b[1] - a[1]).slice(0, 8);
}

async function lookup(name: string, track: string): Promise<Omit<Row, "name_key" | "name" | "fetched_at">> {
  const genres = await genreSet();
  const artist = await findArtist(name, track);
  const mbid = artist?.id ?? null;
  const fromMb = mbGenres(artist?.tags, genres);
  if (fromMb.length) return { mbid, genres: fromMb, source: "musicbrainz" };
  const fromLastfm = await lastfm(name, genres);
  if (fromLastfm.length) return { mbid, genres: fromLastfm, source: "lastfm" };
  return { mbid, genres: [], source: "none" };
}

// ---- The table, through PostgREST ----

function db(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY aren't set");
  return fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      // A legacy service-role key is a JWT and goes in Authorization too; a newer sb_secret_ key goes only in apikey
      ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}),
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function readRows(keys: string[]): Promise<Row[]> {
  // in.("a","b"): each key quoted, with its quotes and backslashes escaped, and the whole list URL-encoded
  const list = keys.map((k) => `"${k.replace(/["\\]/g, "\\$&")}"`).join(",");
  const r = await db(`artist_genres?select=name_key,genres,source,fetched_at&name_key=in.(${encodeURIComponent(list)})`);
  if (!r.ok) throw new Error(`read ${r.status} ${await r.text()}`);
  return r.json();
}

async function writeRows(rows: Row[]) {
  if (!rows.length) return;
  const r = await db("artist_genres", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`write ${r.status} ${await r.text()}`);
}

// ---- The queue ----

type Queued = { name_key: string; name: string; track: string; rank: number; wanted_at: string; attempts: number };

async function rpc(name: string, args: unknown) {
  const r = await db(`rpc/${name}`, { method: "POST", body: JSON.stringify(args) });
  if (!r.ok) throw new Error(`${name} ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

const queued = (key: string) => `genre_queue?name_key=eq.${encodeURIComponent(key)}`;

async function patchQueued(key: string, fields: Record<string, unknown>) {
  const r = await db(queued(key), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(fields) });
  if (!r.ok) throw new Error(`queue patch ${r.status} ${await r.text()}`);
}

// Looks up names from the front of the queue for about WORK_MS, storing each answer as it comes
async function work() {
  const start = Date.now();
  const left = () => WORK_MS - (Date.now() - start);
  let done = 0, failed = 0;
  while (left() > LOOKUP_MS) {
    const claimed: Queued[] = ((await rpc("genre_claim", { p_n: CLAIM })) ?? [])
      .sort((a: Queued, b: Queued) => b.wanted_at.localeCompare(a.wanted_at) || a.rank - b.rank);
    if (!claimed.length) break;
    let stop = false;
    for (const q of claimed) {
      if (stop || left() < LOOKUP_MS) {
        // Back to the queue for the next run
        await patchQueued(q.name_key, { claimed_until: null });
        continue;
      }
      try {
        const found = await lookup(q.name, q.track);
        await writeRows([{ name_key: q.name_key, name: q.name, ...found, fetched_at: new Date().toISOString() }]);
        await db(queued(q.name_key), { method: "DELETE" });
        done++;
      } catch (err) {
        console.error(q.name, err);
        failed++;
        if (err instanceof Busy) {
          // MusicBrainz asked us to slow down: not the name's fault, so it isn't counted against it
          stop = true;
          await patchQueued(q.name_key, { claimed_until: null });
        } else if (q.attempts + 1 >= MAX_ATTEMPTS) {
          // Stored as found nowhere, so it's tried again after NONE_STALE_MS if someone still asks
          await writeRows([{ name_key: q.name_key, name: q.name, mbid: null, genres: [], source: "none", fetched_at: new Date().toISOString() }]);
          await db(queued(q.name_key), { method: "DELETE" });
        } else {
          // Tried again after 2, 4, 8, 16 minutes
          const next = new Date(Date.now() + 2 ** (q.attempts + 1) * 60_000).toISOString();
          await patchQueued(q.name_key, { attempts: q.attempts + 1, next_try_at: next, claimed_until: null });
        }
      }
    }
    if (stop) break;
  }
  console.log(`worker: ${done} looked up, ${failed} failed, ${Math.round((Date.now() - start) / 1000)} s`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST { artists: [{ name, track }] }" }, 405);

  // The worker, posted to by pg_cron. It answers at once and keeps working in the background.
  const workerKey = Deno.env.get("GENRES_WORKER_KEY");
  if (req.headers.has("x-worker-key")) {
    if (!workerKey || req.headers.get("x-worker-key") !== workerKey) return json({ error: "wrong worker key" }, 403);
    const run = work().catch((err) => console.error("worker", err));
    // @ts-ignore EdgeRuntime is Supabase's, for work that outlives the response
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(run);
    else await run;
    return json({ working: true }, 202);
  }

  // The artists asked about, once each by key, in the order given
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "the body must be JSON" }, 400);
  }
  if (!Array.isArray(body?.artists)) return json({ error: "artists must be a list" }, 400);
  const offset = Number.isInteger(body.offset) && body.offset >= 0 ? Math.min(body.offset, 1_000_000) : 0;
  const asked = new Map<string, { names: string[]; name: string; track: string; rank: number }>();
  for (const a of body.artists.slice(0, MAX_ARTISTS)) {
    const name = typeof a?.name === "string" ? a.name.trim().slice(0, 300) : "";
    if (!name) continue;
    const track = typeof a?.track === "string" ? a.track.slice(0, 300) : "";
    const key = keyOf(name);
    const seen = asked.get(key);
    if (seen) {
      if (!seen.names.includes(name)) seen.names.push(name);
      if (!seen.track) seen.track = track;
    } else asked.set(key, { names: [name], name, track, rank: offset + asked.size });
  }

  const genres: Record<string, Genres> = {};
  const pending: string[] = [];
  const answer = (key: string, g: Genres) => {
    for (const n of asked.get(key)?.names ?? []) genres[n] = g;
  };

  // What the table already knows; a "none" older than 30 days counts as missing
  let rows: Row[];
  try {
    rows = asked.size ? await readRows([...asked.keys()]) : [];
  } catch (err) {
    console.error(err);
    return json({ error: "the genre table didn't answer" }, 502);
  }
  const known = new Set<string>();
  for (const row of rows) {
    if (row.source === "none" && Date.now() - Date.parse(row.fetched_at) > NONE_STALE_MS) continue;
    known.add(row.name_key);
    answer(row.name_key, row.genres ?? []);
  }

  // The rest go on the queue (or to its front, if they're there already)
  const missing = [...asked].filter(([key]) => !known.has(key));
  for (const [, a] of missing) pending.push(...a.names);
  if (missing.length) {
    try {
      await rpc("genre_enqueue", { p_artists: missing.map(([key, a]) => ({ key, name: a.name, track: a.track, rank: a.rank })) });
    } catch (err) {
      // They're still pending, and queued when the page asks again
      console.error(err);
    }
  }
  return json({ genres, pending });
});

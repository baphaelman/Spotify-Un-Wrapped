// Pictures for the listening mix's key (js/covers.js). The page has only track IDs (the export names artists and
// albums but doesn't identify them), so this asks Spotify's Web API about a few of an item's tracks:
//   GET ?kind=artist&name=<artist>&tracks=<id>,...           ->  the artist's photo, else one of their album covers
//   GET ?kind=album&name=<artist>&album=<title>&tracks=<id>,...  ->  the album's cover, else the artist's photo
// Answer: { "image": "<url>" | "", "from": "artist" | "album" | "" }. Each track (up to 5) is tried in turn, then
// the catalog by name (for tracks Spotify has since removed or re-released), and a picture
// only counts if it's real: Spotify gives some profiles a placeholder (a dark square with a person icon), which is
// recognized by its size. `name` picks the right artist on a track with several (a feature).
// Each picture is looked up once for everyone and kept in the `pictures` table (supabase/schema.sql). A picture the
// table doesn't know is looked up at once if this minute's allowance (PER_MINUTE, shared by every visitor and the
// worker through `picture_budget`) has room; otherwise it's queued, and the answer is { "pending": true, "wait": s },
// for the page to ask again. The queue is worked by this same function: pg_cron posts to it once a minute with the
// header x-worker-key (the secret PICTURES_WORKER_KEY), and it looks pictures up for about 50 s within the
// allowance, so everything asked for gets a picture even after its visitor has left. When Spotify says to wait
// (429), the wait is stored, and no one calls Spotify until it's over.
// Deployed as "smooth-endpoint" (the name the dashboard gave it). Needs SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET
// as function secrets (an app from developer.spotify.com), PICTURES_WORKER_KEY for the worker, and JWT verification
// off: it's open, and holds nothing private. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided to every
// function. The page's older calls (?track=<id>) still get an artist's photo.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

// Spotify lookups a minute, for everyone together: the app is in development mode, whose allowance is small and
// unpublished, and bursts over it earn lockouts of up to a day. A lookup is 1 to 6 API calls.
const PER_MINUTE = 10;
const RETRY_NONE_DAYS = 30; // a picture Spotify had none for is asked about again after this
const WORK_MS = 50_000; // a worker run looks up for this long, so runs a minute apart don't overlap
const PACE_MS = 60_000 / PER_MINUTE; // the worker spreads its lookups over the minute

const json = (body: unknown, status = 200, cache = "public, max-age=604800") =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": cache },
  });

// An app token from the client-credentials flow, kept until a minute before it runs out
let token = { value: "", until: 0 };
async function appToken(): Promise<string> {
  if (Date.now() < token.until) return token.value;
  const id = Deno.env.get("SPOTIFY_CLIENT_ID"), secret = Deno.env.get("SPOTIFY_CLIENT_SECRET");
  if (!id || !secret) throw new Error("SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET aren't set");
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${id}:${secret}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(`token ${r.status}`);
  const j = await r.json();
  token = { value: j.access_token, until: Date.now() + (j.expires_in - 60) * 1000 };
  return token.value;
}

// Spotify's rate limit: it says how many seconds to wait, and the page holds its lookups that long
class Busy extends Error {
  constructor(public wait: number) {
    super(`rate limited for ${wait} s`);
  }
}

async function api(path: string) {
  const r = await fetch(`https://api.spotify.com/v1/${path}`, { headers: { Authorization: `Bearer ${await appToken()}` } });
  if (r.status === 429) throw new Busy(Number(r.headers.get("retry-after")) || 30);
  if (r.status === 404 || r.status === 400) return null;
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

// The smallest picture at least 160 px wide (the key shows them at 60), else the largest there is
type Image = { url: string; width: number | null };
function pick(images: Image[] = []): string {
  const sized = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (sized.find((i) => (i.width ?? 0) >= 160) ?? sized.at(-1))?.url ?? "";
}

// Spotify's placeholder for a profile without a photo is a ~1 KB image; a real 160 px photo or cover is several KB
const PLACEHOLDER_BYTES = 2500;
async function real(url: string): Promise<boolean> {
  if (!url) return false;
  const r = await fetch(url, { method: "HEAD" });
  return r.ok && Number(r.headers.get("content-length") ?? PLACEHOLDER_BYTES + 1) > PLACEHOLDER_BYTES;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

async function artistPhoto(track: any, name: string): Promise<string> {
  const artists = track?.artists ?? [];
  const artist = artists.find((a: any) => name && norm(a.name) === norm(name)) ?? artists[0];
  const a = artist?.id ? await api(`artists/${artist.id}`) : null;
  const url = pick(a?.images);
  return (await real(url)) ? url : "";
}

async function albumCover(track: any): Promise<string> {
  const url = pick(track?.album?.images);
  return (await real(url)) ? url : "";
}

// Last resorts, when every track given is one Spotify has since removed or re-released (its artist and album
// often lose their pictures): the catalog, by name. Only an exact match counts.
async function searchArtist(name: string): Promise<string> {
  if (!name) return "";
  const r = await api(`search?type=artist&limit=10&q=${encodeURIComponent(name)}`);
  for (const a of r?.artists?.items ?? []) {
    if (norm(a.name) !== norm(name)) continue;
    const url = pick(a.images);
    if (await real(url)) return url;
  }
  return "";
}

async function searchAlbum(album: string, name: string): Promise<string> {
  if (!album) return "";
  const r = await api(`search?type=album&limit=10&q=${encodeURIComponent(`album:${album} artist:${name}`)}`);
  for (const a of r?.albums?.items ?? []) {
    if (norm(a.name) !== norm(album) || !a.artists?.some((x: any) => norm(x.name) === norm(name))) continue;
    const url = pick(a.images);
    if (await real(url)) return url;
  }
  return "";
}

// What was asked for, through each track in turn, then by name, then the other kind: an artist's album cover, an
// album's artist
type Found = { image: string; from: "artist" | "album" | "" };
async function lookup(kind: "artist" | "album", name: string, album: string, ids: string[]): Promise<Found> {
  const other = kind === "artist" ? "album" : "artist";
  const tracks = [];
  for (const id of ids) {
    const t = await api(`tracks/${id}`);
    if (!t) continue;
    tracks.push(t);
    const image = kind === "artist" ? await artistPhoto(t, name) : await albumCover(t);
    if (image) return { image, from: kind };
  }
  let image = kind === "artist" ? await searchArtist(name) : await searchAlbum(album, name);
  if (image) return { image, from: kind };
  for (const t of tracks) {
    image = kind === "artist" ? await albumCover(t) : await artistPhoto(t, name);
    if (image) return { image, from: other };
  }
  if (kind === "album" && (image = await searchArtist(name))) return { image, from: other };
  return { image: "", from: "" };
}

// ---- The tables, through PostgREST ----

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

async function rpc(name: string, args: unknown = {}) {
  const r = await db(`rpc/${name}`, { method: "POST", body: JSON.stringify(args) });
  if (!r.ok) throw new Error(`${name} ${r.status} ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

// The stored answer, unless it's a "none" old enough to ask about again
type Row = { image: string; from_kind: Found["from"]; fetched_at: string };
async function stored(key: string): Promise<Row | undefined> {
  const r = await db(`pictures?select=image,from_kind,fetched_at&key=eq.${encodeURIComponent(key)}`);
  if (!r.ok) throw new Error(`read ${r.status} ${await r.text()}`);
  const [row] = await r.json();
  const stale = row && !row.image && Date.now() - Date.parse(row.fetched_at) > RETRY_NONE_DAYS * 86_400_000;
  return stale ? undefined : row;
}

const queued = (key: string) => `picture_queue?key=eq.${encodeURIComponent(key)}`;
const patchQueued = (key: string, fields: Record<string, unknown>) =>
  db(queued(key), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(fields) });

// Keeps an answer for everyone and takes it off the queue
async function store(key: string, found: Found) {
  const r = await db("pictures", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, image: found.image, from_kind: found.from, fetched_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error(`write ${r.status} ${await r.text()}`);
  await db(queued(key), { method: "DELETE" });
}

// 0 when a lookup may go ahead now (and it's counted), else the seconds until one may
const spend = async (): Promise<number> => (await rpc("picture_spend", { p_max: PER_MINUTE })) ?? 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- The worker ----

type Queued = { key: string; kind: "artist" | "album"; name: string; album: string; tracks: string; attempts: number };

// Looks up pictures from the front of the queue for about WORK_MS, one every PACE_MS at most, within the allowance
async function work() {
  const start = Date.now();
  const left = () => WORK_MS - (Date.now() - start);
  let done = 0, failed = 0;
  while (left() > PACE_MS) {
    const [item]: Queued[] = (await rpc("picture_claim")) ?? [];
    if (!item) break;
    const wait = await spend();
    if (wait) {
      await patchQueued(item.key, { claimed_until: null }); // not this run's to do after all
      if (wait * 1000 > left() - PACE_MS) break;
      await sleep(wait * 1000);
      continue;
    }
    const began = Date.now();
    try {
      await store(item.key, await lookup(item.kind, item.name, item.album, item.tracks.split(",")));
      done++;
    } catch (err) {
      if (err instanceof Busy) {
        await rpc("picture_busy", { p_seconds: err.wait });
        await patchQueued(item.key, { claimed_until: null });
        console.log(`worker: Spotify says wait ${err.wait} s`);
        break;
      }
      console.error("worker", item.key, err);
      failed++;
      const attempts = item.attempts + 1;
      if (attempts >= 5) await store(item.key, { image: "", from: "" });
      else {
        const next_try_at = new Date(Date.now() + 2 ** attempts * 60_000).toISOString();
        await patchQueued(item.key, { attempts, claimed_until: null, next_try_at });
      }
    }
    await sleep(Math.max(0, PACE_MS - (Date.now() - began)));
  }
  console.log(`worker: ${done} looked up, ${failed} failed, ${Math.round((Date.now() - start) / 1000)} s`);
}

const busy = (wait: number) =>
  new Response(JSON.stringify({ error: "busy", wait }), {
    status: 503,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": String(wait) },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  // The worker, posted to by pg_cron. It answers at once and keeps working in the background.
  if (req.method === "POST") {
    const workerKey = Deno.env.get("PICTURES_WORKER_KEY");
    if (!workerKey || req.headers.get("x-worker-key") !== workerKey) return json({ error: "wrong worker key" }, 403, "no-store");
    const run = work().catch((err) => console.error("worker", err));
    // @ts-ignore EdgeRuntime is Supabase's, for work that outlives the response
    globalThis.EdgeRuntime?.waitUntil?.(run);
    return json({ working: true }, 202, "no-store");
  }
  const q = new URL(req.url).searchParams;
  const kind = q.get("kind") === "album" ? "album" : "artist";
  const name = q.get("name") ?? "";
  const album = q.get("album") ?? "";
  // Spotify IDs are 22 base-62 characters
  const ids = (q.get("tracks") ?? q.get("track") ?? "").split(",").filter((id) => /^[0-9A-Za-z]{22}$/.test(id)).slice(0, 5);
  if (!ids.length) return json({ error: "tracks must be Spotify track IDs" }, 400, "no-store");
  const key = `${kind}:${ids[0]}`; // covers.js's key
  const enqueue = () => rpc("picture_enqueue", { p_key: key, p_kind: kind, p_name: name, p_album: album, p_tracks: ids.join(",") });
  // Nothing found yet: the page asks again on a later visit, and so may Spotify's answer change
  const answer = (f: Found) => json(f, 200, f.image ? undefined : "public, max-age=3600");
  try {
    const row = await stored(key);
    if (row) return answer({ image: row.image, from: row.from_kind });
    const wait = await spend();
    if (wait) {
      await enqueue();
      // Over a minute means Spotify's lockout: the page stops asking this visit, and the worker gets it later
      return wait > 60 ? busy(wait) : json({ pending: true, wait }, 202, "no-store");
    }
    const found = await lookup(kind, name, album, ids);
    await store(key, found);
    return answer(found);
  } catch (err) {
    console.error(err);
    if (err instanceof Busy) {
      await rpc("picture_busy", { p_seconds: err.wait }).catch(console.error);
      await enqueue().catch(console.error);
      return busy(err.wait);
    }
    // Not stored, so the page asks again on a later visit
    return json({ error: "Spotify didn't answer" }, 502, "no-store");
  }
});

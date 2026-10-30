// Pictures for the listening mix's key (js/covers.js). The page has only track IDs (the export names artists and
// albums but doesn't identify them), so this asks Spotify's Web API about a few of an item's tracks:
//   GET ?kind=artist&name=<artist>&tracks=<id>,<id>,<id>  ->  the artist's photo, else the cover of one of the tracks
//   GET ?kind=album&name=<artist>&tracks=<id>,<id>,<id>   ->  the album's cover, else the artist's photo
// Answer: { "image": "<url>" | "", "from": "artist" | "album" | "" }. Each track is tried in turn, and a picture
// only counts if it's real: Spotify gives some profiles a placeholder (a dark square with a person icon), which is
// recognized by its size. `name` picks the right artist on a track with several (a feature).
// Deployed as "smooth-endpoint" (the name the dashboard gave it). Needs SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET
// as function secrets (an app from developer.spotify.com), and JWT verification off: it's open, and holds nothing
// private. The page's older calls (?track=<id>) still get an artist's photo.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

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

async function api(path: string) {
  const r = await fetch(`https://api.spotify.com/v1/${path}`, { headers: { Authorization: `Bearer ${await appToken()}` } });
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const q = new URL(req.url).searchParams;
  const kind = q.get("kind") === "album" ? "album" : "artist";
  const name = q.get("name") ?? "";
  // Spotify IDs are 22 base-62 characters
  const ids = (q.get("tracks") ?? q.get("track") ?? "").split(",").filter((id) => /^[0-9A-Za-z]{22}$/.test(id)).slice(0, 3);
  if (!ids.length) return json({ error: "tracks must be Spotify track IDs" }, 400, "no-store");
  try {
    const tracks = [];
    // What was asked for, through each track in turn
    for (const id of ids) {
      const t = await api(`tracks/${id}`);
      if (!t) continue;
      tracks.push(t);
      const image = kind === "artist" ? await artistPhoto(t, name) : await albumCover(t);
      if (image) return json({ image, from: kind });
    }
    // Then the other kind: an artist's album cover, an album's artist
    for (const t of tracks) {
      const image = kind === "artist" ? await albumCover(t) : await artistPhoto(t, name);
      if (image) return json({ image, from: kind === "artist" ? "album" : "artist" });
    }
    return json({ image: "", from: "" });
  } catch (err) {
    console.error(err);
    // Not cached, so the page asks again on a later visit
    return json({ error: "Spotify didn't answer" }, 502, "no-store");
  }
});

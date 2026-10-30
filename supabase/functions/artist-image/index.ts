// Artist photos for the Artists view (js/covers.js). The page has only track IDs (the export names artists but
// doesn't identify them), so this asks Spotify's Web API for a track's first artist and returns their photo.
//   GET /functions/v1/artist-image?track=<spotify track id>  ->  { "image": "<url>" | "" }
// Needs SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET as function secrets (an app from developer.spotify.com).
// Deployed with --no-verify-jwt: it's open like the oEmbed endpoint it stands beside, and holds nothing private.

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

// The smallest photo at least 160 px wide (the key shows them at 40), else the largest there is
type Image = { url: string; width: number | null };
function pick(images: Image[] = []): string {
  const sized = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (sized.find((i) => (i.width ?? 0) >= 160) ?? sized.at(-1))?.url ?? "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const track = new URL(req.url).searchParams.get("track") ?? "";
  // Spotify IDs are 22 base-62 characters
  if (!/^[0-9A-Za-z]{22}$/.test(track)) return json({ error: "track must be a Spotify track ID" }, 400, "no-store");
  try {
    const t = await api(`tracks/${track}`);
    const artist = t?.artists?.[0]?.id;
    const a = artist ? await api(`artists/${artist}`) : null;
    return json({ image: pick(a?.images) });
  } catch (err) {
    console.error(err);
    // Not cached, so the page asks again on a later visit
    return json({ error: "Spotify didn't answer" }, 502, "no-store");
  }
});

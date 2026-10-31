# How well MusicBrainz knows the genres of the artists in a streaming history (see docs/genres.md). Reads the
# history, takes the top artists by listening time, and looks each one up by name with the same rules as the
# `genres` edge function (supabase/functions/genres/index.ts; keep the two in step), one MusicBrainz request
# every 1.1 s (its limit is 1 a second). Only tags on MusicBrainz's own genre list count, so "british" or
# "seen live" don't.
#   python3 dev/genre_coverage.py [top_n] [data_dir]      (default: 500, ../spotify/datas/Spotify Extended Streaming History)
# Last.fm is the fallback only when LASTFM_API_KEY is set in the environment.
# Answers are kept in dev/genre_cache.json (not in git), so a rerun only asks about artists it hasn't seen; delete
# an artist's entry to ask again. Each entry: {"mbid", "matches", "genres": [[genre, votes], ...], "source"}.
# MusicBrainz and Last.fm only, never Spotify: this doesn't touch the picture function's allowance.
import json, os, re, subprocess, sys, time, unicodedata
import urllib.error, urllib.parse, urllib.request
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAIN = (ROOT / subprocess.run(["git", "rev-parse", "--git-common-dir"], cwd=ROOT, capture_output=True, text=True).stdout.strip()).resolve().parent
TOP = int(sys.argv[1]) if len(sys.argv) > 1 else 500
data = Path(sys.argv[2] if len(sys.argv) > 2 else MAIN.parent / "spotify/datas/Spotify Extended Streaming History")
CACHE = ROOT / "dev" / "genre_cache.json"
UA = "SpotifyUnwrapped/0.1 (https://baphaelman.github.io/Spotify-Un-Wrapped/)"
MB = "https://musicbrainz.org/ws/2"
LASTFM_KEY = os.environ.get("LASTFM_API_KEY", "")

last_call = 0.0


def get(url, tries=5, pace=True):
    """GET a URL; MusicBrainz calls are paced 1.1 s apart, and a 503 (over its limit) backs off and retries."""
    global last_call
    for i in range(tries):
        if pace:
            time.sleep(max(0, last_call + 1.1 - time.time()))
            last_call = time.time()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=30) as r:
                return r.read().decode()
        except urllib.error.HTTPError as e:
            if e.code != 503 or i == tries - 1:
                raise
            time.sleep(5 * (i + 1))


def norm(s):
    """The name_key: NFKD, accents dropped, lowercase, & as "and", only letters and digits (any script)."""
    s = "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.category(c).startswith("M"))
    s = s.lower().replace("&", "and")
    return "".join(c for c in s if unicodedata.category(c)[0] in "LN")


def key(name):
    # A name of only punctuation ("!!!") keeps its own lowercase spelling
    return norm(name) or name.strip().lower()


def phrase(s):
    """A quoted Lucene phrase: backslash and quote escaped (the rest is literal inside quotes)."""
    return '"' + re.sub(r'(["\\])', r"\\\1", s) + '"'


def clean_track(t):
    """A track title as MusicBrainz is likely to spell it: no " - Remastered 2011", no "(feat. X)"."""
    t = re.split(r"\s+-\s+", t)[0]
    t = re.sub(r"\s*[\(\[](feat|ft|with|prod)\.?\s[^\)\]]*[\)\]]", "", t, flags=re.I)
    return t.strip()


votes = lambda a: sum(t["count"] for t in a.get("tags", []) if t["count"] > 0)


def mb_genres(tags, genres):
    return sorted(([t["name"], t["count"]] for t in tags if t["name"] in genres and t["count"] > 0), key=lambda x: -x[1])


def lookup(name, track, genres):
    k = key(name)
    # 1. Unfielded quoted search: it looks in names and aliases ("Kanye West" is an alias of "Ye")
    q = urllib.parse.urlencode({"query": phrase(name), "limit": 25, "fmt": "json"})
    found = json.loads(get(f"{MB}/artist/?{q}"))["artists"]
    # 2. Candidates: the name or an alias is the same, ignoring case, accents and punctuation
    same = [a for a in found if key(a["name"]) == k or any(key(x["name"]) == k for x in a.get("aliases") or [])]
    best = same[0] if len(same) == 1 else None
    # 3. Several (or none) and a track: the artist credited on that recording under this name. It may be one the
    #    artist search ranked past its first 25 ("Dave", the UK rapper), then it's fetched by ID.
    if len(same) != 1 and track and clean_track(track):
        q = urllib.parse.urlencode({"query": f"recording:{phrase(clean_track(track))} AND artist:{phrase(name)}", "limit": 25, "fmt": "json"})
        # Recordings credited under this name; if any has exactly the title (the search also returns "Slime
        # Time" for "Time"), only those count
        credited = [(r, c["artist"]["id"]) for r in json.loads(get(f"{MB}/recording/?{q}"))["recordings"]
                    for c in r.get("artist-credit", []) if key(c.get("name", "")) == k or key(c["artist"]["name"]) == k]
        exact = [x for x in credited if key(clean_track(x[0]["title"])) == key(clean_track(track))]
        hits = Counter(i for _, i in exact or credited)
        if hits:
            top_id = hits.most_common(1)[0][0]  # most recordings; ties go to the best-scored
            best = next((a for a in same if a["id"] == top_id), None)
            if not best:
                best = json.loads(get(f"{MB}/artist/{top_id}?inc=tags&fmt=json"))
    # 4. Otherwise the candidate with the most tag votes (usually the famous one)
    if not best and same:
        best = max(same, key=votes)
    g = mb_genres((best or {}).get("tags") or [], genres)
    entry = {"mbid": best and best["id"], "matches": len(same), "genres": g, "source": "musicbrainz"}
    if g:
        return entry
    # Last.fm, when MusicBrainz has no such artist or no genres for them (only tags on MusicBrainz's genre list)
    if LASTFM_KEY:
        q = urllib.parse.urlencode({"method": "artist.gettoptags", "artist": name, "autocorrect": 1, "api_key": LASTFM_KEY, "format": "json"})
        try:
            j = json.loads(get(f"https://ws.audioscrobbler.com/2.0/?{q}", pace=False))
        except urllib.error.HTTPError as e:
            j = json.loads(e.read().decode() or "{}")
            if j.get("error") != 6:
                raise
        if j.get("error") not in (None, 6):
            raise RuntimeError(f"Last.fm error {j.get('error')}")
        tags = (j.get("toptags") or {}).get("tag") or []
        tags = [tags] if isinstance(tags, dict) else tags  # a lone tag comes as an object, not a list
        g = [[t["name"].lower(), int(t["count"])] for t in tags if t["name"].lower() in genres and int(t["count"]) >= 10][:8]
        if g:
            return {**entry, "genres": g, "source": "lastfm"}
    return {**entry, "source": "none"}


# Listening time per artist, and each artist's most-played track (the tie-breaker for shared names)
ms = Counter()
track_ms = defaultdict(Counter)
for f in data.glob("*Audio*.json"):
    for p in json.loads(f.read_text()):
        a = p.get("master_metadata_album_artist_name")
        if a:
            ms[a] += p["ms_played"]
            if p.get("master_metadata_track_name"):
                track_ms[a][p["master_metadata_track_name"]] += p["ms_played"]
total = sum(ms.values())
top = ms.most_common(TOP)
fav = lambda a: track_ms[a].most_common(1)[0][0] if track_ms[a] else ""

if __name__ == "__main__":
    genres = set(get(f"{MB}/genre/all?fmt=txt").split("\n")) - {""}
    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    todo = [a for a, _ in top if a not in cache]
    print(f"{len(genres)} MusicBrainz genres; {len(top)} artists, {len(todo)} to ask (~{len(todo) * 1.5 / 60:.0f} min); Last.fm {'on' if LASTFM_KEY else 'off'}", flush=True)

    for i, artist in enumerate(todo):
        try:
            cache[artist] = lookup(artist, fav(artist), genres)
        except Exception as e:
            print(f"  {artist}: {e}", flush=True)
        if i % 25 == 24 or i == len(todo) - 1:
            CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=1))
            print(f"  {i + 1}/{len(todo)}", flush=True)

    # Report
    rows = [(a, m, cache.get(a)) for a, m in top]
    asked = [r for r in rows if r[2]]
    share = lambda rs: 100 * sum(m for _, m, _ in rs) / total
    found = [r for r in asked if r[2]["mbid"]]
    labeled = [r for r in asked if r[2]["genres"]]
    from_lastfm = [r for r in labeled if r[2]["source"] == "lastfm"]
    ambiguous = [r for r in found if r[2]["matches"] > 1]
    print(f"\nTop {len(top)} artists = {share(rows):.0f}% of listening time")
    print(f"  found on MusicBrainz:   {len(found)}/{len(asked)}  ({share(found):.0f}% of time)")
    print(f"  with at least 1 genre:  {len(labeled)}/{len(asked)}  ({share(labeled):.0f}% of time; {len(from_lastfm)} from Last.fm)")
    print(f"  name shared by others:  {len(ambiguous)}  (resolved by a track, else the most-voted)")
    for n in (50, 100, 200):
        sub = asked[:n]
        print(f"  top {n}: {sum(1 for r in sub if r[2]['genres'])}/{len(sub)} have a genre")
    print("\nMost listened without a genre:", ", ".join(a for a, _, c in asked if not c["genres"])[:900])
    print("\nShared names:", ", ".join(f"{a} ({c['matches']}, {c['mbid'][:8]})" for a, _, c in ambiguous)[:1500])
    g = Counter()
    for _, m, c in labeled:
        w = sum(n for _, n in c["genres"])
        for name, n in c["genres"]:
            g[name] += m * n / w
    print("\nTop genres by listening time:", ", ".join(f"{k} {100 * v / total:.1f}%" for k, v in g.most_common(25)))
    print("\nSample:", "; ".join(f"{a}: {', '.join(n for n, _ in c['genres'][:4])}" for a, _, c in labeled[:15]))

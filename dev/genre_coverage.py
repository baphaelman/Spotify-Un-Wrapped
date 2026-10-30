# How well MusicBrainz knows the genres of the artists in a streaming history (see docs/genres.md). Reads the
# history, takes the top artists by listening time, and asks MusicBrainz about each one by name, one request a
# second (its limit). Only tags on MusicBrainz's own genre list count, so "british" or "seen live" don't.
#   python3 dev/genre_coverage.py [top_n] [data_dir]      (default: 500, ../spotify/datas/Spotify Extended Streaming History)
# Answers are kept in dev/genre_cache.json (not in git), so a rerun only asks about artists it hasn't seen.
# MusicBrainz only, never Spotify: this doesn't touch the picture function's allowance.
import json, subprocess, sys, time, unicodedata, re
import urllib.request, urllib.parse
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAIN = (ROOT / subprocess.run(["git", "rev-parse", "--git-common-dir"], cwd=ROOT, capture_output=True, text=True).stdout.strip()).resolve().parent
TOP = int(sys.argv[1]) if len(sys.argv) > 1 else 500
data = Path(sys.argv[2] if len(sys.argv) > 2 else MAIN.parent / "spotify/datas/Spotify Extended Streaming History")
CACHE = ROOT / "dev" / "genre_cache.json"
UA = "SpotifyUnwrapped/0.1 (https://baphaelman.github.io/Spotify-Un-Wrapped/)"
MB = "https://musicbrainz.org/ws/2"


def get(url, tries=5):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=30) as r:
                return r.read().decode()
        except urllib.error.HTTPError as e:
            if e.code != 503 or i == tries - 1:
                raise
            time.sleep(2 * (i + 1))  # over the limit: back off


def norm(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode() or s
    return re.sub(r"[^\w]", "", s.lower().replace("&", "and"))


# Listening time per artist
ms = Counter()
for f in data.glob("*Audio*.json"):
    for p in json.loads(f.read_text()):
        if p.get("master_metadata_album_artist_name"):
            ms[p["master_metadata_album_artist_name"]] += p["ms_played"]
total = sum(ms.values())
top = ms.most_common(TOP)

genres = set(get(f"{MB}/genre/all?fmt=txt").split("\n")) - {""}
cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
todo = [a for a, _ in top if a not in cache]
print(f"{len(genres)} MusicBrainz genres; {len(top)} artists, {len(todo)} to ask (~{len(todo) * 1.1 / 60:.0f} min)", flush=True)

for i, artist in enumerate(todo):
    t0 = time.time()
    q = urllib.parse.urlencode({"query": f'artist:"{artist}"', "limit": 10, "fmt": "json"})
    try:
        found = json.loads(get(f"{MB}/artist/?{q}"))["artists"]
    except Exception as e:
        print(f"  {artist}: {e}", flush=True)
        continue
    # Same name, ignoring case, accents and punctuation; aliases count too (e.g. a romanized name)
    same = [a for a in found if norm(a["name"]) == norm(artist) or any(norm(x["name"]) == norm(artist) for x in a.get("aliases", []))]
    tagged = lambda a: sum(t["count"] for t in a.get("tags", []))
    # Several artists share the name: take the one with the most votes (usually the famous one), and say so
    best = max(same, key=tagged) if same else None
    g = sorted(((t["name"], t["count"]) for t in (best or {}).get("tags", []) if t["name"] in genres and t["count"] > 0), key=lambda x: -x[1])
    cache[artist] = {"mbid": best and best["id"], "matches": len(same), "genres": g}
    if i % 25 == 24 or i == len(todo) - 1:
        CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=1))
        print(f"  {i + 1}/{len(todo)}", flush=True)
    time.sleep(max(0, 1.1 - (time.time() - t0)))

# Report
rows = [(a, m, cache.get(a)) for a, m in top]
asked = [r for r in rows if r[2]]
share = lambda rs: 100 * sum(m for _, m, _ in rs) / total
found = [r for r in asked if r[2]["mbid"]]
labeled = [r for r in found if r[2]["genres"]]
ambiguous = [r for r in found if r[2]["matches"] > 1]
print(f"\nTop {len(top)} artists = {share(rows):.0f}% of listening time")
print(f"  found on MusicBrainz:   {len(found)}/{len(asked)}  ({share(found):.0f}% of time)")
print(f"  with at least 1 genre:  {len(labeled)}/{len(asked)}  ({share(labeled):.0f}% of time)")
print(f"  name shared by others:  {len(ambiguous)}  (picked the most-voted; check these)")
for n in (50, 100, 200):
    sub = asked[:n]
    print(f"  top {n}: {sum(1 for r in sub if r[2]['genres'])}/{len(sub)} have a genre")
print("\nMost listened without a genre:", ", ".join(a for a, _, c in asked if not c["genres"])[:900])
print("\nShared names:", ", ".join(f"{a} ({c['matches']})" for a, _, c in ambiguous)[:600])
g = Counter()
for _, m, c in labeled:
    w = sum(n for _, n in c["genres"])
    for name, n in c["genres"]:
        g[name] += m * n / w
print("\nTop genres by listening time:", ", ".join(f"{k} {100 * v / total:.1f}%" for k, v in g.most_common(25)))
print("\nSample:", "; ".join(f"{a}: {', '.join(n for n, _ in c['genres'][:4])}" for a, _, c in labeled[:15]))

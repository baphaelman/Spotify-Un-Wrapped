# Pre-fills the shared genre table (docs/genres.md) through the genres function, so visitors find their artists'
# genres already there: the artists in a streaming history (the latest year's first, then all time), then the
# community pool's top artists. MusicBrainz and Last.fm only, through the function; never Spotify.
#   python3 dev/prefill_genres.py [data_dir]      (default: ../spotify/datas/Spotify Extended Streaming History)
# It only hands the names to the function's queue, in that order, which takes a few seconds; the worker then looks
# them up at about one artist every two seconds (MusicBrainz allows one request a second), with names visitors are
# asking about going first. Rerun it to see how many are answered so far.
import json, re, subprocess, sys, urllib.request
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAIN = (ROOT / subprocess.run(["git", "rev-parse", "--git-common-dir"], cwd=ROOT, capture_output=True, text=True).stdout.strip()).resolve().parent
data = Path(sys.argv[1] if len(sys.argv) > 1 else MAIN.parent / "spotify/datas/Spotify Extended Streaming History")
config = (ROOT / "js" / "config.js").read_text()
URL = re.search(r'SUPABASE_URL = "([^"]+)"', config)[1]
KEY = re.search(r'SUPABASE_KEY = "([^"]+)"', config)[1]
COVER = 0.99  # of each listening total, as js/genres.js asks (0.97) and a little more


def post(path, body, headers={}):
    req = urllib.request.Request(f"{URL}/{path}", json.dumps(body).encode(), {"Content-Type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read())


# The history: listening per artist, all time and in the latest year, and each artist's most-played track
ms, recent, tracks = Counter(), Counter(), defaultdict(Counter)
plays = [p for f in data.glob("*Audio*.json") for p in json.loads(f.read_text()) if p.get("master_metadata_album_artist_name")]
latest = max(p["ts"][:4] for p in plays)
for p in plays:
    a = p["master_metadata_album_artist_name"]
    ms[a] += p["ms_played"]
    tracks[a][p["master_metadata_track_name"]] += p["ms_played"]
    if p["ts"].startswith(latest):
        recent[a] += p["ms_played"]

order = {}  # name -> track, in the order to ask
for counts in (recent, ms):
    total, got = sum(counts.values()), 0
    for a, m in counts.most_common():
        if got >= COVER * total:
            break
        got += m
        order.setdefault(a, tracks[a].most_common(1)[0][0])
print(f"history: {len(order)} artists ({latest} first)", flush=True)

# The community pool's top artists, and the artist of each top track
stats = post("rest/v1/rpc/community_stats", {}, {"apikey": KEY})
pool = [(a["artist"], "") for a in stats.get("topArtists") or []] + [(t["artist"], t["track"]) for t in stats.get("topTracks") or []]
added = 0
for a, t in pool:
    if a not in order:
        order[a] = t
        added += 1
    elif not order[a]:
        order[a] = t
print(f"community ({stats.get('contributors')} contributors): {added} more artists", flush=True)

# Hand everything to the queue, a batch at a time and in order; names the table knows come back at once
todo = [{"name": a, "track": t} if t else {"name": a} for a, t in order.items()]
found = none = pending = 0
for i in range(0, len(todo), 100):
    j = post("functions/v1/genres", {"artists": todo[i:i + 100], "offset": i})
    got = j.get("genres", {})
    found += sum(1 for g in got.values() if g)
    none += sum(1 for g in got.values() if not g)
    pending += len(j.get("pending", []))

print(f"{found} with genres, {none} with none, {pending} queued (about {pending * 2 / 60:.0f} min for the worker)", flush=True)

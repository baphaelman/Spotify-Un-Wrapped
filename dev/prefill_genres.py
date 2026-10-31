# Pre-fills the shared genre table (docs/genres.md) through the genres function, so visitors find their artists'
# genres already there: the artists in a streaming history (the latest year's first, then all time), then the
# community pool's top artists. MusicBrainz and Last.fm only, through the function; never Spotify.
#   python3 dev/prefill_genres.py [data_dir]      (default: ../spotify/datas/Spotify Extended Streaming History)
# Takes about two seconds an artist the table doesn't know yet (MusicBrainz allows one request a second). Safe to
# stop and rerun: what's already stored comes back at once.
import json, re, subprocess, sys, time, urllib.request
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

# Ask in batches: names the table knows come back at once, and the function looks up about ten a request
todo = [{"name": a, "track": t} if t else {"name": a} for a, t in order.items()]
found = none = 0
stalls, start = 0, time.time()
while todo and stalls < 8:
    batch = todo[:100]
    try:
        j = post("functions/v1/genres", {"artists": batch})
    except Exception as e:
        print(f"  request failed: {e}", flush=True)
        stalls += 1
        time.sleep(min(60, 5 * 2 ** stalls))
        continue
    got = j.get("genres", {})
    found += sum(1 for g in got.values() if g)
    none += sum(1 for g in got.values() if not g)
    pending = set(j.get("pending", []))
    # Answered names are done; pending ones go to the back
    todo = todo[100:] + [a for a in batch if a["name"] in pending]
    stalls = 0 if len(got) else stalls + 1
    done = found + none
    if done and (done % 50 < len(got) or not todo):
        print(f"  {done}/{len(order)} answered ({found} with genres, {none} none), {len(todo)} to go, {(time.time() - start) / 60:.0f} min", flush=True)
    if not got:
        time.sleep(min(60, 2 * 2 ** stalls))

print(f"done: {found} with genres, {none} with none, {len(todo)} left unanswered, {(time.time() - start) / 60:.0f} min", flush=True)

# Seeds 12 synthetic contributors into the live community pool, for previewing the Community page.
# Their keys are sha256("synthetic-test-<i>"), so cleanup removes exactly these and nothing real.
#   python3 dev/seed_community.py seed [data_dir] | cleanup
# Fake artists/tracks mix the data owner's top 40 (for overlap) with popular ones.
import json, random, hashlib, math, sys, glob, collections, urllib.request
U = "https://qvsoxqeuvpnryitechsf.supabase.co/rest/v1/rpc/"
K = "sb_publishable_Z9847V3vIbDpJRQnXBvA8w_5FK2uz9B"
N = 12
keys = [hashlib.sha256(f"synthetic-test-{i}".encode()).hexdigest() for i in range(20)]

def rpc(fn, args={}):
    req = urllib.request.Request(U + fn, json.dumps(args).encode(), {"apikey": K, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            t = r.read().decode(); return r.status, (json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

if sys.argv[1] == "cleanup":
    for k in keys: rpc("delete_summary", {"p_key": k})
    print("after cleanup:", rpc("community_stats")); sys.exit()

# Pool: the owner's top artists/tracks (for overlap) plus some broadly popular ones
art, trk = collections.Counter(), collections.Counter()
from pathlib import Path
data = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parent.parent.parent / "spotify/datas/Spotify Extended Streaming History"
for f in glob.glob(str(data / "Streaming_History_Audio*.json")):
    for r in json.load(open(f)):
        a = r.get("master_metadata_album_artist_name")
        if a:
            art[a] += r["ms_played"]; trk[(r["master_metadata_track_name"], a)] += r["ms_played"]
mine_artists = [a for a, _ in art.most_common(40)]
mine_tracks = [t for t, _ in trk.most_common(40)]
popular = ["Taylor Swift", "Drake", "Frank Ocean", "Radiohead", "SZA", "The Weeknd", "Bad Bunny", "Billie Eilish",
           "Mac Miller", "Tame Impala", "Doja Cat", "Arctic Monkeys", "Phoebe Bridgers", "Daft Punk", "Travis Scott"]
popular_tracks = [("Pink + White", "Frank Ocean"), ("Nights", "Frank Ocean"), ("Kill Bill", "SZA"), ("Blinding Lights", "The Weeknd"),
                  ("Creep", "Radiohead"), ("Cruel Summer", "Taylor Swift"), ("The Less I Know The Better", "Tame Impala"),
                  ("Do I Wanna Know?", "Arctic Monkeys"), ("Self Control", "Frank Ocean"), ("Good News", "Mac Miller")]

random.seed(7)
for i in range(N):
    hours = round(math.exp(random.gauss(7.2, 0.7)), 2)  # ~400–4000 h
    # Each person: a random slice of the owner's artists (popular ones more likely) + popular artists
    picks = [a for j, a in enumerate(mine_artists) if random.random() < 0.85 - j * 0.015] + [a for a in popular if random.random() < 0.6]
    random.shuffle(picks)
    weights = sorted((random.paretovariate(1.2) for _ in picks), reverse=True)
    total_w = sum(weights)
    artists = [[a, round(hours * 0.5 * w / total_w, 2)] for a, w in zip(picks, weights)]
    tpicks = [t for j, t in enumerate(mine_tracks) if random.random() < 0.7 - j * 0.012] + [t for t in popular_tracks if random.random() < 0.55]
    tracks = [[t, a, round(random.uniform(2, 25), 2)] for t, a in tpicks]
    # Clock: night owls vs early birds, weekend bumps
    peak = random.choice([10, 14, 17, 21, 23])
    clock = []
    for d in range(7):
        for h in range(24):
            dist = min(abs(h - peak), 24 - abs(h - peak))
            clock.append(round(hours / 168 * (0.15 + math.exp(-dist * dist / 18)) * (1.3 if d >= 5 else 1) * random.uniform(0.8, 1.2), 2))
    s = {"v": 1, "hours": hours, "plays": int(hours * 32), "activeDays": random.randint(300, 2500),
         "artistsCount": random.randint(400, 6000), "tracksCount": random.randint(1500, 20000),
         "clock": clock, "artists": artists, "tracks": tracks}
    print(i, rpc("submit_summary", {"p_key": keys[i], "p_summary": s})[0], f"{hours:.0f} h, {len(artists)} artists")
st = rpc("community_stats")[1]
print("contributors", st["contributors"], "top artists", len(st["topArtists"]), "top tracks", len(st["topTracks"]))

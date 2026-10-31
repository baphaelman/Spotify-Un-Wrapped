#!/usr/bin/env python3
"""Builds sample/history.json.gz, the "Try it with sample data" history (js/sample.js reads it), from the owner's
extended streaming history. It keeps only what the page uses, the fields parse.js keeps per play
({t, ms, artist, track, album, skipped, id}): no IP addresses, platforms, countries, reasons or anything else.

Columnar, with string tables, then gzipped (the browser unzips it with DecompressionStream):
  artists, albums: names
  tracks: [[name, artist index, album index, Spotify track ID or ""], ...]
  t0: the first play's time (epoch seconds); dt: each play's seconds after the one before
  ms: ms played; k: each play's track index; skip: the skipped plays' indices, each as the gap after the last

  python3 dev/make_sample.py [history folder]
"""
import gzip, json, sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT = ROOT.parent / "spotify/datas/Spotify Extended Streaming History"
# A worktree sits in .claude/worktrees/<name>/: the history lives beside the main checkout
for up in [ROOT, *ROOT.parents]:
    if (up.parent / "spotify/datas").exists():
        DEFAULT = up.parent / "spotify/datas/Spotify Extended Streaming History"
        break

src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
plays = []
for f in sorted(src.glob("Streaming_History_Audio*.json")):
    for r in json.loads(f.read_text()):
        artist = r.get("master_metadata_album_artist_name")
        if not artist:
            continue  # podcasts, audiobooks (as parse.js)
        t = int(datetime.fromisoformat(r["ts"].replace("Z", "+00:00")).timestamp())
        uri = r.get("spotify_track_uri") or ""
        plays.append((t, r.get("ms_played") or 0, artist, r.get("master_metadata_track_name") or "Unknown track",
                      r.get("master_metadata_album_album_name") or "", bool(r.get("skipped")),
                      uri.split(":")[2] if uri.count(":") >= 2 else ""))
plays.sort(key=lambda p: p[0])

def table():
    idx = {}
    return idx, lambda v: idx.setdefault(v, len(idx))

artists, artist_of = table()
albums, album_of = table()
tracks, track_of = table()
out = {"v": 1, "t0": plays[0][0], "dt": [], "ms": [], "k": [], "skip": []}
last_t, last_skip = plays[0][0], -1
for i, (t, ms, artist, track, album, skipped, tid) in enumerate(plays):
    out["dt"].append(t - last_t)
    last_t = t
    out["ms"].append(ms)
    out["k"].append(track_of((track, artist_of(artist), album_of(album), tid)))
    if skipped:
        out["skip"].append(i - last_skip)
        last_skip = i
out["artists"] = list(artists)
out["albums"] = list(albums)
out["tracks"] = [list(k) for k in tracks]

dest = ROOT / "sample/history.json.gz"
dest.parent.mkdir(exist_ok=True)
raw = json.dumps(out, ensure_ascii=False, separators=(",", ":")).encode()
dest.write_bytes(gzip.compress(raw, 9, mtime=0))
print(f"{len(plays):,} plays, {len(artists):,} artists, {len(tracks):,} tracks -> {dest.relative_to(ROOT)} "
      f"({dest.stat().st_size / 1e6:.2f} MB, {len(raw) / 1e6:.1f} MB unzipped)")

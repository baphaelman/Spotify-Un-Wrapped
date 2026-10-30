# Genres

The plan for a Genres view: a fourth tab beside Artists, Albums and Tracks, with the same graphs, lists and
period bar, keyed by genre, where a genre's bands split into its artists (instead of albums or songs).

Status: planning. `dev/genre_coverage.py` measures how well the data source below knows a real history.

## Where the genres come from

The export names artists but has no genres, and **Spotify no longer gives them out**: its February 2026 Web API
changes dropped `genres` (and `popularity`) from the artist object for development-mode apps, which ours is
(existing apps were moved over on 9 March 2026). Its request allowance is also the one the pictures live on (see
CLAUDE.md), so genres must never cost Spotify calls.

1. **MusicBrainz** (primary). An open, community-run database whose genres come from a curated list (about 2,200,
   `/ws/2/genre/all`), each with a vote count. No key, CORS open, **1 request a second** per IP, and it asks for
   a User-Agent naming the app. One artist search (`/ws/2/artist/?query=artist:"<name>"`) returns the artist's
   tags with votes; keeping only tags on the genre list gives its genres, so one request per artist is enough.
2. **Last.fm** (fallback, for artists MusicBrainz lacks or has no genres for). `artist.getTopTags` knows nearly
   every artist, but its tags are free text ("seen live", "british", "female vocalists"), so only tags on
   MusicBrainz's genre list count, which keeps the two sources in one vocabulary. Needs an API key, kept as a
   function secret.

**Matching by name** is the weak point: the export has no artist IDs. A name several artists share is resolved
toward the one with the most votes (usually the famous one). If the coverage run shows that's often wrong, the
tie-breaker is one of the user's track titles by that artist (a MusicBrainz recording search), asked only for
shared names.

## How it's fetched: a shared cache

Looking up one person's top 500 artists at 1 a second takes 8 minutes, so the answers are kept for everyone:

- **Table `artist_genres`** (in `supabase/schema.sql`): `name_key` (the normalized name) primary key, `name`,
  `mbid`, `genres` (jsonb, `[[genre, votes], ...]`), `source` (`musicbrainz` / `lastfm` / `none`),
  `fetched_at`. RLS on with no policies, like the pool; the browser reads it only through a function.
- **Edge function `genres`**: `POST {names: [...]}` (up to 100). Answers what the table has at once, looks up
  a few of the missing ones (paced to MusicBrainz's limit, Last.fm when MusicBrainz has nothing), stores them,
  and says which are still pending so the page asks again. `none` answers are kept too, and re-asked after
  30 days.
- **`js/genres.js`** in the page: asks for the artists that matter in the current view (top by listening
  time, the ones on screen first), keeps answers in localStorage like `covers.js`, and fills the view as they
  arrive. Unlike pictures, genres can't wait for what's on screen (a genre's band is the sum of many artists),
  but the cost lands on MusicBrainz and our table, never on Spotify.
- **Pre-filling (later, not a priority):** a slow job over the artists in the community pool's summaries, so
  most names are in the table before anyone asks.

## How the view works

It's the same page over the plays keyed another way, as Albums and Tracks already are (`keyedPlays` in
`main.js`, `NOUN` and `RESIZES` in `state.js`):

- **`state.dim = "genre"`**, a "Genres" button in `#view-tabs`, words in `NOUN` ("genre", "genres", "What").
- **Families, not raw genres.** MusicBrainz is fine-grained ("alternative rock", "indie rock", "rock" are
  three), so each genre maps to a family (Rock, Pop, Hip hop, Electronic, R&B / soul, Jazz, Classical,
  Metal, Folk / country, Latin, ...), from keyword rules plus a short list of overrides. The fine genres show
  in tooltips and the breakdown.
- **An artist's time is shared across their families by vote weight** (Radiohead: rock 70%, electronic 30%),
  so no artist is forced into one box. Each play becomes one weighted copy per family (`ms` times the
  weight, and a `w` for counting plays); everything that sums `ms` needs no change, and the lists count
  `p.w ?? 1`. The simpler choice, one family per artist, is a one-line change if this reads badly.
- **The split** (`#rolling-split`): in the Genres view, "Albums / Songs" becomes "Artists", so a genre's band
  breaks into its artists, colored as in the Artists view.
- **Not yet known:** artists still being looked up, or with no genre anywhere, go to "Unclassified", shown in
  gray like "Everyone else" and said plainly (how much of the time it is), never dropped silently.
- **Pictures:** a genre's key entry shows its top artist's photo (already cached from the Artists view), so
  genres cost no new picture lookups.

## Setting up Last.fm (the owner)

1. Make an API account at https://www.last.fm/api/account/create (name "Spotify (Un)Wrapped", any
   description; the callback URL can stay empty). Copy the **API key** (the shared secret isn't needed).
2. In the Supabase dashboard: Project `qvsoxqeuvpnryitechsf` -> Edge Functions -> Secrets -> add
   `LASTFM_API_KEY` with that key.
3. Later, when the function exists: Edge Functions -> Deploy a new function -> name it `genres` (it can't be
   renamed afterward) -> paste `supabase/functions/genres/index.ts` -> turn JWT verification off.
4. Run the new part of `supabase/schema.sql` in the SQL editor.

## Steps

1. Measure coverage on a real history (`dev/genre_coverage.py`). Done; results below.
2. Table, function and `genres.js`, with the coverage script's matching rules.
3. Family mapping, checked against the genres the coverage run found.
4. The Genres view: tab, keyed plays with weights, the Artists split, Unclassified, words.
5. Pre-filling from the community pool.

## Coverage on the owner's history

(Filled in from `dev/genre_coverage.py`.)

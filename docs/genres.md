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
   a User-Agent naming the app. One artist search returns each artist's tags with votes; keeping only tags on
   the genre list gives its genres, so one request is enough for most artists.
2. **Last.fm** (fallback, for artists MusicBrainz lacks or has no genres for). `artist.getTopTags` knows nearly
   every artist, but its tags are free text ("seen live", "british", "female vocalists"), so only tags on
   MusicBrainz's genre list count (with a Last.fm count of at least 10 out of 100, the top 8), which keeps the
   two sources in one vocabulary. Needs an API key, kept as a function secret.

**Matching by name** is the weak point: the export has no artist IDs. The rules, shared by the function and
`dev/genre_coverage.py` (keep them in step), learned from the coverage run:

1. **Search unfielded**, `query="<name>"`, 25 results. A fielded `artist:"Kanye West"` misses him: MusicBrainz
   names him "Ye", with "Kanye West" as an alias, and only the unfielded search looks in aliases.
2. **Candidates** are results whose name or an alias equals the asked name after normalizing (the table's
   `name_key`: NFKD, no accents, lowercase, `&` as "and", only letters and digits in any script, so CJK names
   keep their characters). One candidate is taken as it is.
3. **Several (or none), and the page sent a track** (the user's most-played title by that artist, with
   " - Remastered" and "(feat. X)" cut): one recording search, `recording:"<track>" AND artist:"<name>"`, and the
   artist credited under that name on the most matching recordings wins (counting only exact titles when there
   are any: "Time" also finds "Slime Time"). That artist may be one the artist search ranked past its first 25
   (for "Dave", the UK rapper is), and is then fetched by ID (one more request).
4. **Otherwise** the candidate with the most tag votes (usually the famous one).

## How it's fetched: a shared cache

Looking up one person's top 500 artists at 1 a second takes about 10 minutes, so the answers are kept for everyone:

- **Table `artist_genres`** (in `supabase/schema.sql`): `name_key` (the normalized name) primary key, `name`,
  `mbid`, `genres` (jsonb, `[[genre, votes], ...]`), `source` (`musicbrainz` / `lastfm` / `none`),
  `fetched_at`. RLS on with no policies, like the pool; the browser reads it only through a function.
- **Table `genre_queue`**: the names asked about that `artist_genres` doesn't know yet (`name_key`, `name`,
  `track`, `rank`, `wanted_at`, `attempts`, `next_try_at`, `claimed_until`). The names someone is asking about
  right now come first (`wanted_at`, to the minute, newest first), in the order their page sent them (`rank`, the
  period on screen first); names whose visitor left are done after. It holds at most 20,000 names, since anyone can
  add to it. Two functions, callable only by the service role: `genre_enqueue` and `genre_claim` (takes a few
  names for two minutes, `for update skip locked`, so two workers never take the same one).
- **Edge function `genres`** (`supabase/functions/genres/index.ts`), in two modes:
  - **The page asks:** `POST {artists: [{name, track}, ...], offset}` (up to 100; `track` optional; `offset` is
    where this list starts in the page's whole list) answers `{genres: {name: [[genre, votes], ...]}, pending:
    [name, ...]}` at once from the table, and puts the pending ones on the queue. It never calls MusicBrainz.
  - **The worker:** pg_cron posts to it once a minute with the header `x-worker-key` (the secret
    `GENRES_WORKER_KEY`). It answers at once and, in the background for about 50 s, claims names from the queue's
    front and looks them up (paced to MusicBrainz's limit, Last.fm when MusicBrainz has nothing), storing each
    answer and taking it off the queue. That's about 25 artists a minute, 36,000 a day. Only the worker calls
    MusicBrainz, so visitors asking at once can't go over its limit together. A lookup that fails is tried again
    after 2, 4, 8 and 16 minutes, then stored as `none`; a 503 from MusicBrainz ends the run without counting
    against the name.
  - `none` answers are kept too, and a page asking about one older than 30 days queues it again.
- **`js/genres.js`** in the page: asks for the artists that matter in the current view (top by listening
  time, the ones on screen first), keeps answers in localStorage like `covers.js`, and fills the view as they
  arrive. Its first pass hands its whole list to the queue, so all of it is looked up even if the tab closes;
  then it polls the first 100 still pending every few seconds, which keeps them at the queue's front. Unlike
  pictures, genres can't wait for what's on screen (a genre's band is the sum of many artists), but the cost lands
  on MusicBrainz and our table, never on Spotify.
- **Pre-filling:** `dev/prefill_genres.py` hands a history's artists and the community pool's top artists to the
  queue in a few seconds; the worker does the rest.

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
3. Run the Genres part of `supabase/schema.sql` in the SQL editor (`artist_genres`, `genre_queue` and its two
   functions). Safe to re-run.
4. Make up a worker key, a long random string (for example the output of `openssl rand -hex 24`), and add it
   under Edge Functions -> Secrets as `GENRES_WORKER_KEY`.
5. Edge Functions -> deploy `genres` (or open it, if it exists) -> paste `supabase/functions/genres/index.ts`
   -> JWT verification off. From here, the page's requests only queue names, so step 6 is what looks them up.
6. Integrations -> Cron -> enable it (this turns on the `pg_cron` and `pg_net` extensions). Then, in the SQL
   editor, with your key in place of `<key>`:

   ```sql
   select cron.schedule('genres-worker', '* * * * *', $$
     select net.http_post(
       url := 'https://qvsoxqeuvpnryitechsf.supabase.co/functions/v1/genres',
       headers := '{"Content-Type": "application/json", "x-worker-key": "<key>"}'::jsonb,
       body := '{}'::jsonb,
       timeout_milliseconds := 10000)
   $$);
   ```

   To check it: `select * from cron.job_run_details order by start_time desc limit 5;` shows each run, the
   function's logs show `worker: N looked up, ...`, and `select count(*) from genre_queue;` shrinks. To stop it:
   `select cron.unschedule('genres-worker');`.

## Steps

1. Measure coverage on a real history (`dev/genre_coverage.py`). Done; results below.
2. Table, function and `genres.js`, with the coverage script's matching rules.
3. Family mapping, checked against the genres the coverage run found.
4. The Genres view: tab, keyed plays with weights, the Artists split, Unclassified, words.
5. Pre-filling from the community pool, through a queue the server works through on its own. Built.

## Coverage on the owner's history

From `python3 dev/genre_coverage.py 500` on 2026-10-30, with the matching rules above and MusicBrainz only
(no Last.fm key yet). The top 500 artists are 84% of all listening time.

- **Found on MusicBrainz:** 482 of 500 (82% of all listening time). The 18 missing are small names (GARD WUZGUT,
  lul jake, Smoothtrial42, ...) and "michael", too common a word to find.
- **With at least one genre:** 383 of 500, **71% of all listening time** (85% of the top 500's). By rank: 46 of the
  top 50, 87 of the top 100, 170 of the top 200. 99 artists are on MusicBrainz with no genre votes (Spillage
  Village, Beast Coast, Tay-K, Comethazine, Flatbush Zombies, Vundabar, Current Joys, Eslabon Armado, lo-fi
  producers like MOSHi and lofi.samurai): that's Last.fm's job, so the Last.fm key is worth setting up.
- **Shared names:** 112 of the 500. Checked by hand, nearly all land on the right artist: Kanye West (found as
  "Ye" through his alias), Dave (the UK rapper, found through "Trojan Horse"; he isn't in the artist search's
  first 25), Logic (21 candidates), Saba, Bas, Drake, Future, BONES, The Game, YG, Nas, JAY-Z, Crumb, Yui (the
  artist MusicBrainz names Marceline, credited as Yui on the user's track).
- **Wrong matches** (no recording of the user's track on MusicBrainz, so the most-voted namesake won): Scrim (a
  Korean act, not the $uicideboy$ member), Medda (a metal band), halberd (a thrash band), Quality Control (a
  Glasgow punk band, not the record label's compilations), probably Maxo (an electronic artist, not the rapper).
  About 5 of 112, each a small share of time. Not worth a rule yet; a fix later could drop genres that clash
  with the rest of the user's listening, or let `name_key` rows be corrected by hand.
- **Top genres by listening time:** hip hop 20%, lo-fi 3.2%, trap 3.0%, lo-fi hip hop 2.9%, instrumental 2.4%,
  boom bap 2.3%, instrumental hip hop 2.2%, pop rap 2.2%, chillwave 2.0%, downtempo 1.8%, then a long tail of
  hip hop styles (hardcore, experimental, east coast, southern, cloud rap, conscious, jazz rap, west coast),
  indie pop, pop, electronic and indie rock at about 1% each. Genres are fine-grained, which the family mapping
  (step 3) has to fold up: most of this history is one "Hip hop" family plus "Lo-fi / instrumental".

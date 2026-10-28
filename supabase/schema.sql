-- Community pool for Spotify (Un)Wrapped.
-- Paste into Supabase → SQL Editor → Run. Safe to re-run.
--
-- The browser never touches these tables directly (RLS on, no policies).
-- Everything goes through the security-definer functions at the bottom, which validate
-- input and only ever return aggregates over at least MIN_CROWD (5) contributors.
--
-- A submission is identified by a key the browser derives from the user's own plays
-- (SHA-256 of their first 200 plays). Only someone holding the data can produce it, so it
-- doubles as the "password" for replacing or deleting a submission. We store a hash of it.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.submissions (
  key_hash      text primary key,
  hours         numeric not null,
  plays         integer not null,
  active_days   integer not null,
  artists_count integer not null,
  tracks_count  integer not null,
  clock         numeric[] not null,  -- 168 values: weekday (Mon=0) * 24 + hour, in hours
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.submission_artists (
  key_hash text not null references public.submissions on delete cascade,
  artist   text not null,
  hours    numeric not null,
  primary key (key_hash, artist)
);
create index if not exists submission_artists_artist on public.submission_artists (artist);

create table if not exists public.submission_tracks (
  key_hash text not null references public.submissions on delete cascade,
  track    text not null,
  artist   text not null,
  hours    numeric not null,
  primary key (key_hash, track, artist)
);
create index if not exists submission_tracks_track on public.submission_tracks (track, artist);

alter table public.submissions enable row level security;
alter table public.submission_artists enable row level security;
alter table public.submission_tracks enable row level security;
revoke all on public.submissions, public.submission_artists, public.submission_tracks from anon, authenticated;

create or replace function public._key_hash(p_key text) returns text
language sql immutable set search_path = public as $$
  select encode(extensions.digest(p_key, 'sha256'), 'hex')
$$;
revoke execute on function public._key_hash(text) from public, anon, authenticated;

-- ---------- Write ----------

-- p_summary: { v: 1, hours, plays, activeDays, artistsCount, tracksCount,
--              clock: [168 numbers], artists: [[name, hours]...], tracks: [[name, artist, hours]...] }
create or replace function public.submit_summary(p_key text, p_summary jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  k text;
  s jsonb := p_summary;
begin
  if p_key !~ '^[0-9a-f]{64}$' then raise exception 'invalid key'; end if;
  if octet_length(s::text) > 300000 then raise exception 'summary too large'; end if;
  if not coalesce(
       (s->>'v') = '1'
       and jsonb_typeof(s->'artists') = 'array' and jsonb_array_length(s->'artists') <= 500
       and jsonb_typeof(s->'tracks') = 'array' and jsonb_array_length(s->'tracks') <= 500
       and jsonb_typeof(s->'clock') = 'array' and jsonb_array_length(s->'clock') = 168
       and (s->>'hours')::numeric between 0 and 200000
       and (s->>'plays')::int between 0 and 10000000, false)
  then
    raise exception 'invalid summary';
  end if;

  k := _key_hash(p_key);
  delete from submissions where key_hash = k;  -- re-uploads replace, never double-count

  -- Casts below raise on malformed entries, which rolls back the whole submission
  insert into submissions (key_hash, hours, plays, active_days, artists_count, tracks_count, clock)
  values (
    k,
    (s->>'hours')::numeric,
    (s->>'plays')::int,
    (s->>'activeDays')::int,
    (s->>'artistsCount')::int,
    (s->>'tracksCount')::int,
    (select array_agg(greatest(v::numeric, 0) order by i) from jsonb_array_elements_text(s->'clock') with ordinality c(v, i))
  );

  insert into submission_artists (key_hash, artist, hours)
  select k, left(a->>0, 300), greatest((a->>1)::numeric, 0)
  from jsonb_array_elements(s->'artists') a
  where coalesce(a->>0, '') <> ''
  on conflict do nothing;

  insert into submission_tracks (key_hash, track, artist, hours)
  select k, left(t->>0, 300), left(t->>1, 300), greatest((t->>2)::numeric, 0)
  from jsonb_array_elements(s->'tracks') t
  where coalesce(t->>0, '') <> '' and coalesce(t->>1, '') <> ''
  on conflict do nothing;
end $$;

create or replace function public.delete_summary(p_key text)
returns void language sql security definer set search_path = public as $$
  delete from submissions where key_hash = _key_hash(p_key)
$$;

create or replace function public.is_shared(p_key text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from submissions where key_hash = _key_hash(p_key))
$$;

-- ---------- Read (aggregates only) ----------

create or replace function public.community_stats()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  min_crowd constant int := 5;
  n int;
begin
  select count(*) into n from submissions;
  if n < min_crowd then
    return jsonb_build_object('contributors', n, 'minCrowd', min_crowd);
  end if;

  return jsonb_build_object(
    'contributors', n,
    'minCrowd', min_crowd,
    'totalHours', (select round(sum(hours)) from submissions),
    'hours', (select jsonb_agg(round(hours) order by hours) from submissions),
    'artistCounts', (select jsonb_agg(artists_count order by artists_count) from submissions),
    -- Average of each person's clock normalized to sum 1, so heavy listeners don't dominate
    'clock', (
      select jsonb_agg(round(v, 5) order by i) from (
        select u.i, avg(u.c / nullif(t.total, 0)) as v
        from submissions s
        cross join lateral (select sum(x) as total from unnest(s.clock) x) t
        cross join lateral unnest(s.clock) with ordinality u(c, i)
        group by u.i
      ) q
    ),
    'topArtists', (
      select coalesce(jsonb_agg(jsonb_build_object('artist', artist, 'listeners', listeners, 'hours', round(hours))
                                order by listeners desc, hours desc), '[]'::jsonb)
      from (
        select artist, count(*) as listeners, sum(hours) as hours
        from submission_artists group by artist
        having count(*) >= min_crowd
        order by listeners desc, hours desc limit 50
      ) q
    ),
    'topTracks', (
      select coalesce(jsonb_agg(jsonb_build_object('track', track, 'artist', artist, 'listeners', listeners, 'hours', round(hours))
                                order by listeners desc, hours desc), '[]'::jsonb)
      from (
        select track, artist, count(*) as listeners, sum(hours) as hours
        from submission_tracks group by track, artist
        having count(*) >= min_crowd
        order by listeners desc, hours desc limit 50
      ) q
    )
  );
end $$;

-- For each of the caller's artists (up to 50): how many contributors listen to them, and how many
-- of those listened more than the caller. Hidden (null) below the minimum crowd.
create or replace function public.artist_ranks(p_artists text[], p_hours numeric[])
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'artist', q.artist,
           'listeners', case when q.listeners >= 5 then q.listeners end,
           'above', case when q.listeners >= 5 then q.above end)
         order by q.ord), '[]'::jsonb)
  from (
    select u.artist, u.ord,
           count(sa.key_hash) as listeners,
           count(sa.key_hash) filter (where sa.hours > u.hours) as above
    from unnest(p_artists[1:50], p_hours[1:50]) with ordinality u(artist, hours, ord)
    left join submission_artists sa on sa.artist = u.artist
    group by u.artist, u.ord, u.hours
  ) q
$$;

grant execute on function public.submit_summary(text, jsonb) to anon, authenticated;
grant execute on function public.delete_summary(text) to anon, authenticated;
grant execute on function public.is_shared(text) to anon, authenticated;
grant execute on function public.community_stats() to anon, authenticated;
grant execute on function public.artist_ranks(text[], numeric[]) to anon, authenticated;

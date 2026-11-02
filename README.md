# Spotify (Un)Wrapped

Spotify Wrapped is interesting but shallow. Turns out if you have Premium, you can access all the data they use to make your Wrapped, for free. **(Un)Wrapped** then creates beautiful visualizations and charts, inviting you to interact with your listening habits with more depth than a yearly slideshow.

**Try it:** https://baphaelman.github.io/Spotify-Un-Wrapped/ (no export yet? click *Try it with sample data*)

![The dashboard: the period bar, the listening mix and the Top Artists View](docs/images/dashboard.png)

## Getting started

1. Request your data: go to [Spotify's privacy settings](https://www.spotify.com/account/privacy/), scroll to *Download your data*, check **Extended streaming history** and click *Request data*. Spotify emails you a zip, usually within a few days
2. Open the site and drop in `my_spotify_data.zip`, its unzipped folder, or the `Streaming_History_Audio_*.json` files. The older *Account data* export (`StreamingHistory_music_*.json`, last year only) works too

![The landing page](docs/images/landing.png)

**Your files never leave your browser.** Everything is computed on your device, and it keeps the data until you click *Forget my data* in the settings. The only things looked up online are artist pictures and album covers (from Spotify) and artists' genres (from MusicBrainz and LastFM).

## The Page

### All about the window

All the stats generated throughout the page depend on the period you select in the timeline on the navbar. Graphs throughout the page morph as you change the period because top artists of each period might be different. The rest of the navbar controls the page similarly:

- **Timeline:** Scroll the window, or drag an edge to resize
- **Lengths and years:** preset window sizes for 30 days, 3 or 6 months, 1 or 2 years, and step back and forward with ‹ ›. You can look at a specific year or your whole history with *All time* in the dropdown
- **View:** choose whether you're breaking things up by **Genre**, **Artist**, **Album** or **Track**
- **Artists slider:** how many of your top artists the graphs show (3 to 10)
- **The key:** your top artists for the period. Hovering an artist anywhere on the page lightly shades them in every graph; click one to **pin** them, which shades them deeper, outlines them everywhere and persists through period changes. Click the color tab to hide someone. You can search for anyone in your history with *Pin an artist…*

### Listening mix

How your listening time split between your top artists in the period, with pictures. Click to pin

### Top Artists View

Each selected artist's share of your listening as stacked bands. Each point averages the days around it (*Days per slice*, from a week to half a year). You can split each artist into their **albums** or **songs**, and further explore by clicking in. Toggle **Everyone else** to add the rest of your listening as a gray band on top.

### Hours per week

The same data as above, but not stacked nor normalized. More about seeing your listening time than an artist breakdown.

![Hours per week](docs/images/hours.png)

### Top Artists over time

Your top artists day by day through the period, played like a video: bars race past each other as one artist overtakes another. Rank them by the **last few days** (the *Days* slider sets how far back) or by everything **so far** in the period. Press play, pick a speed, or drag the slider to scrub through time. Click a bar to pin. With **Everyone else** off, only your selected artists race, all starting from zero. Faint lines behind the bars mark round numbers of hours, sliding along as the leaders grow. Above the slider, a strip like a video's most-replayed graph shows when your listening bunched up (summed over the same *Days* window), filling in as the video plays.

### Hours per month

A bar per month with each month's top artist on top, and everyone else in gray unless you toggle it off.

![Hours per month](docs/images/monthly.png)

### When you listened
Similar data as the stack graph, but compressed by day. Maybe you have a sleep playlist, or you can see when you go to the gym. Toggle **Everyone else** to see the rest of your listening too.

![When you listened](docs/images/clock.png)

### Every play

Every single play in the period as a little mark: across is the day, down is the time of day (midnight at the top), and each mark is as tall as the song lasted. Your selected artists are in their colors, everyone else in gray, so you can spot the late-night binges and the weeks one artist took over. Hover a mark for the song and when you played it; click to pin.

### Every day

A calendar of the period, each day tinted by its top artist and darker the more you listened. Up to two years it's a box per day; longer than that it switches to a box per week, a row per year. Hover a day for its hours and who topped it; click to pin.

### Artist Discovery

Everyone you found in the period. Each dot is an artist (or album, or track, following the tab) you heard for the first time in the period, placed across the period at the day you first played them and as high as all the hours you've given them since. A tall dot is a find that stuck. Ones that made it into your chart's artists come in their colors and with their names, and light up with the rest of the page. Hover anywhere to read the nearest find: when you first heard it, the song you heard it through, and its hours. Click to pin it.

### All your artists

The full ranking for the period, with hours and plays. Scroll to see literally all of it.

![All your artists](docs/images/ranking.png)

### Community

If you opt in, which you should, the page shares an **anonymous summary** of your listening: your totals, your top 500 artists and tracks with hours, and a weekday × hour grid (which is compressed to make the 'When you listened' view). No timestamps, IP addresses, devices or locations. You can preview exactly what's sent before sharing and remove it any time, both under the settings cog at the right end of the sticky period bar (until you share, a big green share button sits up top too). Eventually, the **Community** tab will show how much people listen, the most shared artists and tracks, what time of day everyone listens, etc. But it needs 5 people so I can't really work on it yet---opt in please!!

### PS

- **Colors:** literally the same from day 1 but have served me well. I like riso print and synthwave
- **?** button in the top right bar explains every control and lights it up on the page as you hover.
- **Missing something?** at the bottom of the page sends a request straight to me, if you have an idea for something you'd want to see

## Running it yourself

No build step or dependencies: plain JavaScript modules, with [ECharts](https://echarts.apache.org/) for the
charts. Serve the folder with any static server:

```sh
python3 -m http.server 8000
```

and open http://localhost:8000. Opening `index.html` straight from disk won't work, because browsers block
modules over `file://`. The Community tab, pictures and genres use a [Supabase](https://supabase.com/) project,
set in `js/config.js`; its tables and functions are in [`supabase/schema.sql`](supabase/schema.sql).

[`rolling_window.py`](rolling_window.py) is the original pandas/Plotly prototype the Top Artists View grew from.

## AI Note
Claude made everything, I understand none of the server the backend, and I don't know the specifics of the graph backend. I made versions of most of these visualizations on Jupyter notebooks before asking Claude to make an interactive website with them,, it's been growing on that project since.

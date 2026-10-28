# VARIABLES
PATH_NAME = "../spotify/datas/Spotify Extended Streaming History" # TODO Change to your filepath
NUM_ARTISTS = 50
WINDOW = 30 # number of days represented per vertical slice; smoothing


import json
import pandas as pd
import plotly.express as px

from pathlib import Path


# Load all audio streaming history files
files = sorted(Path(PATH_NAME).glob("Streaming_History_Audio*.json"))

records = []

for file in files:
    with open(file, "r", encoding="utf-8") as f:
        records.extend(json.load(f))

raw = pd.DataFrame(records)
raw.head()

# basic cleaning, removing unimportant columns
columns=["platform", "conn_country", "ip_addr", "spotify_track_uri", #"ms_played",
         "episode_name", "episode_show_name", 'spotify_episode_uri',
         "audiobook_uri", 'audiobook_chapter_title', "audiobook_title", "audiobook_chapter_uri",
         "offline_timestamp", "incognito_mode"]
df = raw.drop(columns=columns)
df = df.rename(columns={"master_metadata_track_name": 'song', 'master_metadata_album_artist_name': 'artist', "master_metadata_album_album_name": 'album'})


df['ts'] = pd.to_datetime(df['ts'])
df['hours'] = df['ms_played'] / (1000 * 60 * 60)
df.head()


# Final Visualization
def rolling_graph(df, n=15, window=30):
    # Find top N artists across the entire period
        top_artists = (
            df.groupby("artist")["hours"]
            .sum()
            .nlargest(n)
            .index
            .tolist()
        )
    
        # Keep only top N artists
        filtered = df[df["artist"].isin(top_artists)].copy()
    
        # Aggregate by artist and month
        agg = (
            filtered.groupby([
                pd.Grouper(key="ts", freq="D"),
                "artist"
            ])["hours"]
            .sum()
            .reset_index()
        )
    
        # Calculate proportions among the top N artists

        wide = agg.pivot(
            index="ts",
            columns="artist",
            values="hours"
        ).fillna(0)

        # Include missing months as zero listening hours
        wide = wide.asfreq("D", fill_value=0)

        smoothed = wide.rolling(
            window=window,
            center=True,
            min_periods=window
        ).sum()
        smoothed = smoothed.dropna()
        

        # Calculate proportions from smoothed hours
        proportions = smoothed.div(
            smoothed.sum(axis=1).replace(0, float("nan")),
            axis=0
        ).fillna(0)

        # Convert back to long format for Plotly
        agg = (
            proportions.stack()
            .rename("proportion")
            .reset_index()
        )

        agg["hours"] = [
            smoothed.loc[ts, artist]
            for ts, artist in zip(agg["ts"], agg["artist"])
        ]

        # ensure we don't see artifacts from the window border (frame lol)

    
        # Interactive stacked area chart
        fig = px.area(
            agg,
            x="ts",
            y="proportion",
            color="artist",
            custom_data=["hours"],
            category_orders={"artist": top_artists},
            title=f"Rolling {window}-Day Listening History — Top {n} Artists"
        )
    
        fig.update_traces(
            hovertemplate=(
                "%{fullData.name}<br>"
                "Proportion: %{y:.1%}<br>"
                "Listening hours: %{customdata[0]:.1f}"
                "<extra></extra>"
            )
        )
    
        fig.update_layout(
            yaxis=dict(
                title="Proportion of Listening Time",
                tickformat=".0%",
                range=[0, 1]
            ),
            xaxis=dict(
                title="Time",
                rangeslider=dict(
                    visible=True,
                    thickness=0.15,
                    yaxis=dict(rangemode="fixed", range=[0, 1])
                ),
                rangeselector=dict(
                    buttons=[
                        dict(count=6, label="6m", step="month", stepmode="backward"),
                        dict(count=1, label="1y", step="year", stepmode="backward"),
                        dict(count=3, label="3y", step="year", stepmode="backward"),
                        dict(step="all", label="All")
                    ]
                ),
                dtick="M12",
                tickformat="%Y",
                showticklabels=True
            ),
            hovermode="closest",
            dragmode="zoom"
            ),
    
        fig.show()
rolling_graph(df, n=NUM_ARTISTS, window=WINDOW)
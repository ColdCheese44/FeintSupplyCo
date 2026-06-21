from __future__ import annotations

import argparse
import os
import sqlite3
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv
from rich.console import Console
from rich.table import Table

console = Console()


def resolve_project_root() -> Path:
    """Return the repository root so relative paths in the environment resolve consistently."""
    return Path(__file__).resolve().parents[1]


def resolve_database_path(project_root: Path) -> Path:
    """Resolve the SQLite database path from the environment with a project-local fallback."""
    configured_path = os.getenv("DB_PATH", "./data/jarvis.db")
    return (project_root / configured_path).resolve()


def load_analytics_frame(connection: sqlite3.Connection) -> pd.DataFrame:
    """Load analytics snapshots joined with listing metadata for grouped performance analysis."""
    query = """
    SELECT
      analytics.listing_id,
      analytics.etsy_listing_id,
      analytics.views,
      analytics.favorites,
      analytics.sales,
      analytics.revenue,
      analytics.recorded_at,
      listings.title,
      listings.price,
      niches.name AS niche_name
    FROM analytics
    LEFT JOIN listings ON listings.id = analytics.listing_id
    LEFT JOIN niches ON niches.id = listings.niche_id
    ORDER BY analytics.recorded_at DESC
    """
    return pd.read_sql_query(query, connection)


def summarize_performance(frame: pd.DataFrame) -> pd.DataFrame:
    """Group analytics by listing so operators can quickly identify high-performing products."""
    if frame.empty:
        return frame

    grouped = (
        frame.groupby(["listing_id", "title", "niche_name"], dropna=False)
        .agg({"views": "max", "favorites": "max", "sales": "max", "revenue": "max"})
        .reset_index()
    )
    grouped["conversion_rate"] = grouped.apply(
        lambda row: (row["sales"] / row["views"] * 100) if row["views"] else 0,
        axis=1,
    )
    return grouped.sort_values(["revenue", "conversion_rate"], ascending=[False, False])


def render_summary_table(summary: pd.DataFrame) -> None:
    """Print a rich summary table so the script is useful without opening a CSV file."""
    table = Table(title="Jarvis Etsy Performance")
    table.add_column("Listing ID")
    table.add_column("Title")
    table.add_column("Niche")
    table.add_column("Views")
    table.add_column("Favorites")
    table.add_column("Sales")
    table.add_column("Revenue")
    table.add_column("Conversion %")

    for _, row in summary.iterrows():
        table.add_row(
            str(row["listing_id"]),
            str(row["title"]),
            str(row.get("niche_name", "")),
            str(int(row["views"])),
            str(int(row["favorites"])),
            str(int(row["sales"])),
            f"${float(row['revenue']):.2f}",
            f"{float(row['conversion_rate']):.2f}",
        )

    console.print(table)


def parse_args() -> argparse.Namespace:
    """Parse CLI flags so operators can optionally save the analysis to CSV."""
    parser = argparse.ArgumentParser(description="Analyze Jarvis Etsy analytics data.")
    parser.add_argument("--output", default=None, help="Optional CSV output path for the aggregated summary.")
    return parser.parse_args()


def main() -> None:
    """Load analytics data, compute grouped performance, print it, and optionally export it."""
    load_dotenv()
    args = parse_args()
    project_root = resolve_project_root()
    database_path = resolve_database_path(project_root)

    with sqlite3.connect(database_path) as connection:
        raw_frame = load_analytics_frame(connection)

    summary = summarize_performance(raw_frame)
    render_summary_table(summary)

    if args.output:
        output_path = Path(args.output).resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        summary.to_csv(output_path, index=False)
        console.print(f"[green]Saved summarized analytics to {output_path}[/green]")


if __name__ == "__main__":
    main()

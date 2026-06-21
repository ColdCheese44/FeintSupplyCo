from __future__ import annotations

import argparse
import os
import sqlite3
from datetime import datetime
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv
from rich.console import Console

console = Console()


def resolve_project_root() -> Path:
    """Return the repository root so exports are created inside the project by default."""
    return Path(__file__).resolve().parents[1]


def resolve_database_path(project_root: Path) -> Path:
    """Resolve the SQLite database path from the environment with a project-local fallback."""
    configured_path = os.getenv("DB_PATH", "./data/jarvis.db")
    return (project_root / configured_path).resolve()


def default_export_path(project_root: Path) -> Path:
    """Build a timestamped CSV export path so multiple exports can coexist without overwriting."""
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return project_root / "data" / f"listings-export-{timestamp}.csv"


def load_listing_frame(connection: sqlite3.Connection) -> pd.DataFrame:
    """Load listing rows with their niche names so the CSV export is immediately useful."""
    query = """
    SELECT
      listings.id,
      listings.title,
      listings.description,
      listings.tags,
      listings.price,
      listings.image_url,
      listings.etsy_listing_id,
      listings.status,
      listings.created_at,
      listings.published_at,
      niches.name AS niche_name,
      niches.category AS niche_category
    FROM listings
    LEFT JOIN niches ON niches.id = listings.niche_id
    ORDER BY listings.created_at DESC
    """
    return pd.read_sql_query(query, connection)


def parse_args() -> argparse.Namespace:
    """Parse CLI flags so operators can choose a custom CSV output destination."""
    parser = argparse.ArgumentParser(description="Export Jarvis Etsy listings to CSV.")
    parser.add_argument("--output", default=None, help="Optional output CSV path.")
    return parser.parse_args()


def main() -> None:
    """Query the listings table and write the result set to a CSV file."""
    load_dotenv()
    args = parse_args()
    project_root = resolve_project_root()
    database_path = resolve_database_path(project_root)
    output_path = Path(args.output).resolve() if args.output else default_export_path(project_root)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with sqlite3.connect(database_path) as connection:
        frame = load_listing_frame(connection)

    frame.to_csv(output_path, index=False)
    console.print(f"[green]Exported {len(frame)} listings to {output_path}[/green]")


if __name__ == "__main__":
    main()

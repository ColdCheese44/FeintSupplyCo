from __future__ import annotations

import argparse
import json
import os
import sqlite3
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from rich.console import Console
from rich.table import Table

console = Console()


def resolve_project_root() -> Path:
    """Return the repository root so relative paths in the .env file stay stable."""
    return Path(__file__).resolve().parents[1]


def resolve_database_path(project_root: Path) -> Path:
    """Resolve the SQLite database path from the environment with a project-local fallback."""
    configured_path = os.getenv("DB_PATH", "./data/jarvis.db")
    return (project_root / configured_path).resolve()


def ensure_niches_table(connection: sqlite3.Connection) -> None:
    """Create the niches table when the Python script is run before the Node stack has initialized it."""
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS niches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          category TEXT,
          priority INTEGER DEFAULT 1,
          active BOOLEAN DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        """
    )


def load_niches(seed_file: Path) -> list[dict[str, Any]]:
    """Read the configured JSON file and validate that it contains a list of niche objects."""
    payload = json.loads(seed_file.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise ValueError(f"Expected a list of niches in {seed_file}.")
    return payload


def upsert_niches(connection: sqlite3.Connection, niches: list[dict[str, Any]]) -> int:
    """Insert new niches or update existing rows by name so the seed file stays repeatable."""
    updated_rows = 0
    for niche in niches:
        name = str(niche["name"])
        category = niche.get("category")
        priority = int(niche.get("priority", 1))
        active = 0 if niche.get("active") is False else 1

        existing = connection.execute("SELECT id FROM niches WHERE name = ?", (name,)).fetchone()
        if existing:
          connection.execute(
              "UPDATE niches SET category = ?, priority = ?, active = ? WHERE id = ?",
              (category, priority, active, existing[0]),
          )
        else:
          connection.execute(
              "INSERT INTO niches (name, category, priority, active) VALUES (?, ?, ?, ?)",
              (name, category, priority, active),
          )
        updated_rows += 1
    return updated_rows


def parse_args() -> argparse.Namespace:
    """Parse CLI flags so operators can seed a custom niche file when needed."""
    parser = argparse.ArgumentParser(description="Seed Jarvis Etsy niches into SQLite.")
    parser.add_argument(
        "--file",
        default=None,
        help="Optional path to a JSON niche file. Defaults to TARGET_NICHES_FILE or ./data/niches.json.",
    )
    return parser.parse_args()


def main() -> None:
    """Load the niche seed file, upsert it into SQLite, and print a quick summary table."""
    load_dotenv()
    args = parse_args()
    project_root = resolve_project_root()
    seed_file = Path(args.file).resolve() if args.file else (project_root / os.getenv("TARGET_NICHES_FILE", "./data/niches.json")).resolve()
    database_path = resolve_database_path(project_root)
    database_path.parent.mkdir(parents=True, exist_ok=True)

    with sqlite3.connect(database_path) as connection:
        ensure_niches_table(connection)
        niches = load_niches(seed_file)
        affected_rows = upsert_niches(connection, niches)
        connection.commit()

    table = Table(title="Jarvis Niches Seeded")
    table.add_column("Name")
    table.add_column("Category")
    table.add_column("Priority")
    for niche in niches:
        table.add_row(str(niche["name"]), str(niche.get("category", "")), str(niche.get("priority", 1)))

    console.print(table)
    console.print(f"[green]Updated {affected_rows} niche rows in {database_path}[/green]")


if __name__ == "__main__":
    main()

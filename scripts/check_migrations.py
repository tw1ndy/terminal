from pathlib import Path
import sqlite3

root = Path(__file__).resolve().parents[1]
migration_dir = root / "migrations"
files = sorted(migration_dir.glob("*.sql"))
if not files:
    raise SystemExit("No SQL migrations found")

db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys = ON")

for path in files:
    try:
        db.executescript(path.read_text(encoding="utf-8"))
        print(f"OK {path.name}")
    except sqlite3.Error as error:
        raise SystemExit(f"FAILED {path.name}: {error}") from error

tables = {
    row[0] for row in db.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
    )
}
required = {"users", "xp_wallets", "xp_transactions", "seasons",
            "season_results", "season_reward_runs", "daily_xp_ledger"}
missing = required - tables
if missing:
    raise SystemExit("Missing expected tables: " + ", ".join(sorted(missing)))

print(f"Validated {len(files)} migrations against SQLite.")

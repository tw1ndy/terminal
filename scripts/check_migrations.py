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

# Exercise the SQL idempotency pattern used by D1 batches: INSERT OR IGNORE,
# followed by an UPDATE gated by changes() = 1.
db.execute(
    "INSERT INTO users (telegram_id, joined_at) VALUES ('test-user', 1)"
)
db.execute("INSERT INTO xp_wallets (telegram_id) VALUES ('test-user')")
db.execute(
    "INSERT INTO seasons (title, starts_at, ends_at, status) VALUES ('Test', 1, 9999999999, 'active')"
)

def apply_once(source_id: str, amount: int) -> None:
    db.execute(
        """INSERT OR IGNORE INTO xp_transactions
           (telegram_id, amount, transaction_type, source_id, created_at)
           VALUES ('test-user', ?, 'season_reward', ?, 2)""",
        (amount, source_id),
    )
    db.execute(
        """UPDATE xp_wallets SET lifetime_xp = lifetime_xp + ?,
           available_xp = available_xp + ?
           WHERE telegram_id = 'test-user' AND changes() = 1""",
        (amount, amount),
    )

apply_once("season:1:place:1", 500)
apply_once("season:1:place:1", 500)
wallet = db.execute(
    "SELECT lifetime_xp, available_xp FROM xp_wallets WHERE telegram_id = 'test-user'"
).fetchone()
if wallet != (500, 500):
    raise SystemExit(f"Idempotent reward simulation failed: {wallet}")

# Monthly rewards must be unique per member, reward type and period.
db.execute(
    """INSERT OR IGNORE INTO member_rewards
       (telegram_id, reward_type, title, period_key, created_at)
       VALUES ('test-user', 'prefix', 'Winner', '2026-10', 3)"""
)
db.execute(
    """INSERT OR IGNORE INTO member_rewards
       (telegram_id, reward_type, title, period_key, created_at)
       VALUES ('test-user', 'prefix', 'Winner duplicate', '2026-10', 4)"""
)
monthly_count = db.execute(
    """SELECT COUNT(*) FROM member_rewards
       WHERE telegram_id = 'test-user' AND reward_type = 'prefix'
         AND period_key = '2026-10'"""
).fetchone()[0]
if monthly_count != 1:
    raise SystemExit(f"Monthly reward idempotency failed: {monthly_count}")

print("OK idempotent D1-style XP credit and monthly reward constraints")

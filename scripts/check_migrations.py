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
required = {"users", "user_stats", "xp_wallets", "xp_transactions", "message_events",
            "daily_xp_ledger", "seasons", "season_stats", "season_results",
            "season_reward_runs", "rewards", "reward_purchases", "penalties",
            "admins", "settings", "processed_updates", "member_rewards"}
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

# Exercise the daily XP ledger, shared cap and wallet/season accounting.
db.execute(
    "INSERT INTO users (telegram_id, joined_at) VALUES ('daily-test', 1)"
)
db.execute("INSERT INTO xp_wallets (telegram_id) VALUES ('daily-test')")

def award_daily(source_type: str, source_key: str, requested: int, cap: int, day: str) -> None:
    db.execute(
        """INSERT OR IGNORE INTO daily_xp_ledger
           (telegram_id, reward_day, source_type, source_key, amount, created_at)
           SELECT 'daily-test', ?, ?, ?, MIN(?, MAX(0, ? - COALESCE(
             (SELECT SUM(amount) FROM daily_xp_ledger
              WHERE telegram_id = 'daily-test' AND reward_day = ?), 0
           ))), 2""",
        (day, source_type, source_key, requested, cap, day),
    )
    db.execute(
        """INSERT OR IGNORE INTO xp_transactions
           (telegram_id, amount, transaction_type, source_id, note, created_at)
           SELECT 'daily-test', amount, ?, ?, 'daily cap test', 2
           FROM daily_xp_ledger
           WHERE telegram_id = 'daily-test' AND reward_day = ?
             AND source_type = ? AND source_key = ? AND amount > 0""",
        (source_type, source_key, day, source_type, source_key),
    )
    db.execute(
        """UPDATE xp_wallets SET
           lifetime_xp = lifetime_xp + (SELECT amount FROM xp_transactions
             WHERE telegram_id = 'daily-test' AND transaction_type = ? AND source_id = ?),
           available_xp = available_xp + (SELECT amount FROM xp_transactions
             WHERE telegram_id = 'daily-test' AND transaction_type = ? AND source_id = ?),
           season_xp = season_xp + (SELECT amount FROM xp_transactions
             WHERE telegram_id = 'daily-test' AND transaction_type = ? AND source_id = ?)
           WHERE telegram_id = 'daily-test' AND changes() = 1""",
        (source_type, source_key, source_type, source_key, source_type, source_key),
    )
    db.execute(
        """INSERT INTO season_stats (season_id, telegram_id, season_xp)
           SELECT id, 'daily-test', (SELECT amount FROM xp_transactions
             WHERE telegram_id = 'daily-test' AND transaction_type = ? AND source_id = ?)
           FROM seasons WHERE status = 'active' AND changes() = 1
           ON CONFLICT(season_id, telegram_id) DO UPDATE
             SET season_xp = season_xp + excluded.season_xp""",
        (source_type, source_key),
    )

award_daily("message", "message:1", 3, 200, "2026-11-19")
award_daily("message", "message:1", 3, 200, "2026-11-19")
award_daily("daily_activity", "2026-11-19", 15, 200, "2026-11-19")
award_daily("message_milestone", "50:2026-11-19", 20, 200, "2026-11-19")
for message_number in range(2, 100):
    award_daily("message", f"message:{message_number}", 3, 200, "2026-11-19")

daily_total = db.execute(
    "SELECT SUM(amount) FROM daily_xp_ledger WHERE telegram_id = 'daily-test' AND reward_day = '2026-11-19'"
).fetchone()[0]
daily_wallet = db.execute(
    "SELECT lifetime_xp, available_xp, season_xp FROM xp_wallets WHERE telegram_id = 'daily-test'"
).fetchone()
daily_season = db.execute(
    "SELECT season_xp FROM season_stats WHERE telegram_id = 'daily-test'"
).fetchone()[0]
if daily_total != 200 or daily_wallet != (200, 200, 200) or daily_season != 200:
    raise SystemExit(
        f"Daily XP cap/accounting failed: ledger={daily_total}, wallet={daily_wallet}, season={daily_season}"
    )
print("OK shared daily XP cap, duplicate prevention and wallet/season accounting")


foreign_key_errors = db.execute("PRAGMA foreign_key_check").fetchall()
if foreign_key_errors:
    raise SystemExit(f"Foreign key validation failed: {foreign_key_errors}")

owner = db.execute(
    "SELECT role, is_active FROM admins WHERE telegram_id = '891419692'"
).fetchone()
if owner != ("owner", 1):
    raise SystemExit(f"Expected seeded owner admin, got: {owner}")

default_xp = db.execute(
    "SELECT value_json FROM settings WHERE key = 'message_xp'"
).fetchone()
if default_xp != ('3',):
    raise SystemExit(f"Expected default message XP = 3, got: {default_xp}")


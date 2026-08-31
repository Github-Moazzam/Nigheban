"""Apply the SQL files in migrations/ to DATABASE_URL, in name order.

Idempotent by construction -- each file is written so a second run is a no-op.
Run it once after pulling a schema change:  python migrate_pg.py
"""
import os
import glob
import psycopg
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
load_dotenv()

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL not set in .env")
    with psycopg.connect(url) as c:
        c.autocommit = True
        for path in sorted(glob.glob(os.path.join(HERE, "migrations", "*.sql"))):
            print(f"  applying {os.path.basename(path)}")
            with open(path, encoding="utf-8") as f:
                c.execute(f.read())
        left = c.execute(
            "SELECT table_name, column_name FROM information_schema.columns "
            "WHERE table_schema='public' AND data_type LIKE 'timestamp%'").fetchall()
        if left:
            print("  WARNING: still timestamp columns:", left)
        else:
            print("  all clocks are epoch seconds")


if __name__ == "__main__":
    main()

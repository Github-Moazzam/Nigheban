"""Run one SQL statement against the database the server actually uses.

    python scripts/db.py "select username, role from users"
    python scripts/db.py "update users set role='admin' where username='srk'"

There is no connection string to remember and no second place to keep one: the
DATABASE_URL comes out of the repo's own .env, which is what nigehban_server.py
reads. Pointing a query at the wrong database is otherwise an easy mistake to
make and a hard one to notice, because both databases answer.

SELECT prints rows. Anything else prints the affected row count and commits.
"""
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
import psycopg
from psycopg.rows import dict_row

# An explicit path rather than find_dotenv(): that walks the call stack to
# locate the caller's file, and there is no such frame when python is fed a
# script on stdin -- which fails with a bare AssertionError several frames deep.
ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2

    sql = sys.argv[1]
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL not set -- is .env missing?")
        return 1

    with psycopg.connect(url, row_factory=dict_row) as conn:
        cur = conn.execute(sql)

        if cur.description is None:          # not a SELECT
            conn.commit()
            print(f"{cur.rowcount} row(s) affected, committed")
            return 0

        rows = cur.fetchall()
        if not rows:
            print("(no rows)")
            return 0

        headers = list(rows[0].keys())
        widths = [
            max(len(h), max(len(str(r[h])) for r in rows))
            for h in headers
        ]
        print("  ".join(h.ljust(w) for h, w in zip(headers, widths)))
        print("  ".join("-" * w for w in widths))
        for r in rows:
            print("  ".join(str(r[h]).ljust(w) for h, w in zip(headers, widths)))
        print(f"\n{len(rows)} row(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

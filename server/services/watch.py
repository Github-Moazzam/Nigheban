"""
The watch_state row: High Alert, the heartbeat, and when to buzz next.

The rule that reads this row is server/watch_lost.py, and it is kept pure.
This is only the part that has to touch the database.
"""

import time


def watch_row(c, uid):
    c.execute("INSERT INTO watch_state (user_id,last_beat) VALUES (%s,%s)"
              " ON CONFLICT (user_id) DO NOTHING", (uid, time.time()))
    return c.execute("SELECT * FROM watch_state WHERE user_id=%s", (uid,)).fetchone()

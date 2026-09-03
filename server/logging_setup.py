"""
One logger for the process, with a timestamp on every line.

The server used to say everything through `print()`. That is fine while
somebody is watching the terminal and useless afterwards, which is the wrong
way round for this product: the events worth reading back are the ones that
happened at 02:14 while nobody was watching. "Why did nobody get paged" is a
question about a specific minute, and an untimestamped line cannot answer it.

So every operational event goes through `get_logger(__name__)` and comes out
as

    2026-09-03 02:14:07  WARNING  nigehban.push   no registered device ...

What deliberately stays on `print()`: the startup banner in __main__.py and
migrate_pg.py's progress. Those are a person being spoken to at a terminal,
not a record of anything, and stamping a time on them only makes them harder
to read.

Set LOG_LEVEL=DEBUG in .env for more; the default is INFO.
"""

import logging
import os
import sys

ROOT_NAME = "nigehban"

# Local time, not UTC. Whoever reads this is reconstructing an evening against
# what a family remembers of it, and the clock on the wall is the one they were
# looking at. Epoch seconds -- what the database stores -- are in the messages
# themselves where they matter.
FORMAT = "%(asctime)s  %(levelname)-7s %(name)-22s %(message)s"
DATEFMT = "%Y-%m-%d %H:%M:%S"


def configure_logging():
    """Install the handler. Safe to call more than once."""
    log = logging.getLogger(ROOT_NAME)
    if log.handlers:
        return log

    level = os.environ.get("LOG_LEVEL", "INFO").upper()
    log.setLevel(getattr(logging, level, logging.INFO))

    # stdout rather than stderr: these are ordinary events, and a terminal that
    # interleaves them with the banner in the order they happened is worth more
    # than a stream split that nobody asked for. Real failures are still
    # ERROR-level and still stand out.
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter(FORMAT, datefmt=DATEFMT))
    log.addHandler(handler)

    # Nothing above this is configured by us, and letting these records reach
    # the root logger as well would print each one twice under uvicorn.
    log.propagate = False
    return log


def get_logger(name):
    """A child logger. Pass __name__; `server.` is stripped from the front."""
    short = name.split(".", 1)[1] if name.startswith("server.") else name
    return logging.getLogger(f"{ROOT_NAME}.{short}")

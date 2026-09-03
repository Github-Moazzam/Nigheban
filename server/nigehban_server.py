#!/usr/bin/env python3
"""
NIGEHBAN SERVER — the local brain and database.

Runs on the laptop. Both phones talk to it over the Wi-Fi they share. Nothing
leaves the room, which is the point: this is a safety product, so the location
of a teenage girl should not be sitting in someone else's cloud during a demo.

    pip install fastapi "uvicorn[standard]"
    python nigehban_server.py

What it owns:
    accounts        one row per person, each with a short shareable code
    invites         a link REQUIRES both people to act -- see section B1 below
    family links    who is allowed to see whose alerts (always mutual)
    alerts          every SOS, check-in and resolution, append-only
    checkins        open questions with a deadline the SERVER owns
    watch_state     High Alert mode, next buzz, last heartbeat
    delivery        a live WebSocket per signed-in phone
    the sweeper     a 5 s tick that makes deadlines true with no phone attached

Routing rule, in one sentence: an alert raised by user X is pushed to every
user linked to X, and to nobody else.

Consent rule, in one sentence: a link exists only after two people have each
taken an action -- one issues, the other redeems, or one asks and the other
accepts. Nothing about a person is revealed before that.
"""

# This file is now a shim. Everything that was here lives in the package
# alongside it -- see server/__init__.py for the layering, server/app.py for
# where the application is assembled.
#
# It stays because `python server/nigehban_server.py` is the documented way to
# start this server and appears throughout docs/. Running it, and importing it
# as `server.nigehban_server:app`, both still work.
#
# The path line is what makes the script form work: run directly, sys.path[0]
# is server/ and there is no `server` package on it, so the repo root goes in
# front. `python -m server` needs none of this and is the better command.
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server.app import app                                          # noqa: E402

if __name__ == "__main__":
    from server.__main__ import main

    main()

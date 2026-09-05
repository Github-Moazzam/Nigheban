"""
The application factory: middleware, lifespan, and the routers mounted on it.

`app` is built at import time as well, so `uvicorn server.app:app` works.

This is the only module allowed to know that all the others exist. Nothing
imports it -- see the layering note in server/__init__.py -- which is what
keeps the import graph acyclic now that there are twenty-odd modules in it.
"""

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from server.config import (
    CHECKIN_EVERY_S, LIVE_FIX_FAST_S, SOS_SAFE_STREAK, SWEEP_TICK_S,
)
from server.db import close_db, db_label, init_db
from server.hub import _BACKGROUND
from server.logging_setup import get_logger
from server.routes import ROUTERS
from server import sweeper as sweeper_mod
from server.sweeper import sweeper

log = get_logger(__name__)


@asynccontextmanager
async def lifespan(_app):
    init_db()
    task = asyncio.create_task(sweeper())
    log.info("server ready - db at %s", db_label())
    log.info("sweeper ticking every %ss - deadlines survive the phone", SWEEP_TICK_S)
    # The rules this process will actually apply, said out loud at startup.
    #
    # Not decoration. These are the product's promises, they live in config.py,
    # and the one question nobody could answer during a rollout was whether the
    # server answering the phone was the server whose source you were reading.
    # A stale process looks identical to a current one from the outside -- same
    # routes, same responses -- right up to the moment a missed check-in becomes
    # the wrong kind of alert and a family is told the quiet thing instead of
    # the loud one. One line in the terminal settles it before anybody tests.
    #
    # Read off the SWEEPER's own binding, not off config. That distinction is
    # the entire value of the line. config.py and sweeper.py are separate
    # modules with separate bytecode, and the failure worth catching is the one
    # where they disagree -- a process holding a current config next to a stale
    # sweeper answers every probe correctly and still escalates the wrong way.
    # This prints the object that actually decides.
    log.info("check-ins every %ss; a missed High Alert check-in becomes '%s'; "
             "%d answered SOS check-ins in a row stand it down; live fixes every %ss",
             int(CHECKIN_EVERY_S),
             sweeper_mod.ESCALATION.get("high_alert", "checkin_missed"),
             SOS_SAFE_STREAK, LIVE_FIX_FAST_S)
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except BaseException:
            # It was cancelled, so CancelledError above is the expected end.
            # Anything else means the sweeper had already died of something
            # else and this is the first anyone hears of it -- which is worth
            # a line, because a dead sweeper is every deadline in the product.
            log.exception("sweeper had already failed before shutdown")
        # Detached deliveries are usually an Expo call with a 5 s timeout, and
        # they are the last thing anyone wants dropped. Give them a moment to
        # land, then close the pool -- in that order, or the pool goes away
        # underneath a query still in flight.
        if _BACKGROUND:
            await asyncio.wait(set(_BACKGROUND), timeout=6)
        close_db()


# CORS is now an allowlist, and the default is empty.
#
# Nothing in this project is a browser: the app is React Native, which does not
# enforce CORS at all, and the server hands out no HTML. So an empty allowlist
# costs exactly nothing today -- every real client keeps working -- while `*`
# was standing invitation for any page on the internet to drive this API with a
# token it had got hold of.
#
# Set ALLOWED_ORIGINS (comma-separated) when something that IS a browser needs
# in -- a web console, a dashboard. The failure mode of getting it wrong is a
# loud CORS error in the devtools console, not a silent one.
ALLOWED_ORIGINS = [
    o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()
]


async def unhandled(request: Request, exc: Exception):
    """The last line before uvicorn's. Write down WHO hit WHAT, then answer.

    An unhandled exception already produced a traceback -- uvicorn logs one --
    but a traceback alone does not say which account it happened to or which
    endpoint it came from, and those are the two things that make a report
    ("my SOS did not send last night") findable afterwards. Starlette re-raises
    after this returns, so uvicorn still gets its traceback; this adds the
    identifying line in front of it.

    The Authorization header is deliberately not logged, and neither is the
    body. A token in a log file is a live session sitting in a log file.

    The response keeps the `detail` shape every other error here uses, so the
    app renders it through the same path -- see call() in src/api.js.
    """
    log.exception("unhandled %s %s (client %s)",
                  request.method, request.url.path,
                  request.client.host if request.client else "?")
    return JSONResponse(
        status_code=500,
        content={"detail": "the server hit an unexpected error - it has been logged"},
    )


def create_app():
    """Build the application. Routers are mounted in ROUTERS order -- see
    server/routes/__init__.py for why that order is not cosmetic."""
    app = FastAPI(title="Nigehban local server", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_exception_handler(Exception, unhandled)
    for router in ROUTERS:
        app.include_router(router)
    return app


app = create_app()

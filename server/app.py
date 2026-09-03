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

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from server.config import SWEEP_TICK_S
from server.db import close_db, db_label, init_db
from server.hub import _BACKGROUND
from server.routes import ROUTERS
from server.sweeper import sweeper


@asynccontextmanager
async def lifespan(_app):
    init_db()
    task = asyncio.create_task(sweeper())
    print(f"\n  Nigehban server ready - db at {db_label()}")
    print(f"  sweeper ticking every {SWEEP_TICK_S}s - deadlines survive the phone\n")
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except BaseException:
            pass
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
    for router in ROUTERS:
        app.include_router(router)
    return app


app = create_app()

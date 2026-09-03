"""
Every HTTP and websocket endpoint, grouped the way the API reads.

ROUTERS is ordered, and the order is load-bearing: FastAPI matches paths in
the order they were registered, so /checkin/self has to be mounted before
/checkin/{member_id} or the literal path is swallowed by the parameter. Within
a file that ordering is the order the routes are written in; across files it is
this list. It is the declaration order the single-file server had.
"""

from server.routes import (
    health,
    auth,
    family,
    alerts,
    devices,
    checkins,
    watch,
    samaritan,
    ws,
)

ROUTERS = [
    health.router,
    auth.router,
    family.router,
    alerts.router,
    devices.router,
    checkins.router,
    watch.router,
    samaritan.router,
    ws.router,
]

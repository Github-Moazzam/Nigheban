"""
The Nigehban server, as a package.

Split out of a single 2,674-line nigehban_server.py. The layering runs one
way and only one way:

    config -> db -> security / ratelimit / hub / geo / deps / push
           -> schemas -> services -> routes -> app

Nothing below the routes layer may import a route, and nothing at all may
import `app`. That rule is the whole reason the split holds together: the
singletons in db.py and hub.py exist once per process, and a cycle is how you
end up with two of them.

For the same reason every import inside this package is absolute
(`from server.hub import HUB`), never flat (`from hub import HUB`). A flat
import resolves to a *second* copy of the module when the server is started
as a script, which would give the process two connection pools and two
websocket registries that cannot see each other.
"""

# .env is loaded HERE, and here specifically.
#
# Importing any `server.x` imports this package first, so by the time any
# module in it runs there is no ordering left to get wrong. That matters more
# than it looks: server/db.py reads DB_POOL_MAX at import time, and a pool
# built before .env was read silently takes the default of 8 instead of the
# configured size. Silently, against a fifteen-connection cap.
#
# In the single-file server this was a bare load_dotenv() sitting among the
# imports, correct only because it happened to sit above the line that used it.
from dotenv import load_dotenv

load_dotenv()


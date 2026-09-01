"""BUG-017: signing out stops the push to that handset, and touches nothing else.

    python server/nigehban_server.py      # in one terminal
    python tests/test_signout_stops_push.py

The bug was that sign-out was entirely local. The phone dropped its session and
the server was never told, so the `devices` row kept the account's user_id and a
live push token -- and every alert to that person's family went on being
delivered to a handset nobody was signed in on, carrying a name and a link to
where somebody is right now.

Two things are worth asserting, and they pull in opposite directions:

  - the token really stops being deliverable, and
  - *nothing else* does. The account, its family and its history are untouched,
    and the next sign-in on the same phone restores delivery with no manual step.

The second is the one worth writing a test for. "Deregister the device" reads
like it deletes something belonging to the user, and the fix is only correct
because it does not.

Whether the token was actually cleared is a fact about the database, not about
any HTTP response, so those checks need DATABASE_URL -- the same value the
server and scripts/push_doctor.py read. Without it they are skipped and said to
be skipped, rather than quietly passing.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "http://127.0.0.1:8000"

PASS = FAIL = SKIP = 0

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# Everything the database half depends on, recorded as it is attempted rather
# than inferred afterwards. An earlier version reported "no DATABASE_URL /
# psycopg" for four different causes at once, which told nobody anything.
_DIAG = {"dotenv": None, "loaded": [], "found": [], "psycopg": None}

try:
    from dotenv import load_dotenv
    _DIAG["dotenv"] = "importable"
    for _p in (os.path.join(_ROOT, ".env"), os.path.join(_ROOT, "server", ".env")):
        if os.path.exists(_p):
            _DIAG["found"].append(_p)
            if load_dotenv(_p, override=True):
                _DIAG["loaded"].append(_p)
except ImportError as _e:
    _DIAG["dotenv"] = f"MISSING ({_e})"

try:
    import psycopg  # noqa: F401
    _DIAG["psycopg"] = "importable"
except ImportError as _e:
    _DIAG["psycopg"] = f"MISSING ({_e})"


def why_no_db():
    """The specific reason the database half cannot run, or None if it can."""
    if _dsn() is None:
        return "DATABASE_URL is not set in this process"
    if not str(_DIAG["psycopg"]).startswith("importable"):
        return f"psycopg not available to this interpreter: {_DIAG['psycopg']}"
    return None


def print_db_diagnostics():
    print("\n  Why the database checks could not run:")
    print(f"    interpreter    {sys.executable}")
    print(f"    python-dotenv  {_DIAG['dotenv']}")
    print(f"    psycopg        {_DIAG['psycopg']}")
    print(f"    .env found     {_DIAG['found'] or 'none'}")
    print(f"    .env loaded    {_DIAG['loaded'] or 'none'}")
    print(f"    DATABASE_URL   {'set' if os.environ.get('DATABASE_URL') else 'NOT SET'}"
          f"{'' if _dsn() else '  (set, but no postgres:// URL found inside it)'}")
    print(f"\n    -> {why_no_db()}\n")


def check(name, ok, extra=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}   {extra}")


def skip(name, why):
    global SKIP
    SKIP += 1
    print(f"  SKIP  {name}   ({why})")


def call(path, method="GET", body=None, token=None, expect_status=None):
    """expect_status: assert the call fails with this code instead of returning."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            if expect_status:
                return None
            return json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        if expect_status:
            return e.code
        raise


# ---- the half that needs the database -------------------------------------

UNCONFIGURED = "unconfigured"
_CONN = None


def _dsn():
    """DATABASE_URL, undoing the usual shell mangling. None if it is not set."""
    raw = os.environ.get("DATABASE_URL") or ""
    m = re.search(r"postgres(?:ql)?://\S+", raw.strip().strip('"').strip("'"))
    return m.group(0) if m else None


def _conn():
    """One connection for the whole run, opened on first use.

    One rather than one-per-check on purpose: these tests run against the same
    Supabase pooler the server is holding connections on, and opening six more
    is a good way to be refused for reasons that have nothing to do with the
    thing being tested.
    """
    global _CONN
    if _CONN is None:
        import psycopg
        from psycopg.rows import dict_row
        _CONN = psycopg.connect(_dsn(), row_factory=dict_row, connect_timeout=8)
        _CONN.autocommit = True
    return _CONN


def token_on_file(install_id):
    """The stored `devices` row for an install, or None if there is no row.

    Returns UNCONFIGURED when there is no DATABASE_URL or no psycopg to use it
    with. It deliberately does **not** catch anything else.

    The first version of this caught every exception and returned "no db", so a
    refused connection was reported as a skipped check and read as "you have not
    configured this" -- a failure wearing the costume of a benign absence, which
    is the exact shape of the bug this file was written to test for.
    """
    if _dsn() is None:
        return UNCONFIGURED
    try:
        import psycopg   # noqa: F401
    except ImportError:
        return UNCONFIGURED
    return _conn().execute(
        "SELECT push_token, user_id FROM devices WHERE id=%s", (install_id,)).fetchone()


def db_check(name, install_id, predicate, describe):
    """A check that only the database can answer.

    Skipped when there is nothing configured to ask. **Failed**, loudly and with
    the real error, when there is and the ask did not work -- because a check
    that could not run is not a check that passed.
    """
    global FAIL
    try:
        row = token_on_file(install_id)
    except Exception as e:
        FAIL += 1
        print(f"  FAIL  {name}")
        print(f"        the database was configured but could not be read: "
              f"{type(e).__name__}: {str(e).strip()[:200]}")
        return
    if row == UNCONFIGURED:
        skip(name, why_no_db())
        return
    check(name, predicate(row), describe(row))


def main():
    tag = int(time.time() * 1000) % 100000
    ward = call("/register", "POST", {"username": f"w{tag}", "password": "pw12", "name": "Ward"})
    other = call("/register", "POST", {"username": f"o{tag}", "password": "pw12", "name": "Cousin"})

    install = f"ins-test-{tag}"
    tok = f"ExponentPushToken[test-{tag}]"

    print("\nBUG-017 -- signing out stops the push, and does nothing else")

    # ---- the phone registers, the way it does on every sign-in --------------
    call("/device", "POST", {"id": install, "push_token": tok,
                             "platform": "android", "os_version": "34",
                             "app_version": "1.0.0"}, ward["token"])
    db_check("a signed-in phone is a delivery target", install,
             lambda r: r and r["push_token"] == tok,
             lambda r: r)

    # ---- somebody else's sign-out must not silence this phone --------------
    # Idempotent by design, so this returns ok. What must not happen is the
    # write: a guessed install id is not permission to stop another person's
    # emergencies from reaching them.
    call(f"/device/{install}", "DELETE", None, other["token"])
    db_check("another account cannot silence this phone", install,
             lambda r: r and r["push_token"] == tok,
             lambda r: r)

    # ---- and an unauthenticated one cannot either --------------------------
    code = call(f"/device/{install}", "DELETE", None, None, expect_status=True)
    check("an unauthenticated sign-out is refused", code in (401, 403), code)

    # ---- the real sign-out --------------------------------------------------
    out = call(f"/device/{install}", "DELETE", None, ward["token"])
    check("the owner's sign-out is accepted", out == {"ok": True}, out)
    db_check("the phone is no longer a delivery target", install,
             lambda r: r and r["push_token"] is None,
             lambda r: r)

    # The whole point of the fix, and the thing its name gets wrong: the row is
    # still this install, still belonging to this account. Nothing was deleted.
    db_check("...but the install still belongs to the account", install,
             lambda r: r and r["user_id"] == ward["user_id"],
             lambda r: r)

    # ---- the account is untouched ------------------------------------------
    still_there = call("/alerts?scope=mine&limit=1", token=ward["token"])
    check("the account still works after signing out of one phone",
          isinstance(still_there, list), still_there)

    # ---- signing out twice is not an error ---------------------------------
    again = call(f"/device/{install}", "DELETE", None, ward["token"])
    check("signing out twice is not an error", again == {"ok": True}, again)

    # ---- signing back in restores delivery, with no manual step ------------
    call("/device", "POST", {"id": install, "push_token": tok,
                             "platform": "android", "os_version": "34",
                             "app_version": "1.0.0"}, ward["token"])
    db_check("signing back in makes the phone deliverable again", install,
             lambda r: r and r["push_token"] == tok,
             lambda r: r)

    # ---- the legacy install id shape ---------------------------------------
    # Builds up to now registered the Expo push token itself as the install id,
    # so ids carrying brackets are on real handsets in the field. The app
    # percent-encodes them into the path; this is that same call.
    legacy = f"ExponentPushToken[legacy-{tag}]"
    call("/device", "POST", {"id": legacy, "push_token": tok,
                             "platform": "android", "os_version": "26",
                             "app_version": "1.0.0"}, ward["token"])
    quoted = urllib.parse.quote(legacy, safe="")
    out = call(f"/device/{quoted}", "DELETE", None, ward["token"])
    check("a bracketed legacy install id can sign out too", out == {"ok": True}, out)
    db_check("...and is really cleared", legacy,
             lambda r: r and r["push_token"] is None,
             lambda r: r)

    print(f"\n  {PASS} passed, {FAIL} failed, {SKIP} skipped\n")
    if SKIP:
        # Worth spelling out, because the skipped ones are not the incidental
        # checks -- they are the whole point. Everything reachable over HTTP
        # only shows that the endpoint answers.
        print("  The skipped checks are the ones that prove the token was actually")
        print("  cleared, and that another account cannot clear yours. An HTTP")
        print("  response cannot show either.")
        print_db_diagnostics()
    if _CONN is not None:
        _CONN.close()
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())

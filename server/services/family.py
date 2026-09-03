"""
Who may see whose alerts, and the two-party consent that puts them there.

THE RULE, and the reason this is a module rather than three lines inside a
route: a link exists only after two people have each taken an action.
"""

from server.db import borrow


def family_of(uid, c=None):
    """Everyone who receives uid's alerts."""
    with borrow(c) as c:
        return [r["member_id"] for r in
                c.execute("SELECT member_id FROM links WHERE owner_id=%s", (uid,))]


#
# THE RULE: a link exists only after two people have each taken an action.
#
# What was here before linked both accounts, in both directions, the instant
# anyone typed a code -- no acceptance, no notification, nothing to refuse.
# For a product whose users include people avoiding a stalker that is not a
# rough edge, it is the whole threat model walking in the front door. Two paths
# replace it, and both need two people:
#
#   1. PAIRING CODE (the good one). You generate a code, it lives ten minutes,
#      it works once. They enter it and you are linked immediately -- you
#      consented by issuing it, they consented by using it. Nothing is pending
#      because nothing is in doubt.
#
#   2. INVITE BY USER CODE (the fallback, for "add me when you get a chance").
#      Creates a request. Nothing whatsoever flows until they accept.
#
# Why the ten-minute code is the better primitive, and now the one the app
# leads with:
#
#   - A permanent code is a bearer secret that can never be taken back. One
#     screenshot, one glance over a shoulder, one old WhatsApp message and
#     someone holds a key to your location for as long as the account exists.
#     A pairing code is dead in ten minutes whether it was used or not.
#   - It is single-use, so a code shared with one person cannot quietly admit
#     a second.
#   - It carries no identity. `NGB-4F2A` is you forever and appears on your own
#     screen; `PAIR-...` is a coupon that expires.
#   - 40 bits of entropy against a ten-minute window and a rate limit is not
#     guessable. A four-character user code is ~1e6 possibilities, which is a
#     few hours of scripted guessing -- which is exactly why path 2 must never
#     say whether a code exists.


def link_both(c, a, b, relation, now):
    """Family is mutual: you each see the other's alerts.

    One-way links produce the demo-day surprise where the parent sees the
    child and the child never sees the parent's check-in. That it is mutual is
    now stated on the accept screen rather than assumed.
    """
    c.execute("INSERT INTO links VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING", (a, b, relation, now))
    c.execute("INSERT INTO links VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING", (b, a, "", now))


def pub(u, relation=""):
    """The only shape of another person we ever hand out."""
    return {"id": u["id"], "name": u["name"], "username": u["username"],
            "relation": relation}

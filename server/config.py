"""
The constants the product decides on: severities, windows, radii, deadlines.

This module imports nothing and does no work at import time. That is what
makes it safe for every other module to depend on, and it is the property to
keep: the moment this file needs the database or the hub, the layering stops
being a layering.

Pool tuning (DB_POOL_MAX and friends) deliberately lives in server/db.py
instead, next to the pool it tunes. The line drawn here is "what the product
decides" against "how one mechanism is tuned".
"""

PORT = 8000


SEVERITY = {
    # A road accident sits with the SOS, not with the fall, and the difference
    # is not a matter of degree. A fall is one person on the ground, and the
    # thing that helps is somebody who knows them arriving. A crash is that
    # plus traffic still moving through it, and the useful responder is
    # whoever is closest -- which is what severity 5 buys: the Good Samaritan
    # fan-out, and every family member paged rather than the nearest few.
    "sos": 5, "snatch": 5, "accident": 5,
    "fall": 4, "checkin_missed": 3, "watch_lost": 3,
    "going_dark": 3, "checkin_req": 2, "checkin_ack": 1, "low_battery": 1,
    # The band stopping is a maintenance problem -- the phone is still
    # reachable by push. going_dark is the phone, and that closes every path.
    "band_battery": 1,
    "sos_clear": 1, "near_miss": 1,
}

# Kinds that are written down but never sent to anybody. A cancelled fall is
# the wearer's own record that the detector nearly fired -- useful for tuning
# the thresholds in Phase 5, and not something to wake four people over.
PRIVATE_KINDS = {"near_miss"}

# Good Samaritan: how far from a severity-5 alert a stranger can be and still
# be asked, and how coarse the pin they are shown is until they say yes.
#
# Three hundred metres is a walk of a few minutes, which is the only distance
# at which "somebody near you needs help" is both true and useful. The bound is
# exclusive: at 300 m or beyond nobody is asked at all. It was 800 m, which put
# strangers a ten-minute walk away on a screen that called them close.
SAMARITAN_RADIUS_M = 300
SAMARITAN_COARSE_M = 300
PRESENCE_FRESH_S   = 900

# How long a pairing code is worth anything. Short on purpose: see PAIRING
# below. Ten minutes is "we are in the same room, or on the phone together",
# which is the situation this is actually for.
PAIR_TTL_S      = 600
CHECKIN_WINDOW_S = 90       # default deadline on "are you okay?"

# ---- what an unanswered question turns into -------------------------------
#
# Every check-in that runs out used to become the same thing: `checkin_missed`,
# severity 3, "she did not answer". For a parent's question that is exactly
# right -- the only fact anyone has is the silence.
#
# For a fall or a crash it is a serious understatement, and the understatement
# is the dangerous direction. Something measured an impact, asked the wearer
# about it, and got nothing back. That is not "did not reply to a message", it
# is "was hit and is not responding", and it has a location attached. Sending
# that to a family as a severity-3 missed check-in buries the worst event the
# product can detect under the same heading as a teenager ignoring their phone.
#
# So the reason the question was asked decides what the silence means. Anything
# not named here is a question about nothing in particular and stays
# `checkin_missed`.
INCIDENT_ESCALATION = {
    "fall":     "fall",       # severity 4
    "accident": "accident",   # severity 5 -- see SEVERITY
}

# How long an incident check-in waits before it escalates, by reason.
#
# Shorter than the 90 s a parent's question gets, and deliberately so. A manual
# check-in is answered at the wearer's convenience; these two are answered by
# somebody who has just been hit, and every second of the window is a second in
# which nobody has been called. Forty-five seconds is long enough to find the
# phone in a pocket and short enough to matter.
#
# The accident window is the shorter of the two because the failure it guards
# against is the worse one -- a motorway, at night, with traffic still coming.
INCIDENT_WINDOW_S = {"fall": 45, "accident": 30}

HIGH_ALERT_MIN_S = 300      # re-buzz window while High Alert is on
HIGH_ALERT_MAX_S = 600
BEAT_LOST_S      = 180      # armed and silent this long -> tell the family
SWEEP_TICK_S     = 5


# The channel the app files "somebody answered" under: it vibrates, and it makes
# no sound. Named here rather than inlined because both ack paths use it and it
# has to match `RESPONDER_CHANNEL_ID` in the app's notifications.js exactly -- a
# channel id Android does not recognise silently demotes the notification.
RESPONDER_CHANNEL_ID = "nigehban_sos_responder"

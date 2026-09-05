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

# The same question asked of every reason, including the two above: what does
# silence MEAN here?
#
# `high_alert` is the entry this table was really written for. A High Alert
# check-in going unanswered used to be `checkin_missed` -- severity 3, no
# siren, no takeover, a line in a list saying she did not reply. But High Alert
# is not a mode somebody drifts into. It is armed deliberately, by a person who
# has decided the next stretch of their evening needs watching, and the whole
# contract of it is "ask me every five minutes, and if I stop answering,
# something is wrong". Delivering the moment that contract comes true as the
# quietest alert in the product is exactly backwards: it is the one silence the
# wearer explicitly asked to be taken seriously.
#
# So it becomes `sos`. Sirens on every family phone, the lock-screen takeover,
# live location -- and, because nobody is there to consent, the Good Samaritan
# broadcast stays `pending` rather than going out: the wearer or a family
# member allows it from the app. A person who cannot answer a check-in cannot
# agree to have their position shown to strangers either, and the product must
# not read their silence as a yes.
#
# `sos` is deliberately NOT here. A check-in missed while an SOS is already
# live raises nothing: the family are already being sirened about this exact
# person, and a second alert on top of it is noise at the worst possible
# moment. What it does instead is reset the safe-streak -- see SOS_SAFE_STREAK.
ESCALATION = {**INCIDENT_ESCALATION, "high_alert": "sos"}

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

# ---- how often somebody is asked whether they are all right ---------------
#
# One number, and it used to be two: `random.uniform(300, 600)` -- a re-buzz
# somewhere between five and ten minutes, jittered so the wearer could not
# learn the rhythm and pre-empt it.
#
# The jitter cost more than it bought. What it bought was unpredictability
# against a wearer gaming their own safety device, which is not a real threat
# -- nobody games the thing they switched on because they were frightened. What
# it cost is the only number that matters to the person on the other end: how
# long silence can last before anybody knows about it. At the top of that range
# a wearer could be taken at 0:01 and not be missed until 11:30 -- ten minutes
# to the next question, ninety seconds to answer it. Five flat halves the worst
# case and makes the promise sayable in one sentence: you are asked every five
# minutes, and if you do not answer, your family is told.
#
# The same number twice over, and deliberately so: the interval while High
# Alert is armed, and the interval while an SOS is live. A wearer in the middle
# of an emergency should not have to learn a second rhythm.
CHECKIN_EVERY_S = 300
SOS_CHECKIN_EVERY_S = 300

# How many SOS check-ins in a row end the emergency.
#
# Two, which is ten minutes of a person answering "I am fine" while an alert
# about them is live. One is not enough and the reason is the whole design: a
# single tap is what somebody does to make a buzzing stop, and it is also what
# an attacker holding the phone can do once. Two answers five minutes apart is
# a person who was still able to answer five minutes later, which is a much
# harder thing to fake and a much better proxy for "the danger has passed".
#
# It is a RUN, not a total. Missing one puts the count back to zero -- see the
# comment on watch_state.sos_streak in migration 011.
SOS_SAFE_STREAK = 2

# ---- live location while an emergency is running --------------------------
#
# The fix on an alert row is where the button was pressed, and for a fall in a
# kitchen that is the whole answer. For a snatch, an abduction, or a walk home
# that turned bad it is the answer for about thirty seconds, and then it is a
# pin over a place nobody is any more.
#
# Nothing on a phone streams position continuously -- what every "live
# location" in the world actually is, WhatsApp's and Google's included, is a
# ping on a short interval. So this is that interval, and the only real
# question is what it costs. Ten seconds is close enough to continuous that a
# map redraws while somebody watches it, and the cost is bounded by the
# emergency rather than by the day: none of this runs unless an alert is live.
#
# It relaxes rather than stopping, because the first twenty minutes are when
# help is arriving and the hour after that is when the phone still has to be
# alive to be reached at all. A tracker that flattens the battery has closed
# every other path to the family to keep one open.
LIVE_FIX_FAST_S   = 10      # while the emergency is new
LIVE_FIX_FAST_FOR_S = 1200  # ...for the first twenty minutes
LIVE_FIX_SLOW_S   = 30      # and after that

# Tracking outlives the stand-down, and this is by how much.
#
# "I am safe" gets pressed at the roadside, in a stranger's car, or at the top
# of a street she still has to walk down -- the emergency is over and the
# journey is not. Half an hour of the family being able to see her get home is
# the difference between an alert that ends and a person who arrives.
#
# It is not indefinite and it is not silent: the wearer's own screen says
# tracking is still on and offers one tap to end it. A safety product that
# keeps reporting a position after the danger has passed, without saying so,
# is a tracking product.
TRACK_AFTER_STANDDOWN_S = 1800
TRACK_AFTER_STANDDOWN_EVERY_S = 30

# How stale a live fix may be before the family screen stops calling it live.
# Three missed fast pings, or one missed slow one, and the pin is described as
# what it is -- a last known position -- rather than as where somebody is.
LIVE_FIX_STALE_S = 45

BEAT_LOST_S      = 180      # armed and silent this long -> tell the family
SWEEP_TICK_S     = 5


# The channel the app files "somebody answered" under: it vibrates, and it makes
# no sound. Named here rather than inlined because both ack paths use it and it
# has to match `RESPONDER_CHANNEL_ID` in the app's notifications.js exactly -- a
# channel id Android does not recognise silently demotes the notification.
RESPONDER_CHANNEL_ID = "nigehban_sos_responder"

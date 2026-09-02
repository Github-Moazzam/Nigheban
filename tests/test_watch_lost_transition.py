"""The watch_lost rule, every case, in about a hundredth of a second.

    python tests/test_watch_lost_transition.py

No server, no database, no network and no waiting -- unlike the rest of this
suite, which is end-to-end on purpose. That is deliberate too. `watch_lost` is
the alert that pages a whole family about an absence, it is the one the product
is judged on at 2 a.m., and the states that get it wrong are the ones nobody
can stage on a desk: a band that drops in the same second an SOS is pressed, a
phone silent since lunch, a link flapping in a stairwell, a two-minute window
that has to end in a page exactly once.

That last one is why this file matters more than it looks. A grace window is a
promise with a clock on it, and a clock is not something anybody wants to test
by standing in a corridor with a stopwatch. Here it is a number passed to a
function.

Which is why the rule lives in server/watch_lost.py as pure functions. Read
that file first: it states the rule and, more usefully, states which side wins
each race. Everything below is that document turned into assertions.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))

import watch_lost as WL       # noqa: E402  (the path above has to come first)

BEAT_LOST_S = 180.0           # the server's silence deadline, mirrored here
GRACE_S = WL.WATCH_LOST_DELAY_S   # 120s: the band's window to come back
T = 1_000_000.0               # a fixed "now", so nothing here depends on a clock

PASS = FAIL = 0


def check(name, ok, extra=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}   {extra}")


def beat(w, *, link, virtual=False, mode_after=None, at):
    """One heartbeat, applied. Returns (decision, next state) like the server."""
    return WL.on_heartbeat(w, band_link=link, virtual=virtual,
                           mode_after=mode_after if mode_after else w.mode,
                           now=at, beat_lost_s=BEAT_LOST_S)


def drop(w, *, at):
    """A beat reporting the band gone. Returns the next state.

    Every drop in this file goes through here, so the one thing that must be
    true of all of them -- that seeing a disconnect never pages anybody by
    itself -- is asserted in all of them, rather than in the one case somebody
    remembered to write it in.
    """
    d, nxt = beat(w, link=False, at=at)
    assert not d.notify, f"a disconnect paged from the beat path: {d.reason}"
    return nxt


def back(w, *, at):
    """A beat reporting the band linked again."""
    return beat(w, link=True, at=at)[1]


def silent(w, *, at):
    return WL.on_silence(w, now=at, beat_lost_s=BEAT_LOST_S)


def sweep(w, *, at):
    """The sweeper looking at a running countdown. THIS is what pages."""
    return WL.on_grace_elapsed(w, now=at, delay_s=GRACE_S)


def linked_and_armed(mode="high_alert", at=T):
    """A phone that has been beating happily with a real band on the wrist."""
    return WL.Watch(mode=mode, last_beat=at, beat_band_link=True, beat_armed=True)


print("\n== nothing pages from the beat path any more ==")

# The headline change. A disconnect starts a clock; the clock pages. Asserted
# here as a property of the design rather than as a detail of one case.
w = drop(linked_and_armed(mode="sos"), at=T + 5)
check("a drop starts a countdown instead of an alert",
      w.link_lost_at == T + 5, w)
check("...and the countdown is stamped at the moment of the drop",
      sweep(w, at=T + 5 + GRACE_S - 1).notify is False
      and sweep(w, at=T + 5 + GRACE_S).notify is True, w)


print("\n== (a) a band that was never connected ==")

# Armed, beating, and there is no band. A wearer who armed High Alert with the
# wristband in a drawer. The old watchdog did not look at the link at all and
# paged the family the moment the phone went quiet.
never = WL.Watch(mode="high_alert", last_beat=T, beat_band_link=False, beat_armed=True)
check("a phone that never had a band link does not page on silence",
      not silent(never, at=T + 400).notify, silent(never, at=T + 400).reason)
w = drop(never, at=T + 60)
check("...and a beat reporting no link starts no countdown, having none to lose",
      w.link_lost_at is None, w)
check("...so nothing is latched by that non-event",
      not w.lost_notified and w.lost_rearm_at is None, w)


print("\n== (a, strict) a phone standing in for a band is not a band ==")

check("a virtual band is not a physical link",
      not WL.physical_link(True, True) and WL.physical_link(True, False)
      and not WL.physical_link(False, False))

virt = WL.Watch(mode="sos", last_beat=T, beat_band_link=False, beat_armed=True)
d, nxt = beat(virt, link=True, virtual=True, at=T + 60)
check("a virtual-mode beat records no band link, however armed",
      not nxt.beat_band_link and nxt.beat_armed, nxt)
check("...and starts no countdown", nxt.link_lost_at is None, nxt)
check("...so a virtual-mode phone going quiet mid-SOS pages nobody either",
      not silent(nxt, at=T + 460).notify, silent(nxt, at=T + 460).reason)

# The line the strict rule has to keep on the right side of: a REAL band in the
# same states must still work.
d, real = beat(WL.Watch(mode="sos", last_beat=T), link=True, virtual=False, at=T + 60)
check("a real band in the same beat IS recorded as a link", real.beat_band_link, real)
check("...and losing it still starts the clock",
      drop(real, at=T + 120).link_lost_at == T + 120)

# Virtual mode is inert, not merely disqualifying: switching a live band over
# to it ends a physical link, and without the guard that would start a
# countdown for a setting changed on a screen by somebody holding the phone.
d, after = beat(real, link=True, virtual=True, at=T + 120)
check("switching a linked band to virtual mid-alert starts nothing",
      not d.notify and after.link_lost_at is None, after)
check("...and the phone going quiet after the switch pages nobody either",
      not silent(after, at=T + 520).notify, silent(after, at=T + 520).reason)


print("\n== (b) connected, nothing wrong, then the band goes ==")

# The commonest disconnect in the product: the band comes off at bedtime and
# goes on the charger. Nobody is in trouble, and a family woken for this is a
# family that mutes Nigehban.
idle_linked = WL.Watch(mode="idle", last_beat=T, beat_band_link=True, beat_armed=False)
d, w = beat(idle_linked, link=False, at=T + 60)
check("a band that disconnects with no alert running starts no countdown",
      not d.notify and w.link_lost_at is None, w)
check("...and the reason says why, for the log", "no alert" in d.reason, d.reason)
check("...and the new snapshot records the link as gone",
      not w.beat_band_link and not w.beat_armed, w)
check("an idle phone going quiet with a band linked pages nobody",
      not silent(idle_linked, at=T + 400).notify)


print("\n== (c) connected, SOS running, then the band goes ==")

w = drop(linked_and_armed(mode="sos"), at=T + 5)
check("an SOS drop starts the two-minute window", w.link_lost_at == T + 5, w)
check("...and pages when it runs out", sweep(w, at=T + 5 + GRACE_S).notify)
check("an SOS phone with a live band link going silent pages the family",
      silent(linked_and_armed(mode="sos"), at=T + 400).notify)


print("\n== (d) connected, High Alert running, then the band goes ==")

w = drop(linked_and_armed(mode="high_alert"), at=T + 5)
check("a High Alert drop starts the two-minute window", w.link_lost_at == T + 5, w)
check("...and pages when it runs out", sweep(w, at=T + 5 + GRACE_S).notify)
check("...and so does the silence path in the same state",
      silent(linked_and_armed(mode="high_alert"), at=T + 400).notify)


print("\n== THE GRACE WINDOW ==")

# (8a) The band comes back inside the window. The whole point: a wrist inside a
# coat sleeve, a phone in the other pocket, a microwave. None of it is news.
w = drop(linked_and_armed(mode="sos"), at=T)
d, w = beat(w, link=True, at=T + 30)
check("(a) a band back inside the window cancels the countdown",
      w.link_lost_at is None, w)
check("...and says so, rather than silently doing nothing",
      "came back" in d.reason, d.reason)
check("...and nothing is latched, so the next real loss still pages",
      not w.lost_notified and w.lost_rearm_at is None, w)
check("...and a sweeper looking at it afterwards finds no countdown",
      not sweep(w, at=T + 600).notify, sweep(w, at=T + 600).reason)

# (8b) Still gone when the window elapses. Fires at the mark, not before.
w = drop(linked_and_armed(mode="sos"), at=T)
check("(b) nothing at one second in", not sweep(w, at=T + 1).notify)
check("...nothing at 60s", not sweep(w, at=T + 60).notify)
check("...nothing at 119s", not sweep(w, at=T + GRACE_S - 1).notify)
check("...and the page at exactly 120s", sweep(w, at=T + GRACE_S).notify)
check("...still true a tick later, since the sweeper runs every 5s",
      sweep(w, at=T + GRACE_S + 5).notify)

# Heartbeats keep arriving during the window and must not restart the clock --
# which is what would happen if a beat treated 'still gone' as a fresh drop.
w2 = w
for t in (T + 30, T + 60, T + 90, T + 110):
    d, w2 = beat(w2, link=False, at=t)
    assert not d.notify
check("...and heartbeats during the window do not restart it",
      w2.link_lost_at == T, w2)
check("...so it still fires at the original two-minute mark",
      sweep(w2, at=T + GRACE_S).notify, w2)

# (8c) The alert escalates mid-window. One page, at the original mark.
w = drop(linked_and_armed(mode="high_alert"), at=T)
d, w = beat(w, link=False, mode_after="sos", at=T + 40)   # High Alert -> SOS
check("(c) an escalation mid-window does not restart the clock",
      w.link_lost_at == T, w)
check("...and does not page on its own", not d.notify, d.reason)
check("...the page still lands at the original 120s mark",
      sweep(w, at=T + GRACE_S).notify and not sweep(w, at=T + GRACE_S - 1).notify)
check("...and it is one page, not one per escalation",
      WL.after_page(w, T + GRACE_S) and not sweep(w, at=T + GRACE_S + 1).notify)

# (8d) Flapping inside the window: drop, back, drop, back... no page, no crash,
# and each reconnect genuinely cancels rather than merely postponing.
w = linked_and_armed(mode="sos")
for i in range(6):
    w = drop(w, at=T + i * 20)
    assert w.link_lost_at == T + i * 20, "each drop starts a fresh clock"
    check(f"(d) flap {i + 1}: drop starts a clock, pages nobody",
          not sweep(w, at=T + i * 20 + 5).notify)
    w = back(w, at=T + i * 20 + 10)
    assert w.link_lost_at is None, "each reconnect cancels"
check("...six drops and six reconnects later, nothing was ever sent",
      not w.lost_notified and w.lost_rearm_at is None and w.link_lost_at is None, w)
# A seventh drop, soon enough after the last beat to still be a contiguous
# observation (past BEAT_LOST_S it would be a gap, not a transition -- which is
# what the first draft of this assertion tripped over).
check("...and the clock is genuinely reset, not merely postponed: a seventh "
      "drop counts 120s from ITSELF",
      drop(w, at=T + 150).link_lost_at == T + 150)
check("...so it pages at 270s, not at 120s from the first drop",
      sweep(drop(w, at=T + 150), at=T + 150 + GRACE_S).notify
      and not sweep(drop(w, at=T + 150), at=T + GRACE_S).notify)

# The one place the live mode still gets a vote, and it can only ever be
# quieter: standing down mid-window abandons the countdown.
w = drop(linked_and_armed(mode="sos"), at=T)
w.mode = "idle"                                  # resolved, or High Alert off
check("standing down during the window cancels the page",
      not sweep(w, at=T + GRACE_S).notify, sweep(w, at=T + GRACE_S).reason)


print("\n== (e) after a page: no duplicate, no flapping ==")

# The stairwell case, now with the window in front of it. To reach a page at
# all the band has to be gone for two solid minutes; REARM_S covers what
# happens after that.
w = drop(linked_and_armed(mode="sos"), at=T)
check("the first loss pages once the window is up", sweep(w, at=T + GRACE_S).notify)
WL.after_page(w, T + GRACE_S)
w.link_lost_at = None                            # the sweeper clears it
check("...and latches with a rearm window",
      w.lost_notified and w.lost_rearm_at == T + GRACE_S + WL.REARM_S, w)

w = back(w, at=T + GRACE_S + 10)                 # band returns straight away
check("the re-link does NOT clear the latch inside the rearm window",
      w.lost_notified, w)
w = drop(w, at=T + GRACE_S + 20)
check("...and a second loss inside it starts no countdown at all",
      w.link_lost_at is None, w)
check("...so the silence path stays quiet too",
      not silent(w, at=T + GRACE_S + 400).notify)

# But the guard is a window, not an off switch.
w2 = drop(linked_and_armed(mode="sos"), at=T)
WL.after_page(w2, T + GRACE_S)
w2.link_lost_at = None
w2 = back(w2, at=T + GRACE_S + WL.REARM_S + 1)
check("a re-link after the rearm window clears the latch",
      not w2.lost_notified and w2.lost_rearm_at is None, w2)
w2 = drop(w2, at=T + GRACE_S + WL.REARM_S + 2)
check("...so a genuinely later loss counts down and pages again",
      sweep(w2, at=T + GRACE_S + WL.REARM_S + 2 + GRACE_S).notify)


print("\n== the rearm window must not deafen the NEXT episode ==")

# Found on a real band. SOS raised, band dropped, family paged -- correctly.
# Stand down, arm High Alert a minute later, drop the band again, and NOTHING
# went out: the first episode's rearm window was still running and the second
# episode inherited it, so the product went deaf for five minutes without
# saying so.
w = drop(linked_and_armed(mode="sos"), at=T)
check("episode one pages", sweep(w, at=T + GRACE_S).notify)
WL.after_page(w, T + GRACE_S)
w.link_lost_at = None
w.mode = "idle"

w2 = WL.on_arm(w, now=T + GRACE_S + 60, beat_lost_s=BEAT_LOST_S)
check("arming a new episode clears the latch, the rearm window and any clock",
      not w2.lost_notified and w2.lost_rearm_at is None and w2.link_lost_at is None, w2)

w2.mode = "high_alert"
w2 = back(w2, at=T + GRACE_S + 61)
w2 = drop(w2, at=T + GRACE_S + 70)
check("episode two counts down, though it is inside episode one's window",
      w2.link_lost_at == T + GRACE_S + 70, w2)
check("...and pages", sweep(w2, at=T + GRACE_S + 70 + GRACE_S).notify)


print("\n== (f) already disconnected, and then an alert ==")

# The bug that started this. A phone idle and silent since lunch: `last_beat`
# is hours old, and whatever band_link it once reported stopped being true long
# ago. Then SOS is pressed, and the old watchdog paged the family on the very
# next tick for a watch lost hours before.
stale = WL.Watch(mode="idle", last_beat=T - 10800,     # three hours ago
                 beat_band_link=True, beat_armed=True)
armed = WL.on_arm(stale, now=T, beat_lost_s=BEAT_LOST_S)
check("arming refuses to inherit a band link from a stale beat",
      armed.beat_band_link is False, armed)
check("...and restarts the silence clock from the arming", armed.last_beat == T, armed)

armed.mode = "sos"
check("so the phone going quiet after that pages nobody",
      not silent(armed, at=T + 400).notify, silent(armed, at=T + 400).reason)
check("...and a beat reporting no band starts no countdown",
      drop(armed, at=T + 60).link_lost_at is None)

# The mirror image on the beat path: the link went first, the alert came after.
gone = WL.Watch(mode="sos", last_beat=T, beat_band_link=False, beat_armed=True)
check("an alert raised after the link had gone finds nothing to lose",
      drop(gone, at=T + 30).link_lost_at is None)

# But a link still up when the alert is armed IS inherited.
fresh = WL.Watch(mode="idle", last_beat=T - 30, beat_band_link=True, beat_armed=False)
armed_fresh = WL.on_arm(fresh, now=T, beat_lost_s=BEAT_LOST_S)
check("arming DOES inherit a link from a beat that is still fresh",
      armed_fresh.beat_band_link and armed_fresh.beat_armed, armed_fresh)
armed_fresh.mode = "sos"
check("...so that phone going quiet does page the family",
      silent(armed_fresh, at=T + 400).notify)


print("\n== the race: which state wins ==")

# THE STATE IMMEDIATELY BEFORE THE DISCONNECT WINS.
racing = WL.Watch(mode="sos",                  # raised since the last beat
                  last_beat=T, beat_band_link=True, beat_armed=False)
check("an alert armed before the drop counts, even if the last beat said idle",
      drop(racing, at=T + 30).link_lost_at == T + 30)

stood_down = WL.Watch(mode="idle",             # resolved since the last beat
                      last_beat=T, beat_band_link=True, beat_armed=True)
check("an alert stood down before the drop does not resurrect itself",
      drop(stood_down, at=T + 30).link_lost_at is None)

# An alert arriving WITH the beat rather than before it does not count. Quiet
# is the safe direction: the SOS pages at severity 5 on its own.
same_instant = WL.Watch(mode="idle", last_beat=T, beat_band_link=True, beat_armed=False)
d, nxt = beat(same_instant, link=False, mode_after="sos", at=T + 30)
check("an SOS arriving in the same beat as the drop starts no countdown",
      not d.notify and nxt.link_lost_at is None, nxt)
check("...but the snapshot still records it as armed for what comes next",
      nxt.beat_armed and not nxt.beat_band_link, nxt)


print("\n== the seams: a gap in the beats, and a row from before the migration ==")

# Two beats either side of a three-minute hole are not a contiguous
# observation, so the second cannot report a transition it did not witness.
check("a beat after a long gap does not claim a transition it did not see",
      drop(linked_and_armed(mode="sos", at=T), at=T + BEAT_LOST_S + 60).link_lost_at is None)

# Migrations 006/007 may not have run yet. Reading the row must degrade to
# "nothing witnessed" rather than raising inside the sweeper -- where an
# exception does not spoil one alert, it stops every deadline in the product.
old_row = {"mode": "high_alert", "last_beat": T, "lost_notified": False}
w = WL.Watch.from_row(old_row)
check("a pre-migration row reads as 'nothing witnessed' rather than raising",
      not w.beat_band_link and not w.beat_armed and w.link_lost_at is None, w)
check("...so it pages nobody until the next heartbeat fills it in",
      not silent(w, at=T + 400).notify and not sweep(w, at=T + 400).notify)
check("a missing row is not a crash either", WL.Watch.from_row(None).mode == "idle")

check("only sos and high_alert count as armed",
      WL.is_armed("sos") and WL.is_armed("high_alert")
      and not WL.is_armed("idle") and not WL.is_armed(None)
      and not WL.is_armed("something_new"))
check("a phone still reporting is never 'lost'",
      not silent(linked_and_armed(mode="sos"), at=T + BEAT_LOST_S - 1).notify)
check("a phone that has never reported at all is never 'lost'",
      not silent(WL.Watch(mode="sos", beat_band_link=True, beat_armed=True),
                 at=T + 99999).notify)
check("a row with no countdown is not something the sweeper acts on",
      not sweep(linked_and_armed(mode="sos"), at=T + 99999).notify)

print(f"\n  {PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)

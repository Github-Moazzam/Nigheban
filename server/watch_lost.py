"""WHEN "SHE WENT QUIET" IS WORTH WAKING A FAMILY FOR.

`watch_lost` is the alert that says: the wearer's watch stopped reporting, and
Nigehban cannot tell you why. It is the loudest thing the product says about an
absence rather than an event, so it has exactly one job -- and getting it wrong
in either direction is expensive. Send it when nothing happened and the family
learns to ignore the one that matters. Miss it and the whole "what if her phone
is dead" answer evaporates.

THE RULE, IN ONE SENTENCE
------------------------
The family is paged only on the TRANSITION out of a state that was genuinely
worth protecting: the phone had a live link to the band, AND an alert (SOS or
High Alert) was running, AND *then* the link went away.

Three things follow from that sentence, and each of them was a bug:

  1. It is a transition, not a reading. The sweeper used to select rows whose
     columns happened to look bad at the moment it ran, which is a different
     question -- "is this state true now" rather than "did this state just
     end". A row can arrive in the bad-looking state without anything having
     happened: raising an SOS on a phone that has been idle and silent since
     lunch flips `mode` to 'sos' against a `last_beat` three hours old, and the
     next tick pages the family for a loss that never occurred. The press
     itself already told them. See `on_silence`.

  2. The state has to be the one that existed BEFORE the loss, and it has to be
     one we actually witnessed. `mode` is live and server-owned: it is mutated
     by /alert and /watch/high_alert long after the last beat, so reading it at
     sweep time answers "is she armed now", not "was she armed when she went
     quiet". So the beat writes down what was true at the beat -- `beat_armed`,
     `beat_band_link` -- and the loss is judged against that.

  3. A link that never existed cannot be lost. `band_link` was in the row the
     whole time and the watchdog never looked at it, so an armed phone with no
     band anywhere near it reported its wearer's watch lost.

THE RACE, AND WHICH SIDE OF IT WINS
-----------------------------------
An alert can be armed or stood down in the same second the band drops, and the
two facts reach the server by different roads (an HTTP call, versus the absence
of one). The rule here is deliberate and one-directional:

    THE STATE IMMEDIATELY BEFORE THE DISCONNECT WINS.

An alert armed at 12:00:30 against a band that dropped at 12:00:31 counts --
the alert was running while the link was still up, which is exactly the state
the rule protects. An alert armed *after* the link was already gone does not,
however close behind it came. And an alert stood down before the drop does not
resurrect it.

That asymmetry is chosen rather than incidental. Being wrong in the quiet
direction costs the family nothing here, because the thing racing us is itself
an alert: an SOS raised at the moment of the drop pages everyone at severity 5
on its own. A duplicate `watch_lost` alongside it adds noise to the worst
minute of somebody's day and no information at all.

A PHONE STANDING IN FOR A BAND IS NOT A BAND
--------------------------------------------
In virtual mode the phone runs the band's firmware itself, and it reports
`band_link=true` -- correctly, because the gestures work. But there is no
wristband, and this alert is specifically about one going away. So the link
that counts here is the PHYSICAL one:

    beat_band_link = band_link AND NOT virtual

Deliberately narrow, and it costs something worth naming: a virtual-mode wearer
whose phone dies mid-SOS gets no `watch_lost`. That is the right trade anyway,
because in virtual mode the phone IS the band -- there is no second device to
report the loss of, and the family already has the SOS. What the old rule did
instead was tell them a wristband had stopped answering when no wristband had
ever existed, which sends people looking for a device that was never in play.

And the exclusion runs in BOTH directions: virtual mode is INERT here, not
merely disqualifying. A beat that reports virtual mode never pages, including
the beat that switches a real band over to it. That switch does end a physical
link, and an earlier draft of this rule treated it as the disconnect for
exactly that reason -- but it is a setting being changed on a screen, by a
person holding the phone, and paging a family about it is a false alarm with a
plausible-sounding justification behind it. `watch_lost` means a wristband
stopped answering. Nothing about virtual mode may raise it.

What still pages is a real band dropping while the app is in BLE mode -- which
is the whole feature, and is not affected by any of this, because the mode is a
stored user preference and a band going out of range does not change it.

THE GRACE WINDOW
----------------
A drop does not page anybody the moment it is seen. It starts a clock --
`WATCH_LOST_DELAY_S`, two minutes -- and the page goes out only if the band is
still gone when that clock runs out. A band that comes back inside the window
cancels the whole thing silently.

This is a debounce on the physical world, not on the code. Bluetooth drops for
reasons that are not emergencies: a wrist inside a coat sleeve, a phone in the
other pocket, a microwave, Android throttling the radio while the screen is
off. Every one of those looks identical to a torn-off band for the first few
seconds, and only one of them is worth waking a family for. Two minutes is long
enough for the link to come back on its own and short enough that a real loss
is still fresh news.

Two consequences worth knowing:

  - The countdown is held in the database (`link_lost_at`), not in a task or a
    timer. A timer belongs to a process, and this server restarting must not
    quietly cancel a countdown somebody's safety depends on.
  - The clock is watched by the sweeper, which ticks every five seconds, so the
    page lands within a few seconds of the two-minute mark rather than whenever
    the next heartbeat happens to arrive.

The countdown is about the LINK, not the alert. If High Alert escalates to SOS
while the band is away, the clock keeps running and one page goes out at the
two-minute mark -- an escalation is not a new disconnect and must not restart
the wait. The single exception is a stand-down, which cancels: see
`on_grace_elapsed`.

FLAPPING
--------
A band at the edge of range drops and re-links every few seconds. Most of that
is now absorbed by the grace window above -- a bounce never reaches the point
of paging at all. `REARM_S` is the second, coarser guard, and it covers what
the window cannot: a band that is gone for a full two minutes, comes back, and
goes again. After a page the alert is held down for `REARM_S` regardless of
what the link does in between. Arming a new episode clears it; a bounce inside
one episode does not.

Everything in this module is pure: no database, no clock, no network. The
server passes the row in and applies what comes back, and the whole rule can be
tested in milliseconds without a Postgres anywhere -- see
tests/test_watch_lost_transition.py.
"""

from collections import namedtuple

# The modes that count as "an alert is running". Anything else -- 'idle', or
# some future mode nobody has taught this rule about -- is not worth paging a
# family over an absence.
ARMED_MODES = ("sos", "high_alert")

# How long a page holds the alert down afterwards. Longer than a band takes to
# re-link on its own (seconds) and shorter than a wearer's walk home, so a
# genuinely second loss is still reported.
REARM_S = 300.0

# The grace window: how long a band may be gone before its absence is news.
#
# The one number in this file most likely to want tuning against real wrists,
# which is why it is named here rather than sitting inline at the one place it
# is compared. Lower it and the family hears about coat sleeves; raise it and a
# torn-off band is stale by the time anyone is told.
WATCH_LOST_DELAY_S = 120.0


def is_armed(mode):
    """Is an alert running? SOS or High Alert -- the two the family is paged for."""
    return (mode or "idle") in ARMED_MODES


def physical_link(band_link, virtual):
    """Was a real wristband on the other end of this, rather than the phone?

    The one place the virtual-mode rule is written down. `band_link` alone is
    true in virtual mode too -- the phone is running the firmware and the
    gestures work -- and a `watch_lost` raised off that tells a family a
    wristband stopped answering when there was never a wristband.
    """
    return bool(band_link) and not bool(virtual)


class Watch:
    """The part of a `watch_state` row this rule reasons about.

    `beat_*` are the WITNESSED fields: what the phone said about itself the
    last time it said anything. They are the whole point of this design -- they
    are the only fields that still describe the moment before a loss, minutes
    after the phone stopped being able to describe anything.

    `beat_band_link` is the PHYSICAL link -- `band_link AND NOT virtual`,
    folded in at the moment it is witnessed rather than carried as a second
    column. A phone standing in for a band is not a band, and the narrowing
    belongs at the point the fact is recorded so that nothing downstream --
    `on_arm`'s inheritance included -- can forget to apply it.
    """

    __slots__ = ("mode", "last_beat", "beat_band_link", "beat_armed",
                 "lost_notified", "lost_rearm_at", "link_lost_at")

    def __init__(self, mode="idle", last_beat=None, beat_band_link=False,
                 beat_armed=False, lost_notified=False, lost_rearm_at=None,
                 link_lost_at=None):
        self.mode = mode or "idle"
        self.last_beat = last_beat
        self.beat_band_link = bool(beat_band_link)
        self.beat_armed = bool(beat_armed)
        self.lost_notified = bool(lost_notified)
        self.lost_rearm_at = lost_rearm_at
        # When the band went away, or None if it is here. A running countdown,
        # kept in the row so it survives this process being restarted.
        self.link_lost_at = link_lost_at

    @classmethod
    def from_row(cls, row):
        """Build from a psycopg dict row, tolerating a database mid-migration.

        `.get`, not `[...]`, and for the reason spelled out in the sweeper: a
        KeyError raised inside the tick does not spoil one alert, it stops
        every deadline in the product. On a database where migration 006 has
        not landed yet the witnessed fields simply read as "nothing witnessed",
        which is the quiet answer rather than the wrong one.
        """
        if row is None:
            return cls()
        return cls(mode=row.get("mode"),
                   last_beat=row.get("last_beat"),
                   beat_band_link=row.get("beat_band_link"),
                   beat_armed=row.get("beat_armed"),
                   lost_notified=row.get("lost_notified"),
                   lost_rearm_at=row.get("lost_rearm_at"),
                   link_lost_at=row.get("link_lost_at"))

    def __repr__(self):
        return (f"Watch(mode={self.mode!r}, last_beat={self.last_beat!r}, "
                f"beat_band_link={self.beat_band_link}, beat_armed={self.beat_armed}, "
                f"lost_notified={self.lost_notified}, lost_rearm_at={self.lost_rearm_at!r}, "
                f"link_lost_at={self.link_lost_at!r})")


# `notify` is the answer; `reason` exists so the server can log WHY a page did
# or did not go out. A watchdog that only says yes or no is unfalsifiable in
# the field, and this one is only ever exercised at the worst possible moment.
Decision = namedtuple("Decision", "notify reason")


def witnessed(w, now, beat_lost_s):
    """Is the last beat recent enough that its snapshot still describes reality?

    Everything below rests on this. A snapshot older than the silence deadline
    is not knowledge of the present -- it is an archive, and a loss judged
    against an archive is the retroactive page this module exists to stop.
    """
    return w.last_beat is not None and (now - w.last_beat) <= beat_lost_s


def may_page(w, now):
    """The latch and the flap guard, together.

    `lost_notified` stops a condition that stays true from paging every tick;
    `lost_rearm_at` stops a link that flaps from paging on every re-drop.
    """
    if w.lost_notified:
        return False
    return w.lost_rearm_at is None or now >= w.lost_rearm_at


def on_heartbeat(w, *, band_link, virtual, mode_after, now, beat_lost_s):
    """A beat arrived. Did the band disconnect between the last one and this?

    This is the fast path: the phone is alive and healthy and is telling us,
    itself, that the band is gone. It is the closest thing the server has to
    the disconnect event, which is why the app fires a beat immediately on a
    link change rather than waiting out the minute -- see useHeartbeat.

    `band_link` and `virtual` are this beat's raw claims and are narrowed to a
    physical link here; a phone standing in for a band never counts as one.

    `mode_after` is the mode this beat leaves the row in. The PRE-disconnect
    armed state is read from `w.mode`, the mode as it stood before this beat
    was applied: that is the state that existed while the link was still up,
    and by the rule at the top of this file it is the one that wins.

    NOTHING HERE PAGES ANYBODY. A drop starts the grace window instead --
    `nxt.link_lost_at` -- and `on_grace_elapsed` decides two minutes later,
    from the sweeper. So `Decision.notify` is always False on this path; the
    reason string is what says which of the several nothings just happened.

    Returns (Decision, next-state Watch). The server writes the second whatever
    the first says.
    """
    link = physical_link(band_link, virtual)
    contiguous = witnessed(w, now, beat_lost_s)
    was_linked = contiguous and w.beat_band_link
    was_armed = is_armed(w.mode)
    dropped = was_linked and not link
    pending = w.link_lost_at            # a countdown already running, or None

    if virtual:
        # Virtual mode is inert, and this branch is why the check sits ahead of
        # the drop logic rather than inside it. A phone switching over from a
        # real band DOES end a physical link, so `dropped` is true here and
        # would otherwise start a countdown -- for a setting changed on a
        # screen by somebody holding the phone. `watch_lost` means a wristband
        # stopped answering; nothing about virtual mode is allowed to raise it.
        pending = None
        decision = Decision(False, "virtual mode: no wristband in play")
    elif link and pending is not None:
        # THE CANCEL. The band came back, and it came back before the window
        # ran out -- otherwise the sweeper would have paged and cleared this
        # already. A brief drop, and the family never hears about it.
        pending = None
        decision = Decision(False, "band came back inside the grace window")
    elif dropped and was_armed and may_page(w, now):
        # THE START. Not a page: a two-minute clock, written to the row so it
        # outlives this request and this process.
        pending = now
        decision = Decision(False, "band link dropped while armed -- grace window started")
    elif dropped and was_armed:
        decision = Decision(False, "band link dropped while armed, but already paged")
    elif dropped:
        # (b) in the spec: a band put on the charger while nothing is wrong.
        # An ordinary evening, and not news.
        decision = Decision(False, "band link dropped, but no alert was running")
    elif not link and was_armed and not was_linked:
        # (a) and (f): armed with no band, armed only after the link had
        # already gone, or a virtual band, which is no band. There is no
        # transition here to report -- nothing was lost, because nothing was
        # held.
        decision = Decision(False, "no live band link to lose")
    elif pending is not None:
        # Still gone, and the clock is still running. Every heartbeat during
        # the window lands here, and the one thing it must not do is restart
        # the countdown -- `pending` is carried through untouched.
        decision = Decision(False, "still gone, grace window running")
    else:
        decision = Decision(False, "link intact")

    nxt = Watch(mode=mode_after,
                last_beat=now,
                # The new witnessed state: what this beat just told us, with
                # virtual mode already narrowed out.
                beat_band_link=link,
                beat_armed=is_armed(mode_after),
                lost_notified=w.lost_notified,
                lost_rearm_at=w.lost_rearm_at,
                link_lost_at=pending)

    if w.lost_notified and (w.lost_rearm_at is None or now >= w.lost_rearm_at):
        # Recovered, and the flap window has passed: a future loss may page
        # again. Inside the window the latch deliberately stays down -- that is
        # the whole anti-flap, and clearing it here on every beat is what made
        # one bad pocket page a family a dozen times.
        nxt.lost_notified = False
        nxt.lost_rearm_at = None

    return decision, nxt


def on_grace_elapsed(w, *, now, delay_s):
    """The countdown ran out. Is the band still gone, and is this still news?

    Called by the sweeper for every row with a `link_lost_at` set. It ticks
    every five seconds, so the page lands within a few seconds of the mark
    rather than waiting on the next heartbeat, which could be most of a minute
    away.

    The window is about the LINK and nothing else. An alert escalating inside
    it -- High Alert becoming an SOS while the band is away -- does not restart
    the clock and does not add a second page: the disconnect happened once, and
    it is the disconnect being reported.

    A stand-down is the exception, and it is the one place the live `mode` gets
    a vote. If the wearer disarms or resolves during the window, the countdown
    is abandoned. This is not a hedge about escalation, it is the difference
    between "she is not answering" and "she took the band off and said she is
    fine" -- and paging a family two minutes after somebody explicitly stood
    the alert down is the kind of false alarm that gets an app uninstalled. It
    can only ever make this quieter; nothing here can arm anything.
    """
    if w.link_lost_at is None:
        return Decision(False, "no countdown running")
    if now - w.link_lost_at < delay_s:
        return Decision(False, "still inside the grace window")
    if not is_armed(w.mode):
        return Decision(False, "stood down during the grace window")
    if not may_page(w, now):
        return Decision(False, "already paged")
    return Decision(True, "band still gone when the grace window ran out")


def on_silence(w, *, now, beat_lost_s):
    """No beat for `beat_lost_s`. Was the state we last witnessed worth paging?

    The other half of the same rule, for the loss the phone cannot report
    because the phone is the thing that went. The transition here is time
    crossing the deadline, and the state judged is the last one we witnessed --
    never the live `mode`, which anything may have changed since.
    """
    if w.last_beat is None:
        # Never reported at all. There is no "before" to have lost.
        return Decision(False, "never reported")
    if now - w.last_beat <= beat_lost_s:
        return Decision(False, "still reporting")
    if not is_armed(w.mode):
        # Stood down since. The one direction in which the LIVE mode still
        # gets a vote: "I am fine" is an answer, and an answer that arrives
        # after the silence began is still an answer. It can only ever make
        # this quieter -- it cannot arm anything, which is what stops (f).
        return Decision(False, "stood down since")
    if not w.beat_armed:
        # Idle when it went quiet: a phone in a pocket, or switched off on
        # purpose. Note that an armed phone is the only one that beats at all,
        # so this is belt and braces -- and it is the belt that stops (f).
        return Decision(False, "was not armed when it went quiet")
    if not w.beat_band_link:
        # (a): armed, but there was no wristband on the other end of this --
        # none at all, or the phone standing in for one in virtual mode.
        # Whatever went wrong, no watch was lost, and calling it that sends a
        # family looking for a device that was never in play.
        return Decision(False, "no physical band link when it went quiet")
    if not may_page(w, now):
        return Decision(False, "already paged")
    return Decision(True, "armed with a live band link, then silence")


def after_page(w, now):
    """The latch to write once a page has gone out. Same on both paths."""
    w.lost_notified = True
    w.lost_rearm_at = now + REARM_S
    return w


def on_arm(w, *, now, beat_lost_s):
    """An alert was armed by an endpoint rather than by a beat.

    /watch/high_alert and an SOS through /alert both start the silence clock:
    from here on, quiet is a signal. But arming carries no first-hand knowledge
    of the band -- the phone did not mention it -- so the witnessed link is
    inherited only if the last beat is recent enough to still be true.

    Without that, a phone silent since morning could be armed and inherit a
    `band_link=true` from a beat nobody has any reason to believe any more, and
    the silence path would page the family about a link that ended hours ago.
    This is case (f) of the spec on the endpoint side: an alert raised after the
    link was already gone must not resurrect it.
    """
    fresh = witnessed(w, now, beat_lost_s)
    return Watch(mode=w.mode,
                 last_beat=now,
                 beat_band_link=w.beat_band_link if fresh else False,
                 beat_armed=True,
                 # A NEW EPISODE STARTS COMPLETELY CLEAN -- the latch and the
                 # flap window both.
                 #
                 # An earlier version kept `lost_rearm_at` across an arming, on
                 # the reasoning that a page held down should stay held down.
                 # That was wrong, and wrong in the direction that loses
                 # alerts: it silently deafened the next five minutes of the
                 # product. Raise an SOS, lose the band, get the page --
                 # correctly -- then stand down, arm High Alert and lose the
                 # band again a minute later, and nothing goes out at all.
                 # Which is exactly what it looked like from the outside:
                 # "watch lost works for SOS but does nothing for High Alert".
                 #
                 # The flap guard exists for a link bouncing at the edge of
                 # range WITHIN one armed episode. Arming is a person deciding
                 # something -- a thumb on a button, or an SOS press -- and no
                 # flapping band can produce one, so there is nothing here for
                 # the window to protect against.
                 lost_notified=False,
                 lost_rearm_at=None,
                 # A countdown left over from the previous episode goes with
                 # it. The band it was counting for belonged to a situation
                 # that is over.
                 link_lost_at=None)

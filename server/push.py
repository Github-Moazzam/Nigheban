"""
Expo push: the delivery path that survives a killed app.

The websocket reaches an app that is open. This reaches one that is not, which
on Android is most of the time and always the case that matters.
"""

import asyncio
import json
import logging
import urllib.error
import urllib.request
from contextlib import closing

from server.db import db
from server.logging_setup import get_logger

log = get_logger(__name__)


def push_tokens_for(uids):
    """Push tokens for a set of users."""
    if not uids:
        return []
    with closing(db()) as c:
        rows = c.execute(
            "SELECT DISTINCT push_token FROM devices WHERE push_token IS NOT NULL"
            " AND push_token != ''"
            " AND user_id = ANY(%s)", (list(uids),)).fetchall()
    return [r["push_token"] for r in rows]


def forget_push_tokens(tokens):
    """Drop tokens Expo says are gone, so a dead install stops being retried.

    The row stays -- it is still that person's handset, and the next
    registration fills the token back in.
    """
    with closing(db()) as c:
        c.execute("UPDATE devices SET push_token=NULL WHERE push_token = ANY(%s)",
                  (list(tokens),))
        c.commit()
    log.info("forgot %d unregistered push token(s)", len(tokens))


async def send_expo_push_notifications(uids, title, body, data=None, silent=False,
                                       channel=None, ttl=None, sound="default"):
    """Send Hardware Remote Push Notification via Expo Push Service API.

    Delivers notifications directly to Android system push framework even when
    the app is completely closed or killed.

    `silent=True` sends a data-only push: no title, no body, nothing shown. It
    exists for one reason, and it is the reason N3.3 works at all. Expo only
    runs the app's background notification task on a terminated app for a push
    carrying `data` and nothing else -- a push with a title is drawn by the
    system and the app is never woken. So the task that fires the lock-screen
    takeover can only be reached this way, and a severity-4-or-worse alert
    therefore goes out twice: once visibly, so something appears even if the
    silent one is dropped, and once silently, to start the siren.

    `channel`, `ttl` and `sound` override what severity would otherwise decide.
    They exist for the one push that travels the other way -- to the person in
    trouble rather than to the people being called. "Somebody answered" must not
    be filed on the DND-bypassing siren channel, and it stops being worth
    delivering long before the informational hour is up.

    On Android 8+ the channel owns the sound and `sound` here is redundant, but
    it is sent anyway: a phone whose channel was somehow created by an older
    build would otherwise fall back to "default" and make a noise next to
    somebody hiding.

    Returns a summary of what actually happened:

        {"targets": n, "tokens": n, "accepted": n, "dropped": n, "error": str|None}

    It used to return None in every case -- success, total failure, and "nobody
    has a token" were indistinguishable to every caller. For the delivery path
    that survives a killed app, in a product whose entire job is delivery, that
    was the wrong thing not to know. Nothing is obliged to read the result, but
    `accepted == 0` is logged at ERROR for anything urgent, so a night where an
    SOS reached no phone leaves a mark that can be found afterwards.
    """
    sev = (data or {}).get("severity", 0)
    urgent = sev >= 4

    tokens = push_tokens_for(uids)
    if not tokens:
        # Saying nothing here looked exactly like a successful send: the alert
        # fanned out, the log said "0 online", and that was the last line
        # printed. But "nobody has a push token" is the entire failure, not a
        # quiet edge case -- it is the difference between an alert that reaches
        # a closed phone and one that reaches nobody at all.
        log.log(logging.ERROR if urgent else logging.WARNING,
                "no registered device among %d target(s) -- nothing sent"
                " (has the family member opened the app and granted"
                " notifications?)", len(uids))
        return {"targets": len(uids), "tokens": 0, "accepted": 0,
                "dropped": 0, "error": "no registered device"}

    # How long this push is still worth delivering.
    #
    # Expo's default is four weeks, which for an emergency is not a default so
    # much as a bug: a severity-5 push queued while a phone was in a tunnel can
    # ring at 3 a.m. the next day, long after the wearer stood the alert down.
    # A family member woken by a siren for an emergency that ended yesterday
    # learns to distrust the siren, and that is the whole product.
    #
    # Five minutes for anything urgent -- long enough to survive a lift, a
    # tunnel or a moment of Doze, short enough that nothing arrives describing
    # a situation that has already moved on. It is deliberately not 0: "deliver
    # this instant or discard" would throw away real alerts over a two-second
    # network blip. An hour for the rest, which are informational.
    ttl = ttl if ttl is not None else (300 if sev >= 4 else 3600)

    payloads = []
    sent_tokens = []
    for token in tokens:
        if token.startswith("ExponentPushToken[") or token.startswith("ExpoPushToken["):
            if silent:
                # No title, no body, no sound, no channel. Anything shown here
                # would be a second visible notification for one emergency, and
                # -- the part that actually breaks it -- a push carrying a title
                # is handled by the system instead of being handed to the app,
                # so the background task would never run.
                payloads.append({
                    "to": token,
                    "priority": "high",
                    "ttl": ttl,
                    "data": data or {},
                    "_contentAvailable": True,
                })
            else:
                payloads.append({
                    "to": token,
                    "title": title,
                    "body": body,
                    "sound": sound,
                    "priority": "high",
                    "ttl": ttl,
                    "data": data or {},
                    "channelId": channel or ("nigehban_emergency_alarm" if sev >= 4
                                             else "nigehban_default")
                })
            sent_tokens.append(token)

    if not payloads:
        # Every token was an unrecognised shape. Rare, but it is still a send
        # that reached nobody, and it should read as one.
        log.log(logging.ERROR if urgent else logging.WARNING,
                "no usable Expo token among %d device(s) -- nothing sent",
                len(tokens))
        return {"targets": len(uids), "tokens": len(tokens), "accepted": 0,
                "dropped": 0, "error": "no usable token"}

    dead = []

    def _do_post():
        """Returns (accepted, error). Never raises -- it runs in a worker."""
        try:
            req = urllib.request.Request(
                "https://exp.host/--/api/v2/push/send",
                data=json.dumps(payloads).encode('utf-8'),
                headers={"Content-Type": "application/json", "Accept": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                raw = resp.read().decode('utf-8')
            # Expo returns 200 even when every ticket failed (bad token,
            # DeviceNotRegistered, or -- the usual reason nothing arrives --
            # missing FCM V1 credentials for this project). Log each ticket's
            # status so a "why no push" question never needs the app rebuilt
            # to answer; see NIGEHBAN_BUILD_GUIDE.md / DEVELOPMENT_PLAN.md N3.1.
            try:
                tickets = json.loads(raw).get("data", [])
            except Exception:
                tickets = []
            ok = 0
            for token, ticket in zip(sent_tokens, tickets):
                status = ticket.get("status")
                if status == "ok":
                    ok += 1
                    continue
                details = ticket.get("details")
                detail = ticket.get("message") or details
                log.warning("ticket error %s... -> %s: %s",
                            token[:24], status, detail)
                if isinstance(details, dict) and details.get("error") == "DeviceNotRegistered":
                    dead.append(token)
            kind = "silent" if silent else "visible"
            log.info("%s push: %d/%d accepted by Expo",
                     kind, ok, len(sent_tokens))
            return ok, None
        except urllib.error.HTTPError as e:
            # "HTTP Error 400: Bad Request" on its own says nothing, and this is
            # the one failure mode where Expo does explain itself: a 4xx body is
            # JSON carrying a `code` and a `message` that name the actual
            # problem. PUSH_TOO_MANY_EXPERIENCE_IDS -- push tokens minted by two
            # different EAS projects batched into one request -- is the usual
            # one after the project id changes, and it is invisible without this.
            try:
                err_body = e.read().decode('utf-8', 'replace')
            except Exception:
                err_body = '(no body)'
            log.error("Expo refused the batch: HTTP %s %s -- %s",
                      e.code, e.reason, err_body[:600])
            return 0, f"HTTP {e.code} {e.reason}: {err_body[:200]}"
        except Exception as e:
            # Almost always the 5 s timeout, or no route to exp.host. Neither
            # is this server's fault and neither is recoverable from here --
            # but it is the whole delivery path for a closed app, so it is an
            # error, not a note.
            log.error("Expo send failed (%s: %s)", type(e).__name__, e)
            return 0, f"{type(e).__name__}: {e}"

    accepted, error = await asyncio.to_thread(_do_post)
    if dead:
        await asyncio.to_thread(forget_push_tokens, dead)

    # The line that answers "did last night's SOS actually leave the building".
    # Zero accepted with tokens on file is a delivery failure, not a quiet one:
    # every phone in that family was closed, and this was the path that was
    # supposed to reach them anyway.
    if accepted == 0:
        log.log(logging.ERROR if urgent else logging.WARNING,
                "push reached NOBODY: %d target(s), %d token(s), severity %s%s",
                len(uids), len(sent_tokens), sev,
                f" -- {error}" if error else "")

    return {"targets": len(uids), "tokens": len(sent_tokens),
            "accepted": accepted, "dropped": len(dead), "error": error}

"""
Expo push: the delivery path that survives a killed app.

The websocket reaches an app that is open. This reaches one that is not, which
on Android is most of the time and always the case that matters.
"""

import asyncio
import json
import urllib.error
import urllib.request
from contextlib import closing

from server.db import db


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
    print(f"  [expo push] forgot {len(tokens)} unregistered token(s)")


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
    """
    tokens = push_tokens_for(uids)
    if not tokens:
        # Saying nothing here looked exactly like a successful send: the alert
        # fanned out, the log said "0 online", and that was the last line
        # printed. But "nobody has a push token" is the entire failure, not a
        # quiet edge case -- it is the difference between an alert that reaches
        # a closed phone and one that reaches nobody at all.
        print(f"  [expo push] no registered device among {len(uids)} target(s)"
              f" -- nothing sent (has the family member opened the app and"
              f" granted notifications?)")
        return

    sev = (data or {}).get("severity", 0)

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
        return

    dead = []

    def _do_post():
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
                print(f"  [expo push ticket error] {token[:24]}... -> {status}: {detail}")
                if isinstance(details, dict) and details.get("error") == "DeviceNotRegistered":
                    dead.append(token)
            kind = "silent" if silent else "visible"
            print(f"  [expo push/{kind}] {ok}/{len(sent_tokens)} accepted by Expo")
        except urllib.error.HTTPError as e:
            # "HTTP Error 400: Bad Request" on its own says nothing, and this is
            # the one failure mode where Expo does explain itself: a 4xx body is
            # JSON carrying a `code` and a `message` that name the actual
            # problem. PUSH_TOO_MANY_EXPERIENCE_IDS -- push tokens minted by two
            # different EAS projects batched into one request -- is the usual
            # one after the project id changes, and it is invisible without this.
            try:
                body = e.read().decode('utf-8', 'replace')
            except Exception:
                body = '(no body)'
            print(f"  [expo push error] HTTP {e.code} {e.reason} -- {body[:600]}")
        except Exception as e:
            print(f"  [expo push error] {e}")

    await asyncio.to_thread(_do_post)
    if dead:
        await asyncio.to_thread(forget_push_tokens, dead)

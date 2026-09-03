"""
Handset registration, and forgetting a handset at sign-out.
"""

import re
import time
from contextlib import closing

from fastapi import APIRouter, Depends, HTTPException

from server.db import db
from server.deps import me
from server.ratelimit import LIMIT
from server.schemas import DeviceIn


router = APIRouter()


# ---- devices ------------------------------------------------------------
@router.post("/device")
def register_device(b: DeviceIn, u=Depends(me)):
    """Claim an install for this account, with its push token.

    Keyed on the install id, so signing in on a phone that used to belong to
    somebody else moves the row rather than leaving a second account's push
    token pointed at the same handset.
    """
    LIMIT.check("device_register", u["id"], 30, 600,
                "too many device registrations - wait a few minutes")
    # Brackets are allowed because builds up to now sent the Expo push token
    # itself as the install id, and "ExponentPushToken[...]" failed this check
    # -- so every registration 400'd, the devices table stayed empty, and no
    # alert was ever pushed to a closed app. The app now sends a real install
    # id; accepting the old shape means a handset that is already installed
    # starts working without waiting on a new build.
    if not re.fullmatch(r"[A-Za-z0-9_.:\[\]-]{8,64}", b.id or ""):
        raise HTTPException(400, "bad install id")
    with closing(db()) as c:
        c.execute(
            "INSERT INTO devices (id,user_id,push_token,platform,os_version,app_version,last_seen)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s)"
            " ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,"
            " push_token=excluded.push_token, platform=excluded.platform,"
            " os_version=excluded.os_version, app_version=excluded.app_version,"
            " last_seen=excluded.last_seen",
            (b.id, u["id"], b.push_token, b.platform, b.os_version, b.app_version,
             time.time()))
        c.commit()
    return {"ok": True}


@router.delete("/device/{install_id}")
def stop_push_to_device(install_id: str, u=Depends(me)):
    """Stop pushing to this handset, because nobody is signed in on it any more.

    Sign-out used to be entirely local: the phone dropped its session and the
    server was never told. The row here kept this account's user_id and a live
    token, so every alert to this person's family went on being delivered to a
    handset they had signed out of -- name, alert kind, and the maps link to
    where they are. On a phone that has changed hands, a stranger reads it.

    **Only the token is cleared. The account is not touched.** Nothing about the
    user, their family, their history or their band changes, and the next
    sign-in on this phone fills the token straight back in through POST /device.
    `user_id` stays because the column is NOT NULL, and because there is no
    reason to disturb it: push_tokens_for() already filters on the token, so
    clearing that is the entire fix.

    Scoped with `AND user_id=%s` so a guessed install id cannot silence somebody
    else's phone. Deliberately idempotent -- signing out twice, or from a phone
    that never registered, is not an error and must not fail the sign-out.
    """
    # Generous, and it stays that way: a 429 on the way out would leave a live
    # push token on a handset the user believes they have signed out of, which
    # is the exact leak this endpoint was added to close.
    LIMIT.check("device_forget", u["id"], 60, 600,
                "too many sign-outs at once - wait a few minutes")
    with closing(db()) as c:
        c.execute("UPDATE devices SET push_token=NULL WHERE id=%s AND user_id=%s",
                  (install_id, u["id"]))
        c.commit()
    return {"ok": True}

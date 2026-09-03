"""
Pairing, invites, and unlinking -- the endpoints behind the consent rule.

The rule itself, and why there are two paths rather than one, is written
up in server/services/family.py where link_both lives.
"""

import secrets
import time
from contextlib import closing

from fastapi import APIRouter, Depends, HTTPException, Request

from server.config import PAIR_TTL_S
from server.db import db
from server.deps import me
from server.hub import HUB
from server.logging_setup import get_logger
from server.ratelimit import LIMIT, client_ip
from server.schemas import InviteIn, PairIn
from server.security import ALPHABET, tok_hash
from server.services.family import link_both, pub


log = get_logger(__name__)

router = APIRouter()


# ---- family: pairing and consent ---------------------------------------


@router.get("/family")
def family(u=Depends(me)):
    with closing(db()) as c:
        rows = c.execute("""
            SELECT us.id, us.name, us.username, l.relation, l.created_at
            FROM links l JOIN users us ON us.id = l.member_id
            WHERE l.owner_id = %s ORDER BY l.created_at
        """, (u["id"],)).fetchall()
    return [{**dict(r), "online": HUB.online(r["id"])} for r in rows]


@router.post("/pair")
def make_pairing_code(b: PairIn, u=Depends(me)):
    """Issue a one-time pairing code. Shown once, hashed at rest."""
    LIMIT.check("pair", u["id"], 20, 3600, "too many pairing codes - wait a while")
    now = time.time()
    half = lambda: "".join(secrets.choice(ALPHABET) for _ in range(4))
    tok = f"PAIR-{half()}-{half()}"
    with closing(db()) as c:
        # One transaction, because the pool runs in autocommit: without this the
        # DELETE stands on its own, and a failure before the INSERT lands leaves
        # the account with no live pairing code at all -- the old one revoked,
        # the new one never written, and a person reading a code off a screen
        # that was handed back before it existed.
        with c.transaction():
            # Only one live code at a time. If you generate a new one you have
            # decided the old one is loose; it should stop working that instant.
            c.execute("DELETE FROM pairings WHERE issuer_id=%s AND used_at IS NULL",
                      (u["id"],))
            c.execute("INSERT INTO pairings (token_hash,issuer_id,relation,created_at,expires_at)"
                      " VALUES (%s,%s,%s,%s,%s)",
                      (tok_hash(tok), u["id"], b.relation.strip(), now, now + PAIR_TTL_S))
    return {"code": tok, "expires_at": now + PAIR_TTL_S, "ttl_s": PAIR_TTL_S}


@router.post("/invite")
async def invite(b: InviteIn, req: Request, u=Depends(me)):
    """Redeem a pairing code, or ask someone to accept you."""
    # The per-account limit is the real one: it is the bucket an attacker
    # cannot escape without making more accounts. The per-IP limit is a
    # backstop against exactly that, and is set loose enough that a family or a
    # classroom behind one NAT never meets it -- 120 an hour against a million
    # possible codes is still four and a half years to a coin flip.
    LIMIT.check("invite_user", u["id"], 10, 600,
                "too many attempts - check the code and wait a few minutes")
    LIMIT.check("invite_ip", client_ip(req), 120, 3600,
                "too many attempts from this network - wait a while")

    code = b.code.strip().upper().replace(" ", "")
    relation = b.relation.strip()
    now = time.time()

    # ---- path 1: a pairing code -----------------------------------------
    if code.startswith("PAIR-"):
        with closing(db()) as c:
            row = c.execute("SELECT * FROM pairings WHERE token_hash=%s",
                            (tok_hash(code),)).fetchone()
            # One message for expired, used, and never-existed. There is no
            # reason to tell the holder of a bad code which kind of bad it is.
            if not row or row["used_at"] or row["expires_at"] < now:
                raise HTTPException(404, "that pairing code has expired or was already used")
            if row["issuer_id"] == u["id"]:
                raise HTTPException(400, "that is your own pairing code")

            other = c.execute("SELECT * FROM users WHERE id=%s",
                              (row["issuer_id"],)).fetchone()
            if not other:
                raise HTTPException(404, "that pairing code has expired or was already used")

            # All four writes or none. link_both is two INSERTs and the whole
            # point of it is that family is mutual -- half of it committed is
            # the one-way link its own docstring exists to rule out, with the
            # parent seeing the child and the child never seeing the parent.
            # Burning the code without linking anyone is the other bad half.
            with c.transaction():
                c.execute("UPDATE pairings SET used_at=%s, used_by=%s WHERE token_hash=%s",
                          (now, u["id"], row["token_hash"]))
                link_both(c, u["id"], other["id"], relation or row["relation"], now)
                # Any request left pending between these two is now moot.
                c.execute("UPDATE invites SET state='accepted', settled_at=%s "
                          "WHERE state='pending' AND ((from_id=%s AND to_id=%s) "
                          "OR (from_id=%s AND to_id=%s))",
                          (now, u["id"], other["id"], other["id"], u["id"]))

        await HUB.to(other["id"], {"t": "family_added", "user": pub(u)})
        log.info("paired: %s <-> %s", u["name"], other["name"])
        return {"ok": True, "linked": True, "member": pub(other, relation)}

    # ---- path 2: a user code, which needs their acceptance --------------
    if not code.startswith("NGB-"):
        code = "NGB-" + code
    if code == u["id"]:
        raise HTTPException(400, "that is your own code")

    with closing(db()) as c:
        other = c.execute("SELECT * FROM users WHERE id=%s", (code,)).fetchone()
        if other:
            already = c.execute("SELECT 1 FROM links WHERE owner_id=%s AND member_id=%s",
                                (u["id"], other["id"])).fetchone()
            if already:
                return {"ok": True, "linked": True, "member": pub(other)}

            prior = c.execute("SELECT * FROM invites WHERE from_id=%s AND to_id=%s",
                              (u["id"], other["id"])).fetchone()
            # A decline is permanent and it is silent. Re-inviting somebody who
            # said no gets the same cheerful answer as the first time and does
            # nothing at all -- so "she declined me" is not a fact this server
            # will hand to the person she declined.
            if not prior:
                cur = c.execute("INSERT INTO invites (from_id,to_id,relation,created_at)"
                                " VALUES (%s,%s,%s,%s) RETURNING id",
                                (u["id"], other["id"], relation, now))
                invite_id = cur.fetchone()["id"]
                c.commit()
                await HUB.to(other["id"], {
                    "t": "invite",
                    "invite": {"id": invite_id, "relation": relation,
                               "created_at": now, "from": pub(u)}})
                log.info("invite: %s -> %s (awaiting consent)", u["name"], other["name"])

    # Identical response whether or not that code belongs to anyone. Without
    # this the endpoint is a directory: guess codes until one comes back
    # differently and you have found a real person, with their real name, and
    # can start sending them requests.
    return {"ok": True, "linked": False, "pending": True}


@router.get("/invites")
def list_invites(u=Depends(me)):
    """Requests waiting on me, and requests I am waiting on."""
    with closing(db()) as c:
        inc = c.execute("""
            SELECT i.id, i.relation, i.created_at, us.id AS uid, us.name, us.username
            FROM invites i JOIN users us ON us.id = i.from_id
            WHERE i.to_id=%s AND i.state='pending' ORDER BY i.created_at
        """, (u["id"],)).fetchall()
        # 'declined' is listed alongside 'pending' and reported as pending.
        # If a declined request simply vanished from the sender's list, then
        # vanishing WOULD BE the notification -- and the whole point of a silent
        # decline is that refusing somebody carries no risk of them finding out.
        out = c.execute("""
            SELECT id, to_id, relation, created_at FROM invites
            WHERE from_id=%s AND state IN ('pending','declined') ORDER BY created_at
        """, (u["id"],)).fetchall()
    return {
        "incoming": [{"id": r["id"], "relation": r["relation"],
                      "created_at": r["created_at"],
                      "from": {"id": r["uid"], "name": r["name"],
                               "username": r["username"]}} for r in inc],
        # Outgoing carries the code that was typed and nothing else. Learning
        # someone's name by sending them a request they have not answered is
        # exactly the lookup this whole section exists to prevent.
        "outgoing": [{"id": r["id"], "to": r["to_id"], "relation": r["relation"],
                      "created_at": r["created_at"]} for r in out],
    }


@router.post("/invite/{invite_id}/accept")
async def accept_invite(invite_id: int, u=Depends(me)):
    LIMIT.check("invite_answer", u["id"], 30, 600,
                "too many invite answers - wait a few minutes")
    now = time.time()
    with closing(db()) as c:
        inv = c.execute("SELECT * FROM invites WHERE id=%s", (invite_id,)).fetchone()
        if not inv or inv["to_id"] != u["id"]:
            raise HTTPException(404, "no such request")
        if inv["state"] != "pending":
            raise HTTPException(409, "that request has already been answered")
        other = c.execute("SELECT * FROM users WHERE id=%s", (inv["from_id"],)).fetchone()
        if not other:
            raise HTTPException(404, "that account no longer exists")

        # Same rule as the pairing path: the invite is settled and the link is
        # made together, or neither happens. A settled invite with no link is
        # unrecoverable from the app -- accept says it has already been
        # answered, and there is nothing to re-accept.
        with c.transaction():
            c.execute("UPDATE invites SET state='accepted', settled_at=%s WHERE id=%s",
                      (now, invite_id))
            link_both(c, other["id"], u["id"], inv["relation"], now)

    await HUB.to(other["id"], {"t": "family_added", "user": pub(u)})
    log.info("accepted: %s <-> %s", u["name"], other["name"])
    return {"ok": True, "member": pub(other, inv["relation"])}


@router.post("/invite/{invite_id}/decline")
def decline_invite(invite_id: int, u=Depends(me)):
    """Refuse, permanently. The other side is told nothing, ever.

    Not a missing feature. If declining sent a notification, then declining
    would be a thing you might not dare do -- and a product for people who are
    afraid of somebody must never make refusing them the risky option. To the
    sender this looks exactly like an invite nobody has opened yet.
    """
    # Shares a bucket with accept on purpose: the pair of them is one decision,
    # and a script walking invite ids should not get twice the budget by
    # alternating between the two endpoints.
    LIMIT.check("invite_answer", u["id"], 30, 600,
                "too many invite answers - wait a few minutes")
    with closing(db()) as c:
        inv = c.execute("SELECT * FROM invites WHERE id=%s", (invite_id,)).fetchone()
        if not inv or inv["to_id"] != u["id"]:
            raise HTTPException(404, "no such request")
        c.execute("UPDATE invites SET state='declined', settled_at=%s WHERE id=%s",
                  (time.time(), invite_id))
        c.commit()
    return {"ok": True}


@router.post("/family")
def add_family_gone():
    """The old auto-link. Fails closed rather than quietly linking anyone."""
    raise HTTPException(
        410, "this app is out of date - pairing now needs the other person to "
             "agree. Please update.")


@router.delete("/family/{member_id}")
def remove_family(member_id: str, u=Depends(me)):
    LIMIT.check("family_remove", u["id"], 20, 600,
                "too many changes to your family list - wait a few minutes")
    with closing(db()) as c:
        # Together, or the second failure leaves the pair unable to reconnect:
        # links gone, invite row still there, and every future attempt to add
        # each other blocked by a UNIQUE(from_id,to_id) neither of them can see.
        with c.transaction():
            c.execute("DELETE FROM links WHERE (owner_id=%s AND member_id=%s) "
                      "OR (owner_id=%s AND member_id=%s)",
                      (u["id"], member_id, member_id, u["id"]))
            # Removing someone has to also clear the old invite, or they can never
            # be added again -- the UNIQUE(from_id,to_id) row would still be there.
            c.execute("DELETE FROM invites WHERE (from_id=%s AND to_id=%s) "
                      "OR (from_id=%s AND to_id=%s)",
                      (u["id"], member_id, member_id, u["id"]))
    return {"ok": True}

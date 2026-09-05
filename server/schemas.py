"""
The request bodies, and what is validated rather than trusted.

Several of these carry a `client_id`: the phone's id for one press or one
incident, sent again on every retry. That field is the difference between a
retried SOS and a second SOS -- see migration 004 and emit_alert.
"""

from typing import Optional

from pydantic import BaseModel

from server.config import CHECKIN_WINDOW_S


class RegisterIn(BaseModel):
    username: str
    password: str
    name: str


class LoginIn(BaseModel):
    username: str
    password: str


class InviteIn(BaseModel):
    code: str                  # a PAIR-… pairing code, or an NGB-… user code
    relation: str = ""


class PairIn(BaseModel):
    relation: str = ""


class DeviceIn(BaseModel):
    id: str
    push_token: Optional[str] = None
    platform: Optional[str] = None
    os_version: Optional[str] = None
    app_version: Optional[str] = None


class CheckinIn(BaseModel):
    window: int = CHECKIN_WINDOW_S


class SelfCheckinIn(BaseModel):
    """A detector on the phone asking its own wearer whether they are all right.

    The one check-in nobody requested. `reason` is what fired -- see
    INCIDENT_ESCALATION -- and it is the field that decides what the silence
    becomes, so it is validated rather than trusted.

    `lat`/`lon` are where the incident happened, captured at the impact and not
    at the deadline; `note` is what the detector measured, in words a family
    member can read.
    """
    reason: str = "fall"
    window: Optional[int] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    note: str = ""
    # The phone's id for one incident, reused across retries, exactly like
    # AlertIn.client_id. An impact happens in the second the network is worst --
    # under a flyover, in a ditch -- so this request WILL be retried, and two
    # check-ins for one crash means two escalations and two pages.
    client_id: Optional[str] = None


class HighAlertIn(BaseModel):
    on: bool = True
    # Present so a demo does not have to wait five real minutes for the first
    # buzz. Clamped, and never longer than the real window -- it can make the
    # feature easier to show, never quieter than it is meant to be.
    first_buzz_s: Optional[int] = None


class HeartbeatIn(BaseModel):
    mode: str = "idle"                 # idle | high_alert | sos
    band_link: bool = False
    # Two batteries, and they fail independently: a flat band means the safety
    # device is off the air, a flat phone means every path to the family is
    # about to close. band_batt is None in virtual mode, where the phone *is*
    # the band and there is no second cell to report.
    #
    # phone_batt held band battery until migration 002 -- an older build still
    # sends it that way, which is why neither is trusted to imply the other.
    phone_batt: Optional[int] = None
    band_batt: Optional[int] = None
    # Which kind of band is behind band_link. In virtual mode the phone *is*
    # the band, so there is no second cell and the family must not be shown
    # one -- see migration 003. False by default, because a build old enough
    # not to send this field only ever had a real band to talk about.
    virtual: bool = False
    lat: Optional[float] = None
    lon: Optional[float] = None


class PresenceIn(BaseModel):
    lat: float
    lon: float


class AlertIn(BaseModel):
    kind: str = "sos"
    source: str = "app"
    lat: Optional[float] = None
    lon: Optional[float] = None
    accuracy: Optional[float] = None
    note: str = ""
    # The phone's id for one press, sent on the first attempt and on every
    # retry of it. Optional so an older build still works -- it just gets the
    # old duplicate-on-retry behaviour, which is the thing to fix by updating.
    client_id: Optional[str] = None
    allow_samaritan: Optional[bool] = None


class FixIn(BaseModel):
    """One position, on the way somewhere."""
    lat: float
    lon: float
    accuracy: Optional[float] = None
    # The phone's clock, not the server's. A batch flushed after eight minutes
    # in a dead zone is eight minutes of history, and stamping all of it with
    # arrival time would draw a person standing still and then teleporting.
    # Sanity-checked rather than trusted -- see `_clean` in services/alerts.py.
    at: Optional[float] = None


class LocationIn(BaseModel):
    """A live position report, singular or batched.

    Both shapes on one model on purpose. `points` is what the tracker sends,
    because a buffer flushed after a dead zone is the case the endpoint exists
    for; the flat `lat`/`lon` is what a hand-written curl, an older build, or a
    debugging session sends, and refusing those would make the one endpoint in
    this product that has to work from a headless background task the hardest
    one to test.
    """
    points: Optional[list[FixIn]] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    accuracy: Optional[float] = None
    at: Optional[float] = None


class SamaritanOptIn(BaseModel):
    action: str  # 'allow' or 'deny'


class SettingsIn(BaseModel):
    samaritan_enabled: Optional[bool] = None


class BandPinIn(BaseModel):
    band_pin: str

"""
Geography for the Good Samaritan fan-out.

Pure: no database, no clock, no network -- the same discipline watch_lost.py
is held to, and for the same reason. Distance is what decides who gets told a
stranger nearby is in trouble, so it should be checkable in milliseconds.
"""

import math

from server.config import SAMARITAN_COARSE_M


GEO_B32 = "0123456789bcdefghjkmnpqrstuvwxyz"


def geohash(lat, lon, precision=6):
    """Standard geohash. Six characters is a cell of roughly 1.2 x 0.6 km."""
    lat_r, lon_r = [-90.0, 90.0], [-180.0, 180.0]
    out, bit, ch, even = [], 0, 0, True
    while len(out) < precision:
        if even:
            mid = (lon_r[0] + lon_r[1]) / 2
            if lon > mid: ch = (ch << 1) | 1; lon_r[0] = mid
            else:         ch = ch << 1;       lon_r[1] = mid
        else:
            mid = (lat_r[0] + lat_r[1]) / 2
            if lat > mid: ch = (ch << 1) | 1; lat_r[0] = mid
            else:         ch = ch << 1;       lat_r[1] = mid
        even = not even
        bit += 1
        if bit == 5:
            out.append(GEO_B32[ch])
            bit, ch = 0, 0
    return "".join(out)


def metres_between(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def coarsen(lat, lon):
    """Snap to a ~330 m grid. What a stranger sees before they say yes."""
    step = SAMARITAN_COARSE_M / 111000.0
    return round(lat / step) * step, round(lon / step) * step

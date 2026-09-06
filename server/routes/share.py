"""
The page you can send to somebody, that moves by itself.

Every "see where they are" in this product was `maps.google.com/?q=lat,lon`
until now, and that is a photograph. The family member opens it, sees a pin,
and twenty minutes later the pin is still there while she is a kilometre away.
There is no fixing that from our side: nothing lets you push a new position
into somebody else's maps app. Google's own live sharing works because Google
owns both ends.

So the page has to be ours. It is served here, it holds the token in its own
URL, and it asks this server where she is every few seconds. The marker moves
without anybody touching anything, which is the entire difference.

WHO IT IS FOR. Not primarily the family -- they have the app, and the app
embeds this same page. It is for whoever the family is on the phone to while
they drive: the police, a rickshaw driver, the cousin who never installed
anything. A link that can be forwarded and simply opened is the difference
between help that arrives and help that is still being onboarded.

WHAT KEEPS IT HONEST. The token is 32 characters of HMAC, unguessable and
un-enumerable; the database stores only its hash; and it dies with the alert's
tracking window, so a link forwarded into a WhatsApp group does not become a
permanent window into somebody's movements. See migration 012.
"""

import time

from fastapi import APIRouter, Response
from fastapi.responses import HTMLResponse, JSONResponse

from server.config import LIVE_FIX_STALE_S
from server.services.alerts import resolve_share, share_trail


router = APIRouter()

# Never indexed. The token makes the page unguessable, but a crawler that
# somehow met one must not put a person's live position into a search result.
NOINDEX = {"X-Robots-Tag": "noindex, nofollow, noarchive",
           "Cache-Control": "no-store"}

# How often the page asks. Half the fastest reporting interval, so a new fix is
# on screen within a few seconds of arriving without the page hammering a
# server that is in the middle of an emergency.
POLL_MS = 5000

WHAT = {
    "sos": "needs help",
    "snatch": "had their band torn off",
    "accident": "was in a road accident",
    "fall": "may have fallen",
}


@router.get("/t/{token}/feed")
def share_feed(token: str, since: float = 0.0):
    """Where she is now, for the page above. No login, just the token."""
    row = resolve_share(token)
    if not row:
        # One answer for expired, revoked and never-existed alike. Anything
        # more specific turns a dead link into an oracle for whether a given
        # emergency ever happened.
        return JSONResponse({"ok": False, "state": "ended"},
                            status_code=410, headers=NOINDEX)

    now = time.time()
    lat = row["live_lat"] if row["live_lat"] is not None else row["lat"]
    lon = row["live_lon"] if row["live_lon"] is not None else row["lon"]
    age = (now - row["live_at"]) if row["live_at"] else None

    return JSONResponse({
        "ok": True,
        # `moving` and `stale` are the distinction the whole page exists to
        # draw. A fix from eight seconds ago is where she IS; one from six
        # minutes ago is where she WAS, and showing the second in the words of
        # the first is how somebody ends up standing in an empty street.
        "state": ("stale" if (age is None or age > LIVE_FIX_STALE_S) else "moving"),
        "name": row["name"],
        "what": WHAT.get(row["kind"], "needs help"),
        "lat": lat, "lon": lon,
        "accuracy": row["live_accuracy"],
        "at": row["live_at"],
        "age_s": round(age) if age is not None else None,
        "raised_at": row["raised_at"],
        "resolved": row["resolved_at"] is not None,
        "expires_at": row["expires_at"],
        "poll_ms": POLL_MS,
        "trail": [p for p in share_trail(row["alert_id"]) if p["at"] > since],
    }, headers=NOINDEX)


@router.get("/t/{token}")
def share_page(token: str, embed: str = ""):
    """The map. One self-contained page, no build step, no API key.

    OpenStreetMap tiles through Leaflet rather than Google: no key to
    provision, no billing account to attach, and nothing to break in a
    deployment that is already carrying enough. The app embeds this exact page
    for its own live map, so the two can never drift apart.

    `?embed=1` is the app asking for the map and nothing else. Around this page
    it draws its own name, its own Directions -- which hands the coordinates to
    whichever navigation app the phone's owner actually uses -- and its own
    Share, which opens the system sheet. Served plain, the page's own heading
    and buttons land directly underneath that: two names, two Directions, two
    Shares, stacked, in front of somebody who has just been woken by a siren.
    So the embedded page gives up everything the app already provides and keeps
    the one thing only it knows, because only it is polling: how old the fix on
    screen is.

    It stays a difference of CSS rather than a second template. There is one
    page, and the version the police open is the version the family is looking
    at.

    The parameter is read as a string rather than declared an int on purpose.
    Anything unparseable would otherwise be a 422 -- a validation error where a
    map should be -- and a cosmetic flag is never worth failing this page for.
    """
    if not resolve_share(token):
        return HTMLResponse(_DEAD, status_code=410, headers=NOINDEX)
    embedded = embed.strip().lower() not in ("", "0", "false", "no")
    page = (_PAGE.replace("__TOKEN__", token)
                 .replace("__EMBED__", _EMBED_CSS if embedded else ""))
    return HTMLResponse(page, headers=NOINDEX)


@router.head("/t/{token}")
def share_head(token: str):
    """So a messaging app previewing the link does not count as a visit."""
    return Response(status_code=200 if resolve_share(token) else 410,
                    headers=NOINDEX)


_DEAD = """<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nigehban</title>
<style>
 body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
      background:#0B0D0F;color:#E7ECEF;font:16px/1.6 system-ui,sans-serif;text-align:center}
 .c{max-width:22rem;padding:2rem}
 h1{font-size:1.25rem;margin:0 0 .5rem}
 p{color:#8A9299;margin:0}
</style>
<div class="c">
  <h1>This location link has ended</h1>
  <p>Live sharing stops when the emergency is over. If you still need to reach
     them, call them directly.</p>
</div>
"""


# What `?embed=1` adds. Nothing is deleted from the page and no branch is
# added to its script: the same markup renders, and the pieces the app already
# draws are simply not shown. That is why `draw()` below can go on writing to
# `#who` without knowing which mode it is in.
#
# What survives is the status line, because it is the only thing on this screen
# that the app cannot know. The app learns positions from a websocket push; the
# page is polling this server every few seconds. When the socket drops -- a
# lift, a tunnel, a carrier hiccup -- the map keeps moving and the app does not
# hear about it, so a freshness claim drawn natively would be the wrong one at
# exactly the moment it mattered. Whoever is polling gets to say how old the
# fix is, and that is the page.
_EMBED_CSS = """<style>
 /* The app's own header carries the name and the app's own bar carries the
    actions. Both would otherwise appear twice, one under the other. */
 #who{display:none}
 #acts{display:none}
 /* No scrim either: the app's header is already a solid dark surface, and a
    second gradient under it reads as a smudge. */
 #bar{background:none;padding:.5rem;text-align:center}
 /* The status line becomes a floating pill rather than a full-width card --
    it is one short phrase, and the map underneath is what people came for.
    Hidden until the first answer arrives: standalone, the card says "Loading…"
    in a heading this mode does not draw, so without this an empty pill sits
    over the map for as long as the first poll takes. */
 #card{display:inline-block;max-width:none;padding:.4rem .7rem;border-radius:999px;
   background:#151A1EE6;box-shadow:0 2px 10px #0006;visibility:hidden}
 #card.ready{visibility:visible}
 #sub{margin:0;justify-content:center;font-size:.8rem}
 /* Follow-again sat above buttons that are no longer there. */
 #recenter{bottom:1rem}
</style>"""


# The page. Deliberately one file with no build step: it has to be openable by
# somebody standing in the road on a bad connection, and every extra request is
# another thing that can fail at exactly the wrong moment.
_PAGE = """<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Live location — Nigehban</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
 :root{--bg:#0B0D0F;--card:#151A1E;--text:#E7ECEF;--dim:#8A9299;
       --mint:#3CC183;--amber:#F59E0B;--red:#EF4444}
 *{box-sizing:border-box}
 html,body{margin:0;height:100%;background:var(--bg);color:var(--text);
   font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
 #map{position:absolute;inset:0}
 .leaflet-container{background:#0B0D0F}
 #bar{position:absolute;left:0;right:0;top:0;z-index:500;padding:.75rem;
   background:linear-gradient(#0B0D0FEE,#0B0D0F00)}
 #card{background:var(--card);border-radius:14px;padding:.85rem 1rem;
   box-shadow:0 6px 24px #0008;max-width:32rem;margin:0 auto}
 #who{font-weight:600}
 #sub{color:var(--dim);font-size:.85rem;margin-top:.15rem;display:flex;
   align-items:center;gap:.4rem}
 .dot{width:.5rem;height:.5rem;border-radius:50%;background:var(--mint);flex:none}
 .dot.stale{background:var(--amber)}
 .dot.over{background:var(--dim)}
 @keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
 .dot.live{animation:pulse 1.6s infinite}
 #acts{position:absolute;left:0;right:0;bottom:0;z-index:500;padding:.75rem;
   display:flex;gap:.5rem;justify-content:center;
   background:linear-gradient(#0B0D0F00,#0B0D0FEE)}
 a.btn,button.btn{flex:1;max-width:15rem;text-align:center;text-decoration:none;
   border:0;border-radius:12px;padding:.8rem 1rem;font-weight:600;font-size:.95rem;
   background:var(--mint);color:#06231A;cursor:pointer}
 button.btn.ghost{background:#222A30;color:var(--text)}
 #recenter{position:absolute;right:.75rem;bottom:5rem;z-index:500;display:none;
   background:var(--card);color:var(--text);border:0;border-radius:10px;
   padding:.6rem .8rem;font-size:.85rem;box-shadow:0 4px 14px #0008;cursor:pointer}
</style>
__EMBED__
<div id="map"></div>
<div id="bar"><div id="card">
  <div id="who">Loading…</div>
  <div id="sub"><span class="dot" id="dot"></span><span id="state"></span></div>
</div></div>
<button id="recenter">Follow again</button>
<div id="acts">
  <a class="btn" id="dir" target="_blank" rel="noopener">Directions</a>
  <button class="btn ghost" id="share">Share</button>
</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
(function () {
  var TOKEN = "__TOKEN__";
  var map = L.map('map', { zoomControl: false, attributionControl: true })
             .setView([30.3753, 69.3451], 5);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap'
  }).addTo(map);

  var marker = null, ring = null, line = null, follow = true, lastAt = 0, seen = [];

  // The viewer panning the map means they are looking at something -- a
  // junction, a turning, the road they are on -- and yanking the view back
  // under them every five seconds makes the page unusable at exactly the
  // moment it matters. So following stops on any manual drag and is offered
  // back as a button.
  map.on('dragstart', function () { follow = false; rc.style.display = 'block'; });
  var rc = document.getElementById('recenter');
  rc.onclick = function () {
    follow = true; rc.style.display = 'none';
    if (marker) map.setView(marker.getLatLng(), Math.max(map.getZoom(), 16));
  };

  function ago(s) {
    if (s == null) return 'no position yet';
    if (s < 10) return 'just now';
    if (s < 60) return s + 's ago';
    var m = Math.round(s / 60);
    return m + (m === 1 ? ' min ago' : ' min ago');
  }

  function draw(d) {
    // Embedded, the pill stays hidden until there is something in it to read.
    // Harmless anywhere else: no rule attaches to the class outside that mode.
    document.getElementById('card').classList.add('ready');
    document.getElementById('who').textContent =
      d.name + ' ' + d.what;

    var dot = document.getElementById('dot');
    var st = document.getElementById('state');
    dot.className = 'dot';
    if (d.resolved) {
      dot.classList.add('over');
      st.textContent = 'Stood down — still sharing, ' + ago(d.age_s);
    } else if (d.state === 'moving') {
      dot.classList.add('live');
      st.textContent = 'Live — updated ' + ago(d.age_s);
    } else {
      dot.classList.add('stale');
      st.textContent = 'Last known position, ' + ago(d.age_s);
    }

    if (d.trail && d.trail.length) {
      for (var i = 0; i < d.trail.length; i++) {
        seen.push([d.trail[i].lat, d.trail[i].lon]);
        if (d.trail[i].at > lastAt) lastAt = d.trail[i].at;
      }
      if (!line) line = L.polyline(seen, { color: '#3CC183', weight: 3, opacity: .7 }).addTo(map);
      else line.setLatLngs(seen);
    }

    if (d.lat == null || d.lon == null) return;
    var p = [d.lat, d.lon];
    if (!marker) {
      ring = L.circle(p, { radius: d.accuracy || 25, color: '#3CC183',
                           weight: 1, fillOpacity: .12 }).addTo(map);
      marker = L.circleMarker(p, { radius: 9, color: '#0B0D0F', weight: 3,
                                   fillColor: '#3CC183', fillOpacity: 1 }).addTo(map);
      map.setView(p, 16);
    } else {
      marker.setLatLng(p);
      ring.setLatLng(p).setRadius(d.accuracy || 25);
      if (follow) map.panTo(p, { animate: true });
    }
    marker.setStyle({ fillColor: d.resolved ? '#8A9299'
                                : d.state === 'moving' ? '#3CC183' : '#F59E0B' });

    // Always the CURRENT position. Pressing it again after she has moved opens
    // directions to where she is now, not to where this page first loaded.
    document.getElementById('dir').href =
      'https://www.google.com/maps/dir/?api=1&destination=' + d.lat + ',' + d.lon;
  }

  function dead() {
    document.getElementById('card').classList.add('ready');
    var who = document.getElementById('who');
    // Embedded, the heading is normally hidden because the app draws the name
    // above it. This one sentence is the exception: the app has no way of
    // knowing the link died mid-view, and "ended" is not a detail to leave to
    // a status line somebody may not read.
    who.style.display = 'block';
    who.textContent = 'This location link has ended';
    var dot = document.getElementById('dot'); dot.className = 'dot over';
    document.getElementById('state').textContent =
      'Live sharing stops when the emergency is over.';
    document.getElementById('acts').style.display = 'none';
  }

  var timer = null;
  function tick() {
    fetch('/t/' + TOKEN + '/feed?since=' + lastAt, { cache: 'no-store' })
      .then(function (r) {
        if (r.status === 410) { clearInterval(timer); dead(); return null; }
        return r.ok ? r.json() : null;
      })
      .then(function (d) { if (d && d.ok) draw(d); })
      .catch(function () { /* a tunnel, a lift, a dead spot: the next tick retries */ });
  }
  tick();
  timer = setInterval(tick, %POLL%);

  document.getElementById('share').onclick = function () {
    var url = location.href;
    if (navigator.share) { navigator.share({ title: 'Live location', url: url }); }
    else if (navigator.clipboard) {
      navigator.clipboard.writeText(url);
      this.textContent = 'Link copied';
      var b = this; setTimeout(function () { b.textContent = 'Share'; }, 1800);
    }
  };
})();
</script>
""".replace("%POLL%", str(POLL_MS))

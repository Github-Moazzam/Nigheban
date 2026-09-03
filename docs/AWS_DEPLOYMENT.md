# Deploying the Nigehban server on AWS

The laptop-and-ngrok setup in `scripts/dev-tunnel.ps1` is a demo rig. It works
because somebody is in the room with the laptop open. This document replaces it
with a machine that stays up: a public HTTPS address, a real certificate, a
service that comes back after a reboot, and a sweeper that keeps counting down
at 3 a.m. when nobody is watching.

Read section 1 before typing anything. The shape of this deployment is decided
by three properties of the code, and every AWS choice below follows from them.
If you skip to section 4 and put this behind an autoscaling group, you will
page four family members twice for every alert.

---

## 1. What this server is, and what that rules out

### 1.1 The sweeper must be a singleton

`server/sweeper.py` is a five-second `asyncio` loop started once in the
`lifespan` hook in [server/app.py](../server/app.py). It is the half of the
product that does not wait to be asked: a check-in runs out, High Alert comes
round again, a heartbeat stops, and the family gets paged with no phone
attached to anything.

Each branch is latched (`escalated`, `lost_notified`) so a condition that stays
true pages once rather than every tick — but that latch is a column, and two
processes reading it in the same tick can both find it unset. **Two instances of
this server means duplicated emergency notifications**, which in a safety
product is not a cosmetic bug: a family that gets paged twice for one fall
learns to distrust the pages.

So: **one process, one instance.** No `--workers 4`, no ECS desired-count of 2,
no autoscaling group. Scaling this server horizontally is a code change (move
the sweeper to its own single-task service, or take an advisory lock in
Postgres), not a console setting.

### 1.2 The websocket registry is in memory

`HUB` in [server/hub.py](../server/hub.py) is a module-level dict of
`user_id -> set[WebSocket]`. A socket is only reachable from the process that
accepted it. The same applies to `LIMIT` in
[server/ratelimit.py](../server/ratelimit.py), which is an in-memory sliding
window that resets on restart.

Two consequences:

- Anything fronting this server has to speak WebSocket, not just HTTP. That
  rules out **App Runner** (no WebSocket support) and **API Gateway HTTP API +
  Lambda** (no long-lived connections, and no place to run the sweeper). An
  ALB works; a plain reverse proxy on the box works and costs nothing.
- A second process is a second registry the first cannot deliver to. Same
  conclusion as 1.1.

### 1.3 The database already lives somewhere, and it lives in Tokyo

`DATABASE_URL` in your `.env` points at
`aws-0-ap-northeast-1.pooler.supabase.com` — Supabase's **ap-northeast-1
(Tokyo)** pooler. The pool comments in [server/db.py](../server/db.py) are
written against a ~150 ms round trip, which is what you get reaching Tokyo from
a laptop in Pakistan.

Put the EC2 instance in `ap-northeast-1` and that round trip becomes ~1 ms,
same-region. A single SOS touches the database five or six times on its way
out, so this is the difference between an SOS fan-out taking a second and
taking a few milliseconds. **This one choice buys more than any instance-size
upgrade will.**

The other half of that file matters too: Supabase's session-mode pooler hands
out **fifteen client connections to the whole project**, and `DB_POOL_MAX`
defaults to 8. That is sized for exactly one server process plus room for a
`scripts/db.py` session and a test run. If you ever run a second process
against the same Supabase project, lower `DB_POOL_MAX` on both, or you will
meet `FATAL: (EMAXCONNSESSION) max clients reached in session mode` — at which
point *every* endpoint 500s, `/me` included, so the app cannot even sign in to
retry.

### 1.4 The resulting architecture

```
   phones (React Native, mobile data)
        │  HTTPS + WSS
        ▼
   ┌─────────────────────────────────────────┐
   │  EC2  t4g.small   ap-northeast-1        │
   │  Elastic IP  ──  api.example.com        │
   │                                         │
   │   Caddy :443  ── TLS, auto-renewed      │
   │     └─ reverse_proxy 127.0.0.1:8000     │
   │          └─ uvicorn (1 process)         │
   │               ├─ FastAPI routes + /ws   │
   │               └─ sweeper (5 s tick)     │
   └─────────────────────────────────────────┘
        │  HTTPS out
        ├──► Supabase Postgres (same region)
        └──► exp.host  (Expo push)
```

Deliberately absent: no ALB (there is one instance, so a load balancer is
$16/month for a hostname), no RDS (Supabase already holds the schema and its
migrations), no Docker (one Python process with a `requirements.txt` does not
need an image registry in the loop), no autoscaling (see 1.1).

Section 12 says what to do when any of those stop being true.

### 1.5 A note on region — Tokyo was a mistake

The rest of this document was written against the `DATABASE_URL` already in
your `.env`, which points at Supabase's `ap-northeast-1` (Tokyo) pooler. That
was picked without checking against Pakistan, and it is the worst of the
realistic options — Tokyo is roughly as far from Karachi as you can get while
staying in Asia.

Two things worth knowing before choosing a replacement:

**This project isn't actually using Supabase — it's using Supabase's
Postgres.** Nothing in `server/` reads `SUPABASE_URL`, `SUPABASE_ANON_KEY` or
`SUPABASE_SERVICE_ROLE_KEY`; the app doesn't use `supabase-js`; and
`server/supabase_migration.sql` has no row-level-security policy and no
`auth.`/`storage.`/`realtime` reference. Every query goes through plain
`psycopg` against `DATABASE_URL`. That matters because it means you are not
actually constrained to Supabase's region list — a self-hosted Postgres (RDS,
or Postgres on the EC2 box itself) is a drop-in replacement for this codebase,
not a rewrite.

**Measured against AWS's own regions, from a location on the same network path
as this repo, connect time roughly triples between the best option and
Tokyo:**

| Region | AWS code | ~Connect time | Available on Supabase? |
|---|---|---|---|
| Middle East (UAE) | `me-central-1` | **~35–40 ms** | No |
| South Asia (Mumbai) | `ap-south-1` | **~100–105 ms** | Yes |
| Middle East (Bahrain) | `me-south-1` | connection failed to resolve in this test — not a usable data point either way | No |
| Europe (Frankfurt) | `eu-central-1` | ~130–145 ms | Yes |
| Asia Pacific (Tokyo) — current | `ap-northeast-1` | ~150–160 ms | Yes |

Take the absolute numbers as directional, not a guarantee — they're a TCP
connect against an AWS endpoint from a dev network, not a measurement from a
Pakistani mobile carrier to Supabase's actual pooler. But the *ordering* is
real backbone geography (UAE has direct low-hop routes from South Asian and
Gulf-adjacent networks; Tokyo does not), and it will hold in the same relative
shape from Karachi or Lahore on Jazz, Zong, or a fixed ISP.

That leaves two honest options — deliberately not decided here, since it
trades off effort against latency and this is your call:

1. **Move the Supabase project to Mumbai (`ap-south-1`).** The smaller
   change: Supabase supports this region, so it's a new Supabase project plus
   a `pg_dump`/`pg_restore` and a `DATABASE_URL` swap — nothing else in this
   document changes. Cuts round-trip roughly from ~150 ms to ~100 ms. You keep
   Supabase's managed backups and dashboard.
2. **Self-host Postgres on RDS in `me-central-1` (UAE).** The bigger win:
   cuts round-trip to ~35–40 ms, about 4× better than Tokyo and noticeably
   better than Mumbai too — and since a single SOS makes five or six database
   round trips on its way out (section 1.3), this is the difference between
   an alert's server-side leg taking the better part of a second and taking a
   few milliseconds. The cost is leaving Supabase: standing up an RDS
   instance, migrating the data over, and taking on RDS's own backup/Multi-AZ
   configuration yourself instead of Supabase's. Given the codebase already
   has zero Supabase-specific dependencies, this is mechanically a clean
   migration — the risk is entirely in the cutover (getting every row across
   with no gap in writes), not in code changes afterward.

Either way, put the EC2 instance in the **same region as whichever database
you land on** — that adjacency is what buys the real speedup, more than the
choice of region in isolation. Nothing else in this document depends on which
you pick; every `ap-northeast-1` mentioned below is a literal find-and-replace
once you decide.

---

## 2. What you need before you start

| Thing | Why | Cost |
|---|---|---|
| An AWS account with billing set up | | |
| A domain name you control | The app sends `https`/`wss` to any host with a name — see `normalizeBase()` in [nigehban-app/src/api.js](../nigehban-app/src/api.js). A bare IP gets `http://…:8000` and no certificate, so a domain is not optional here. | ~$12/yr |
| Your existing `.env` values | `DATABASE_URL` and the Supabase keys carry over unchanged. | |
| An SSH key pair | | |

Total running cost: roughly **$15–18/month** — see section 11.

A note on the domain: buy it wherever you like, but if you use **Route 53** the
DNS step is two clicks instead of a wait for propagation. Any registrar works;
you just need to be able to set an `A` record.

---

## 3. Step 1 — Launch the instance

### 3.1 Pick the region first

In the AWS console, top-right region selector: **Asia Pacific (Tokyo)
ap-northeast-1**. Do this before creating anything. Security groups, key pairs
and Elastic IPs are all regional, and creating them in the wrong region means
doing this section twice.

### 3.2 Launch

EC2 → **Instances** → **Launch instances**.

| Field | Value | Why |
|---|---|---|
| Name | `nigehban-api` | |
| AMI | **Ubuntu Server 24.04 LTS (arm64)** | 24.04 ships Python 3.12, which runs this code as-is. arm64 (Graviton) is ~20% cheaper than x86 for identical performance here. |
| Instance type | **t4g.small** (2 vCPU, 2 GB) | `t4g.micro` (1 GB) will run it, but `psycopg[binary]` plus uvicorn plus Caddy in 1 GB leaves no room for a `pip install` during a deploy. 2 GB is the size at which you stop thinking about it. |
| Key pair | Create one, download the `.pem` | This is the only copy. Lose it and you re-create the instance. |
| Storage | 20 GB gp3 | The default 8 GB fills up with logs and apt. gp3 is cheaper and faster than gp2. |

### 3.3 Security group

Create a new security group named `nigehban-api-sg` with **three** inbound
rules and nothing else:

| Type | Port | Source | Why |
|---|---|---|---|
| SSH | 22 | **My IP** | Not `0.0.0.0/0`. An SSH port open to the internet collects thousands of login attempts a day. If your home IP changes, edit this rule — that is a ten-second job and worth it. |
| HTTP | 80 | `0.0.0.0/0`, `::/0` | Caddy needs it for the ACME HTTP-01 challenge and to redirect to HTTPS. |
| HTTPS | 443 | `0.0.0.0/0`, `::/0` | The phones. WSS rides on this same port. |

**Port 8000 is not in this list, and must not be.** uvicorn will bind to
`127.0.0.1` only, so the only way in is through Caddy, which means every
request that reaches the application has been through TLS. Opening 8000 would
create a plaintext bypass around your own certificate.

Egress: leave the default (all traffic out). The server needs outbound 443 to
reach Supabase and `exp.host` for push.

Launch it.

---

## 4. Step 2 — Give it a permanent address

A stopped-and-started EC2 instance gets a **new** public IP. The address is
compiled into every phone's saved settings, so it cannot be allowed to change.

EC2 → **Elastic IPs** → **Allocate Elastic IP address** → Allocate → select it
→ **Actions → Associate** → choose `nigehban-api`.

Write the IP down. An Elastic IP is free while it is attached to a running
instance and charged ~$3.60/month while it is not — so if you ever stop the
instance for a while, release the IP.

### DNS

At your registrar (or Route 53 → Hosted zone → Create record):

```
Type: A     Name: api     Value: <your Elastic IP>     TTL: 300
```

giving you `api.example.com`. Verify before continuing — Caddy cannot get a
certificate until this resolves:

```bash
dig +short api.example.com     # must print your Elastic IP
```

DNS can take a few minutes. Wait for it. Every "Caddy won't issue a
certificate" problem is this step not having finished.

---

## 5. Step 3 — Prepare the machine

SSH in (from the directory holding your `.pem`):

```bash
chmod 400 nigehban-key.pem
ssh -i nigehban-key.pem ubuntu@api.example.com
```

On Windows, use PowerShell's `ssh` (built in) — the `chmod` is unnecessary
there, but the file's ACL must not be world-readable; `icacls nigehban-key.pem
/inheritance:r /grant:r "$env:USERNAME:R"` does it.

### 5.1 Packages

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y python3-venv python3-pip git
```

Ubuntu 24.04's Python 3.12 is what runs the code. Do not install a second
Python from a PPA; there is no need, and mixing them is how a venv ends up
pointing at an interpreter that gets removed by an upgrade.

### 5.2 A user that is not `ubuntu`

```bash
sudo useradd --system --create-home --home-dir /opt/nigehban --shell /usr/sbin/nologin nigehban
sudo chmod 755 /opt/nigehban
```

A system account with no login shell and no sudo. The service runs as this
user, so a remote-code-execution bug in a dependency gets you a process that
can read `/opt/nigehban` and nothing else — not your SSH keys, not `sudo`.

The `chmod` is the second line for a reason worth knowing: `useradd` creates
the home directory `0750`, which means `ubuntu` cannot even `cd` into it — and
every command in sections 6, 7 and 12 that starts with `cd /opt/nigehban/app`
would fail with `Permission denied` before it did anything. `0755` makes the
directory traversable without giving anything away that matters: `.env` is
`0600` and `.ssh/` is `0700`, both owned by `nigehban`, so the database
password and the deploy key stay unreadable to every other account on the box.

A note on the commands that follow. `sudo -u nigehban <cmd> >> file` does
**not** write that file as `nigehban` — the shell performs the redirect as
*you*, before `sudo` runs, so it lands as `ubuntu` and fails on anything only
`nigehban` can write. Where a redirect into `/opt/nigehban` is needed, it has
to be inside the elevated shell:

```bash
sudo -u nigehban bash -c 'some-command >> /opt/nigehban/.ssh/known_hosts'
```

Same trap applies to `cd`: prefer `git -C /opt/nigehban/app <cmd>` over
`cd`-then-`git`, since the `cd` runs as you and the `git` does not.

### 5.3 The code

```bash
sudo -u nigehban git clone https://github.com/<you>/Nigehban.git /opt/nigehban/app
cd /opt/nigehban/app
sudo -u nigehban git checkout main
```

`main`, not a feature branch — that is the branch the CI/CD pipeline in
section 16 pushes to, and it is what `scripts/deploy.sh` resets this checkout
to on every deploy. If you're setting this up before that branch is where you
want production to track from, park it on whatever is right for now and
revisit before wiring up section 16.

If the repository is private, the cleanest option is a **deploy key**: generate
one on the box with `sudo -u nigehban ssh-keygen -t ed25519 -f
/opt/nigehban/.ssh/id_ed25519 -N ""`, then add the public half to the repo's
Settings → Deploy keys with read-only access. A read-only deploy key on one
host is a much smaller blast radius than a personal access token.

### 5.4 The virtualenv

```bash
sudo -u nigehban python3 -m venv /opt/nigehban/venv
sudo -u nigehban /opt/nigehban/venv/bin/pip install --upgrade pip
sudo -u nigehban /opt/nigehban/venv/bin/pip install -r /opt/nigehban/app/requirements.txt
```

`requirements.txt` covers the band bridge (`bleak`) as well as the server.
`bleak` installs fine and is simply never imported here — there is no Bluetooth
adapter on an EC2 instance, and nothing server-side asks for one. Leaving it
in keeps one requirements file as the single source of truth; if you would
rather not, `pip install fastapi 'uvicorn[standard]' 'psycopg[binary]'
psycopg_pool python-dotenv websockets` is the server's actual dependency set.

---

## 6. Step 4 — Configuration and secrets

`server/__init__.py` calls a bare `load_dotenv()`, which searches upward from
the **current working directory**. So the `.env` goes at the repo root and the
service's `WorkingDirectory` must be that root. Get this wrong and the server
starts, finds no `DATABASE_URL`, and every request 500s with
`DATABASE_URL not set in .env`.

```bash
sudo -u nigehban cp /opt/nigehban/app/.env.example /opt/nigehban/app/.env
sudo -u nigehban nano /opt/nigehban/app/.env
```

Fill in:

```ini
# From your local .env -- unchanged. Note the pooler host and :5432 (session
# mode), which is what DB_POOL_MAX=8 is sized against.
DATABASE_URL=postgresql://postgres.xxxx:PASSWORD@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres

SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...      # secret: server only, never the app

# Empty is correct. The app is React Native and does not use CORS at all, and
# this server hands out no HTML. Fill it in only when a real browser needs in.
ALLOWED_ORIGINS=

# INFO in production. DEBUG is useful for an afternoon and then it is noise.
LOG_LEVEL=INFO

# Not used on the server -- it belongs to scripts/dev-tunnel.*, which you are
# now replacing. Leave it blank.
NIGEHBAN_NGROK_DOMAIN=
```

Then lock the file down:

```bash
sudo chmod 600 /opt/nigehban/app/.env
sudo chown nigehban:nigehban /opt/nigehban/app/.env
```

`0600` and owned by the service user. The service-role key in that file
bypasses every row-level-security policy in the project; it should be readable
by exactly one account on this machine.

`.env` is already in `.gitignore` (along with `.env.*`, with `.env.example`
re-included), so there is no path by which this file gets committed.

### 6.1 Verify the database is reachable before going further

```bash
cd /opt/nigehban/app
sudo -u nigehban /opt/nigehban/venv/bin/python -c "
from dotenv import load_dotenv; load_dotenv()
import os, psycopg
with psycopg.connect(os.environ['DATABASE_URL']) as c:
    print(c.execute('select count(*) from users').fetchone())
"
```

A count means the URL, the password, the network path and the schema are all
good. Do this now: the same failure discovered later, through a systemd unit
that restarts every ten seconds, is much harder to read.

If it hangs, Supabase projects pause after inactivity on the free tier — open
the Supabase dashboard and resume it.

---

## 7. Step 5 — Migrations

```bash
cd /opt/nigehban/app
sudo -u nigehban /opt/nigehban/venv/bin/python server/migrate_pg.py
```

This applies every file in [server/migrations/](../server/migrations/) in name
order (`001_epoch_times.sql` … `010_username_unique.sql`). Each file is written
so a second run is a no-op, so running it when nothing has changed is safe and
cheap — which is what makes it safe to run on every deploy.

It finishes by asserting that no `timestamp` columns are left and printing
`all clocks are epoch seconds`. If it warns instead, a migration did not take;
fix that before starting the service. Mixed clock representations in this
schema mean deadlines that compare wrongly, which means check-ins that never
escalate.

Note there is no schema-version table — the idempotency is per-file and by
construction. So a migration that is *not* written idempotently will break a
re-run; keep that property when you add `011_`.

---

## 8. Step 6 — Run it as a service

### 8.1 The unit file

```bash
sudo nano /etc/systemd/system/nigehban.service
```

```ini
[Unit]
Description=Nigehban API server
# Only "after": the pool opens lazily on first use and the sweeper's first
# tick is 5 s away, so a momentary DNS hiccup at boot is not fatal.
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nigehban
Group=nigehban

# Load-bearing: load_dotenv() searches upward from the cwd, so this is what
# makes .env findable. See section 6.
WorkingDirectory=/opt/nigehban/app

# One process. Not a performance setting -- see section 1.1. A second worker
# is a second sweeper (duplicate pages) and a second HUB (undeliverable
# sockets). --proxy-headers makes request.client.host the real caller rather
# than Caddy, which is what the unhandled-exception log line in app.py
# records; the rate limiter reads X-Forwarded-For itself either way.
ExecStart=/opt/nigehban/venv/bin/uvicorn server.app:app \
    --host 127.0.0.1 \
    --port 8000 \
    --proxy-headers \
    --forwarded-allow-ips 127.0.0.1 \
    --log-level warning

Restart=always
RestartSec=5

# systemd's default SIGTERM is what uvicorn wants -- it shuts down
# gracefully, which runs the lifespan teardown in app.py: that waits up to 6 s
# for in-flight Expo deliveries to land, THEN closes the pool. Those detached
# pushes are the last thing anyone wants dropped during a restart, so the only
# thing needed here is a stop timeout comfortably above that 6 s.
TimeoutStopSec=30

# Hardening. The process needs to read its own directory, talk to the network,
# and nothing else.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/nigehban
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
```

`uvicorn server.app:app` is the intended production entrypoint —
[server/app.py](../server/app.py) builds `app` at import time precisely so this
works. Do **not** use `python -m server`: that prints the demo banner, probes
for an ngrok tunnel on `127.0.0.1:4040`, and binds `0.0.0.0:8000`, which would
expose the app outside Caddy.

### 8.2 Start it

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nigehban
sudo systemctl status nigehban
curl -s localhost:8000/health          # {"ok":true,"t":...}
```

`enable` is what makes it survive a reboot, which is the whole difference
between this and the laptop.

`/health` is the right thing to poll: it depends on nothing and touches no
database, so it answers "is the process alive" without being confounded by
Supabase being slow. That is also why it is a good uptime-monitor target.

### 8.3 Confirm the sweeper started

```bash
sudo journalctl -u nigehban -n 30 --no-pager
```

You want these two lines, which the lifespan hook logs on startup:

```
server ready - db at aws-0-ap-northeast-1.pooler.supabase.com/postgres
sweeper ticking every 5s - deadlines survive the phone
```

The second line is the one to check on every deploy. A server that answers
`/health` but has no sweeper looks completely healthy and silently stops
escalating every missed check-in in the product.

---

## 9. Step 7 — HTTPS and WebSocket, via Caddy

Caddy rather than nginx for one reason: it obtains and renews Let's Encrypt
certificates by itself, with no certbot cron job and no renewal that quietly
stops working in ninety days. It also proxies WebSocket upgrades with no extra
configuration, which nginx needs three explicit `proxy_set_header` lines for.

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

```bash
sudo nano /etc/caddy/Caddyfile
```

Replace the whole file with:

```caddyfile
api.example.com {
	# TLS is automatic: Caddy solves the ACME challenge on :80, installs the
	# certificate, redirects http->https, and renews on its own thereafter.

	# WebSocket upgrades at /ws pass through untouched -- Caddy forwards the
	# Upgrade and Connection headers by default, and does not buffer, so a
	# socket held open for hours is fine. It also sets X-Forwarded-For, which
	# is what client_ip() in server/ratelimit.py buckets rate limits on.
	reverse_proxy 127.0.0.1:8000 {
		# The default is 2 minutes, which would cut every idle websocket. The
		# phones' heartbeats are far more frequent than this, so a socket that
		# is silent for an hour is a socket to drop.
		transport http {
			read_timeout 3600s
		}
	}

	encode gzip

	log {
		output file /var/log/caddy/access.log {
			roll_size 20mb
			roll_keep 5
		}
	}
}
```

Use tabs or consistent spaces — the Caddyfile is whitespace-sensitive about
block structure. Then:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo journalctl -u caddy -n 40 --no-pager      # watch the certificate arrive
```

Verify from your own machine, not the server:

```bash
curl -i https://api.example.com/health
```

A `200` with a valid certificate and `{"ok":true,...}` means the whole chain —
DNS, security group, Caddy, TLS, uvicorn, FastAPI — is working.

### 9.1 Verify the websocket specifically

The websocket is the live-delivery path, and it is the piece most likely to be
silently broken by a proxy. Test it explicitly, with a real session token (sign
in through the app or `curl` the login route to get one):

```bash
# on the server, in the venv
/opt/nigehban/venv/bin/python - <<'PY'
import asyncio, websockets
async def main():
    async with websockets.connect("wss://api.example.com/ws?token=PASTE_TOKEN") as ws:
        print(await ws.recv())     # {"t":"ready","user_id":"NGB-XXXX",...}
asyncio.run(main())
PY
```

The `ready` frame is the server confirming it matched your token hash and
registered the socket in `HUB`. A `4401` close means the token did not match a
user; a hang or a `502` means the proxy is not forwarding the upgrade.

---

## 10. Step 8 — Point the phones at it

In the app's server-address setting, enter:

```
api.example.com
```

That is all — no scheme, no port. `normalizeBase()` in
[nigehban-app/src/api.js](../nigehban-app/src/api.js) already implements the
rule this deployment needs: a bare IPv4 or `localhost` is treated as the laptop
and gets `http://…:8000`, while anything with a **name** is treated as a public
host and gets `https://` with no port. `wsUrl()` then derives `wss://` from it.
So the cloud address needs no client change at all.

Then walk one alert end to end, because that is the only test that covers the
parts a `curl` cannot:

1. Sign in on both phones. Both should show as online (that is `HUB`).
2. Raise an SOS. The linked phone gets it over the websocket **and** as an Expo
   push.
3. Kill the second app completely (swipe away), raise another SOS. The push
   must still arrive — that is `send_expo_push_notifications` in
   [server/push.py](../server/push.py) reaching `exp.host` from EC2, and it is
   the case that actually matters.
4. Start a check-in and let it expire without answering. The escalation must
   fire ~90 s later (or 45 s / 30 s for a fall / accident incident check-in, per
   `INCIDENT_WINDOW_S` in [server/config.py](../server/config.py)) **with the
   raising phone switched off**. That is the sweeper, and it is the one
   behaviour that could not be demonstrated on the laptop rig once the laptop
   was closed.

Step 4 is the acceptance test for this whole document. If it passes with both
phones off the local Wi-Fi and one of them powered down, the deployment is
doing its job.

`scripts/push_doctor.py` is worth running from the server if push is the part
that misbehaves — it checks the token registration path in isolation.

---

## 11. Cost

Tokyo, on-demand, as of this writing:

| Item | Monthly |
|---|---|
| t4g.small, on-demand | ~$12.30 |
| 20 GB gp3 | ~$1.90 |
| Elastic IP (attached to a running instance) | $0 |
| Data transfer out (a few GB) | ~$0.50 |
| **Total** | **~$15** |

Two ways down, if it matters:

- A **1-year Compute Savings Plan** on that instance takes it to roughly $8/month
  for the compute. It is a commitment; make it once you are sure the shape is
  right.
- **Lightsail** at $10/month bundles the instance, the static IP and 3 TB of
  transfer, and is genuinely simpler. The trade is that you leave the EC2
  ecosystem — no security-group reuse, clumsier snapshots, and moving out later
  is a migration. If this is the only thing you run on AWS, Lightsail is a
  defensible choice; every step in sections 5 through 10 applies unchanged.

Supabase is billed separately and unaffected by any of this.

---

## 12. Operating it

### Deploying a change

Once section 16 is wired up, this happens automatically on every merge to
`main` — that's the whole point of it. What follows is the manual sequence:
useful the first few times so you understand what the pipeline is doing on
your behalf, and useful afterward as the fallback when you need to deploy from
a laptop with no path to GitHub Actions, or when you're debugging a stuck
automated deploy by hand.

```bash
cd /opt/nigehban/app
sudo -u nigehban git pull
sudo -u nigehban /opt/nigehban/venv/bin/pip install -r requirements.txt
sudo -u nigehban /opt/nigehban/venv/bin/python server/migrate_pg.py
sudo systemctl restart nigehban
sudo journalctl -u nigehban -n 20 --no-pager     # check for the sweeper line
```

Migrations run before the restart, and they are idempotent, so this sequence is
the same whether or not the pull contained one.

There is a real gap here worth being honest about: `systemctl restart` is a
few seconds of downtime, and any websocket open at that moment is dropped. The
app reconnects, and a dropped socket does not lose an alert — `emit_alert`
writes to the database first and pushes second, and Expo push does not depend
on the socket. So the exposure is a few seconds in which a *new* alert would
get a connection error and be retried by the client. Deploy when nobody is out
walking, and it costs nothing.

`scripts/deploy.sh` in the repo is this same sequence, hardened with a health
check and an automatic rollback — see section 16 for how it gets onto the box
and why it isn't simply `git pull`ed there like everything else.

### Logs

```bash
sudo journalctl -u nigehban -f                     # live
sudo journalctl -u nigehban --since "2 hours ago"  # a specific window
sudo journalctl -u nigehban -p err --since today   # errors only
sudo tail -f /var/log/caddy/access.log             # HTTP-level
```

The application's own format is
`2026-09-03 02:14:07  WARNING  nigehban.push   ...` — local time, because
whoever reads it is reconstructing an evening against what a family remembers
of it. journald adds its own timestamp in front; that is redundant but harmless.

"Why did nobody get paged at 02:14" is answered by
`journalctl -u nigehban --since "2026-09-03 02:10" --until "2026-09-03 02:20"`.
That question is why the `print()` calls became a logger, and it is the main
reason this box is worth more than the laptop.

Cap the journal so it cannot fill the disk:

```bash
sudo sed -i 's/^#SystemMaxUse=.*/SystemMaxUse=500M/' /etc/systemd/journald.conf
sudo systemctl restart systemd-journald
```

### Backups

The data is entirely in Supabase, so **Supabase's backups are the backups** —
check the retention on your plan; the free tier's is short, and a paid tier with
point-in-time recovery is the cheapest real insurance this product can buy.

The instance holds nothing irreplaceable except `.env`. Keep a copy of that
somewhere safe (a password manager entry, not a cloud drive), and the recovery
story for a lost instance is sections 3 through 9 again — about thirty minutes.
An EBS snapshot before each deploy is optional belt-and-braces.

### Patching

```bash
sudo apt update && sudo apt upgrade -y
sudo reboot            # only when the kernel changed
```

`systemctl enable` means the service comes back on its own after the reboot.
Confirm the sweeper line in the log afterwards anyway.

### Monitoring, minimally

Point any free uptime monitor (UptimeRobot, Better Stack) at
`https://api.example.com/health` every five minutes, alerting to a phone that
is not one of the two in the family. That single check catches the failure that
matters most — the server being down and nobody knowing — and it costs nothing.

A CloudWatch alarm on `StatusCheckFailed` for the instance is a useful second
layer, since it fires even when the box is too wedged to answer HTTP.

---

## 13. When this shape stops fitting

Written down because each of these is a real change, not a console setting.

**More than a handful of families.** The bottleneck will be the 15-connection
Supabase session-mode cap long before it is the CPU. Move `DATABASE_URL` to
Supabase's **transaction-mode** pooler (port `6543`) or to RDS, then raise
`DB_POOL_MAX`. Transaction mode does not support session-level state, so check
nothing in the server relies on it before switching.

**Needing two instances.** This requires code changes first: pull the sweeper
into its own single-replica process (or have it take a Postgres advisory lock,
so only one copy sweeps), and move `HUB` behind Redis pub/sub so a socket on
one instance is reachable from the other. Only then does an ALB with two
targets make sense.

**Needing zero-downtime deploys.** Two instances behind an ALB, per the above.
Not worth it before then; a five-second restart is cheaper than the
architecture that avoids it.

**Wanting a container.** ECS Fargate with `desired-count: 1` works and removes
the patching chore, at roughly double the cost and with the sweeper constraint
still fully in force — the temptation to raise that count is the exact risk
here. If you go this way, put the constraint in the task-definition
description, not just in this file.

**App Runner and Lambda remain out.** App Runner does not do WebSocket; Lambda
has nowhere to run a five-second loop that owns every deadline in the product.

---

## 14. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Caddy won't issue a certificate | DNS not resolving yet, or port 80 blocked | `dig +short api.example.com`; confirm the HTTP/80 rule in the security group |
| `DATABASE_URL not set in .env` | Service `WorkingDirectory` is not the repo root, so `load_dotenv()` finds nothing | See section 6; `WorkingDirectory=/opt/nigehban/app` |
| Every endpoint 500s, including `/me` | `EMAXCONNSESSION` — more than 15 Supabase sessions | Kill stray processes (`scripts/db.py`, a second uvicorn, a test run); lower `DB_POOL_MAX` |
| First request after a quiet night fails, then works | A dropped pooler session handed out of the pool | Already handled — `check=ConnectionPool.check_connection` in `db.py` reconnects transparently. If you see it, confirm nothing has changed that setting |
| Websocket connects then closes with 4401 | Token did not match any `token_hash` | Sign in again; the token is per-session and hashed at rest |
| Websocket drops after ~2 minutes | Proxy read timeout | The `read_timeout 3600s` block in the Caddyfile |
| Push works with the app open, not when killed | Expo token or channel problem, not this deployment | `scripts/push_doctor.py`; check `RESPONDER_CHANNEL_ID` matches the app's `notifications.js` exactly |
| Check-ins never escalate | Sweeper not running | `journalctl -u nigehban \| grep sweeper` — the "ticking every 5s" line must be there |
| Rate limits hit far too easily | Every caller looks like one IP | `client_ip()` reads `X-Forwarded-For`; confirm Caddy is setting it (it does by default) and that nothing sits in front of Caddy stripping it |
| Service restart-loops | Read the actual error | `journalctl -u nigehban -n 50` — usually a missing dependency after a `git pull` without `pip install` |

---

## 15. Checklist

Copy this into the PR that deploys.

- [ ] Region decided per section 1.5 (Mumbai or self-hosted UAE — not Tokyo) and EC2 is in the *same* region as the database
- [ ] Security group: 22 from your IP only; 80 and 443 open; **8000 closed**
- [ ] Elastic IP allocated and associated
- [ ] `A` record resolves to it
- [ ] Service runs as `nigehban`, not `ubuntu` or `root`
- [ ] `.env` is `0600`, owned by `nigehban`, and contains the service-role key
- [ ] `ALLOWED_ORIGINS` is empty
- [ ] `server/migrate_pg.py` printed `all clocks are epoch seconds`
- [ ] `systemctl is-enabled nigehban` says `enabled`
- [ ] Exactly **one** uvicorn process, no `--workers`
- [ ] Startup log shows `sweeper ticking every 5s`
- [ ] `https://api.example.com/health` returns 200 with a valid certificate
- [ ] `wss://api.example.com/ws` returns a `ready` frame
- [ ] Uptime monitor points at `/health`, alerting somewhere outside the family
- [ ] An expired check-in escalated with the raising phone powered off
- [ ] `.env` backed up somewhere that is not this instance
- [ ] App checkout on the box tracks `main` (section 5.3) — not a feature branch
- [ ] `deployer` account exists, key-only, with the one-line sudoers rule from section 16.2
- [ ] `/opt/nigehban/deploy.sh` is in place, owned by `root`, mode `700` — and is **not** a symlink into the git checkout
- [ ] `DEPLOY_SSH_KEY` and `DEPLOY_HOST` are set as GitHub Actions secrets
- [ ] A push to `main` produced a green run in the Actions tab, and `/health` answered afterward
- [ ] A deliberately broken push (bad import, say) triggered the rollback in `deploy.sh` — tested once, on purpose, before trusting it

---

## 16. CI/CD — deploy automatically on merge to main

Everything above this line gets you a server that stays up. This section gets
you the thing you actually asked for: merge a PR into `main`, and within a
couple of minutes it's live, with no SSH session on your end.

Two files already exist for this, written alongside this document:

- [.github/workflows/deploy.yml](../.github/workflows/deploy.yml) — the
  pipeline: a fast test gate, then a deploy step.
- [scripts/deploy.sh](../scripts/deploy.sh) — what actually runs on the box.
  Tracked here for review and history; **not** the copy that executes (16.2
  explains why).

Both are ready to use. What's left is entirely on the AWS side: create the
`deployer` account, install the script, add two secrets in GitHub. About
fifteen minutes, once.

### 16.1 What the pipeline gates on — and the one thing not to change

`.github/workflows/deploy.yml`'s `test` job runs exactly two of the ten files
under [tests/](../tests/):

```
python tests/test_sweeper_recovers.py
python tests/test_watch_lost_transition.py
```

Every other test file opens with `python server/nigehban_server.py` — they're
written to run against a live server and a real Postgres, for local, manual
use. These two are the only ones whose own header says "no server, no
database, no network," which is what makes them safe to run inside a GitHub
Actions runner with no secrets at all.

**Do not wire the other eight into this workflow by pointing `DATABASE_URL` at
production.** `test_sockets.py`, `test_samaritan_and_checkin.py`,
`test_signout_stops_push.py` and the rest raise real alerts, open real
check-ins and register real devices against whatever database they're pointed
at — that's the point of them locally, and it's exactly what must never touch
the same Supabase project (or RDS instance) that a real family's data lives
in. Extending CI to run them for real would need a second, disposable Postgres
— a `postgres:` service container in the workflow, migrated fresh on every
run — which is a legitimate thing to build later but is a deliberate scope
line, not an oversight, for this pass.

### 16.2 One-time setup on the EC2 box

Run once, after section 8 (the systemd unit) is already working.

**A deploy-only account.** Not `ubuntu` — that account has unrestricted
`sudo`, and handing its key to GitHub's servers would mean a compromised CI
run, or a leaked secret, is full root on the box that holds the database
credentials.

```bash
sudo useradd --create-home --shell /bin/bash deployer
sudo install -d -m 700 -o deployer -g deployer /home/deployer/.ssh
```

Generate a key pair *on your own machine* (never on the server) —
`ssh-keygen -t ed25519 -C "github-actions-deploy" -f nigehban-deploy-key -N ""`
— and put the **public** half on the box:

```bash
echo "ssh-ed25519 AAAA...github-actions-deploy" | \
  sudo tee -a /home/deployer/.ssh/authorized_keys
sudo chmod 600 /home/deployer/.ssh/authorized_keys
sudo chown deployer:deployer /home/deployer/.ssh/authorized_keys
```

The **private** half is what goes into the `DEPLOY_SSH_KEY` GitHub secret in
16.3, and nowhere else — not committed, not emailed, not left in shell
history. Once it's pasted into GitHub, delete the local file.

**A sudoers rule narrow enough to mean something.**

```bash
sudo visudo -f /etc/sudoers.d/nigehban-deploy
```

containing exactly:

```
deployer ALL=(root) NOPASSWD: /opt/nigehban/deploy.sh
```

One line, one command, no wildcard. `deployer` can run this script as root
with no password — and cannot `sudo` anything else, including editing the
script it just got permission to run.

**Why `deploy.sh` lives outside the app checkout, and must stay there.** The
temptation is `/opt/nigehban/app/scripts/deploy.sh`, since it's already
tracked in git and `git reset --hard origin/main` would keep it current for
free. Don't — walk through what that would mean: the sudoers rule above grants
`deployer` root to run that exact path with no password, and if that path is
inside the checkout that every merge to `main` rewrites, then *merging to
main* would be able to rewrite what runs as root on the box. A single bad line
in a PR — `rm -rf /`, a reverse shell, `chmod 4755 /bin/bash` — would go from
"a bug in the service" to "root on the server" the moment it merged. Today,
before any of this, merging to `main` only ever earns you control of the
unprivileged `nigehban` service process; keeping `deploy.sh` outside the
auto-pulled tree is what keeps that true after CI/CD exists too.

So: copy it in by hand, and copy it in again by hand whenever
[scripts/deploy.sh](../scripts/deploy.sh) changes. That manual step is the
actual security boundary here — treat a change to that file the way you'd
treat a change to the sudoers rule itself, because it has the same reach.

```bash
scp scripts/deploy.sh ubuntu@api.example.com:/tmp/deploy.sh
ssh ubuntu@api.example.com
sudo mv /tmp/deploy.sh /opt/nigehban/deploy.sh
sudo chown root:root /opt/nigehban/deploy.sh
sudo chmod 700 /opt/nigehban/deploy.sh
```

Confirm the wiring before touching GitHub — from your machine, using the
`deployer` key:

```bash
ssh -i nigehban-deploy-key deployer@api.example.com "sudo /opt/nigehban/deploy.sh manual-test"
```

That should pull, install, migrate, restart, poll `/health`, and print
`deployed <sha>, healthy`. If it does, the box is ready.

### 16.3 GitHub side

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Value |
|---|---|
| `DEPLOY_SSH_KEY` | the private half of the key from 16.2, whole file, including the `-----BEGIN`/`-----END` lines |
| `DEPLOY_HOST` | `api.example.com` — no scheme, no port |

Optional, worth doing once things are calm: create a GitHub **Environment**
named `production` (Settings → Environments), which the `deploy` job in
[deploy.yml](../.github/workflows/deploy.yml) already targets via
`environment: production`. On its own it changes nothing; add a required
reviewer there later if you ever want "merged" and "live" to be two separate
human decisions for this app instead of one.

### 16.4 What happens on a merge to main

1. `test` runs — the two dependency-free files, ~10 seconds.
2. `deploy` runs, only if `test` passed: SSHes in as `deployer`, runs
   `sudo /opt/nigehban/deploy.sh <commit-sha>`.
3. `deploy.sh`, on the box: fetches and hard-resets `/opt/nigehban/app` to
   `origin/main`, reinstalls dependencies, runs `server/migrate_pg.py`,
   restarts the `nigehban` service, then polls `/health` for up to 10 seconds.
4. If `/health` comes back: done. If it never does, `deploy.sh` resets the
   checkout to the previous commit, reinstalls, restarts, and polls again —
   then exits non-zero either way, so the Actions run shows red and you know
   to look, rather than finding out from a family that the app went quiet.
5. The workflow's last step hits `https://<host>/health` from outside,
   through Caddy — confirming the whole path, not just that uvicorn answered
   on localhost.

Because `concurrency: group: production-deploy` sits on the workflow, a second
push while one deploy is still running queues behind it rather than racing it
— consistent with the one-instance, one-sweeper rule in section 1.1.

### 16.5 What this does not cover

- **Schema rollback.** `deploy.sh` rolls back *code*, never a migration that
  already ran — `server/migrate_pg.py`'s files are idempotent by construction,
  so re-running them after a code rollback is a no-op, not a hazard, but there
  is no automatic "undo" for a migration that shipped a bad column. Same as
  the manual process in section 12: write migrations you'd be comfortable
  never reversing.
- **Zero-downtime.** `systemctl restart` still drops open websockets for a
  couple of seconds, same as section 12 describes — the pipeline doesn't
  change that, it just runs the same restart on a schedule instead of by hand.
- **Staging.** This deploys straight to the one production box on every merge
  to `main`, exactly as asked. If you later want a review app or a staging
  server in between, that's a second EC2 instance and a second workflow
  trigger (e.g. on PRs, targeting a different `DEPLOY_HOST` secret under a
  `staging` environment) — worth doing once there's a team big enough that
  "just merge and watch" stops being the right amount of process.

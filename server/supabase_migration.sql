-- ============================================================
-- NIGEHBAN — Supabase Migration
-- Run this in: Supabase Dashboard → SQL Editor → New Query → Run
-- ============================================================

-- Extensions
create extension if not exists "pgcrypto";

-- ============================================================
-- USERS
-- ============================================================
create table if not exists public.users (
    id           text primary key,
    username     text unique not null,
    pw_hash      text not null,
    name         text not null,
    token_hash   text not null default '',
    role         text not null default 'user'
                     check (role in ('admin', 'user')),
    created_at   timestamptz not null default now()
);

create index if not exists idx_users_token on public.users (token_hash);

-- ============================================================
-- FAMILY LINKS
-- ============================================================
create table if not exists public.links (
    owner_id   text not null references public.users(id) on delete cascade,
    member_id  text not null references public.users(id) on delete cascade,
    relation   text not null default '',
    created_at timestamptz not null default now(),
    primary key (owner_id, member_id)
);

create index if not exists idx_links_member on public.links (member_id);

-- ============================================================
-- ALERTS
-- ============================================================
create table if not exists public.alerts (
    id          bigint generated always as identity primary key,
    user_id     text not null references public.users(id) on delete cascade,
    kind        text not null,
    severity    smallint not null,
    source      text not null default 'app',
    lat         double precision,
    lon         double precision,
    accuracy    double precision,
    note        text not null default '',
    created_at  timestamptz not null default now(),
    resolved_at timestamptz
);

create index if not exists idx_alerts_user
    on public.alerts (user_id, created_at desc);

-- ============================================================
-- ACKNOWLEDGEMENTS
-- ============================================================
create table if not exists public.acks (
    alert_id bigint not null references public.alerts(id) on delete cascade,
    user_id  text   not null references public.users(id)  on delete cascade,
    at       timestamptz not null default now(),
    primary key (alert_id, user_id)
);

-- ============================================================
-- PAIRINGS
-- ============================================================
create table if not exists public.pairings (
    token_hash text primary key,
    issuer_id  text not null references public.users(id) on delete cascade,
    relation   text not null default '',
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    used_at    timestamptz,
    used_by    text
);

-- ============================================================
-- INVITES
-- ============================================================
create table if not exists public.invites (
    id         bigint generated always as identity primary key,
    from_id    text not null references public.users(id) on delete cascade,
    to_id      text not null references public.users(id) on delete cascade,
    relation   text not null default '',
    state      text not null default 'pending',
    created_at timestamptz not null default now(),
    settled_at timestamptz,
    unique (from_id, to_id)
);

create index if not exists idx_invites_to on public.invites (to_id, state);

-- ============================================================
-- DEVICES
-- ============================================================
create table if not exists public.devices (
    id          text primary key,
    user_id     text not null references public.users(id) on delete cascade,
    push_token  text,
    platform    text,
    os_version  text,
    app_version text,
    last_seen   timestamptz
);

-- ============================================================
-- CHECK-INS
-- ============================================================
create table if not exists public.checkins (
    id         bigint generated always as identity primary key,
    user_id    text not null references public.users(id) on delete cascade,
    asked_by   text,
    reason     text not null default 'manual',
    due_at     timestamptz not null,
    created_at timestamptz not null default now(),
    acked_at   timestamptz,
    escalated  boolean not null default false
);

create index if not exists idx_checkins_due
    on public.checkins (due_at)
    where acked_at is null and escalated = false;

-- ============================================================
-- WATCH STATE
-- ============================================================
create table if not exists public.watch_state (
    user_id       text primary key references public.users(id) on delete cascade,
    -- The HIGHEST live alert: idle | high_alert | sos. An SOS raises it above
    -- High Alert without ending High Alert -- which is what `high_alert` below
    -- is for. Reading "is High Alert armed" off this column is what silently
    -- ended the check-ins for good the first time somebody pressed SOS. See
    -- migrations/008_high_alert_own_column.sql.
    mode          text not null default 'idle',
    -- Is High Alert armed? The sweeper's check-ins run on this.
    high_alert    boolean not null default false,
    next_buzz_at  timestamptz,
    last_beat     timestamptz,
    band_link     boolean not null default false,
    -- Two batteries, and they fail independently: a flat band means the safety
    -- device is off the air, a flat phone means every path to the family is
    -- about to close. band_batt is null in virtual mode, where there is no
    -- band. See migrations/002_band_battery.sql -- phone_batt held band
    -- battery before that migration.
    phone_batt    smallint,
    band_batt     smallint,
    last_lat      double precision,
    last_lon      double precision,
    lost_notified boolean not null default false,
    -- WITNESSED state: what the phone said about itself at the last heartbeat,
    -- as opposed to what the row happens to say at sweep time. `watch_lost` is
    -- a transition -- "had a band link AND was armed, and then the link went"
    -- -- and these two are the only fields that still describe the moment
    -- before a loss once the phone has stopped talking. See
    -- migrations/006_watch_lost_transition.sql and server/watch_lost.py.
    --
    -- beat_band_link is `band_link AND NOT band_virtual`: a PHYSICAL wristband
    -- and nothing else. In virtual mode the phone runs the band's firmware and
    -- reports band_link=true, correctly -- but there is no wristband, and
    -- watch_lost is the alert about one going away.
    beat_band_link boolean not null default false,
    beat_armed     boolean not null default false,
    -- A watch_lost page holds the alert down until this time, so a band
    -- flapping at the edge of range pages the family once, not a dozen times.
    lost_rearm_at  double precision,
    -- When the band link went away while armed, or null if the band is here.
    -- A drop starts a two-minute grace window rather than an alert: Bluetooth
    -- drops for reasons that are not emergencies, and a band that comes back
    -- inside the window clears this and is never mentioned to anyone. See
    -- migrations/007_watch_lost_grace.sql.
    link_lost_at   double precision
);

-- ============================================================
-- PRESENCE
-- ============================================================
create table if not exists public.presence (
    user_id  text primary key references public.users(id) on delete cascade,
    geohash6 text not null,
    lat      double precision not null,
    lon      double precision not null,
    at       timestamptz not null default now()
);

create index if not exists idx_presence_geo on public.presence (geohash6, at);

-- ============================================================
-- SAMARITANS
-- ============================================================
create table if not exists public.samaritans (
    alert_id bigint not null references public.alerts(id) on delete cascade,
    user_id  text   not null references public.users(id)  on delete cascade,
    at       timestamptz not null default now(),
    primary key (alert_id, user_id)
);

-- ============================================================
-- Done.
-- ============================================================

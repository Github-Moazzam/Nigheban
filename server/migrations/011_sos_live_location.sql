-- Where she is NOW, not only where she was when the button went down.
--
-- Until this migration the server knew exactly two positions for an emergency:
-- the fix baked into the alert at press time, and `watch_state.last_lat/lon`
-- from a sixty-second heartbeat that only runs while the watch is armed. Both
-- answer "where did this start". Neither answers the question a family member
-- actually asks on the way over, which is "where is she now" -- and during a
-- snatch, an abduction, or a walk home that turned bad, those two are the same
-- answer for about thirty seconds and then diverge for good.
--
-- So a live alert gets a moving position. `alerts.live_*` is the newest fix,
-- kept on the alert row itself so a family member opening a cold app gets the
-- current pin rather than the origin one; `alert_track` is the trail behind it,
-- which is what turns "she is here" into "she is moving north up Ferozepur
-- Road" -- a different and much more actionable fact.
--
-- `track_until` is the clock on all of it. Live tracking is not a mode this
-- product leaves running: it starts with the emergency and it stops, and the
-- column is what makes stopping a fact the SERVER owns rather than a promise
-- the phone makes. It outlives the stand-down on purpose -- see
-- TRACK_AFTER_STANDDOWN_S in config.py -- because "I am safe" is pressed at the
-- roadside and the walk home afterwards is the part the family still wants to
-- watch.
--
-- Idempotent: re-running is a no-op.

alter table if exists public.alerts
    add column if not exists live_lat      double precision,
    add column if not exists live_lon      double precision,
    add column if not exists live_accuracy double precision,
    add column if not exists live_at       double precision,
    add column if not exists track_until   double precision;

comment on column public.alerts.live_at is
    'When the newest live fix arrived. Null means nothing has been reported since the alert was raised, and the family screen must fall back to lat/lon -- "where it happened" -- rather than drawing a stale pin as though it were current.';

comment on column public.alerts.track_until is
    'When live tracking stops, in epoch seconds. Set while the alert is live and extended past the stand-down so the walk home is still visible. Null means this alert was never tracked.';

-- The trail. One row per reported fix, and deliberately a separate table:
-- `alerts.live_*` is a value that gets overwritten every ten seconds, and a
-- path is a thing you cannot reconstruct from the last value of one.
create table if not exists public.alert_track (
    id       bigint generated always as identity primary key,
    alert_id bigint not null references public.alerts(id) on delete cascade,
    at       double precision not null,
    lat      double precision not null,
    lon      double precision not null,
    accuracy double precision
);

-- The only read there is: "the path of this alert, in order". Everything the
-- family screen draws comes off this index.
create index if not exists idx_alert_track_alert
    on public.alert_track (alert_id, at);

-- Two answered check-ins in a row mean she is safe, and this is the counter.
--
-- It lives on watch_state rather than on the alert because it is a fact about
-- the PERSON's current run of answers, and the run has to survive an alert
-- being replaced -- a missed High Alert check-in escalating into an SOS is a
-- new alert row, and the wearer's answers to the questions that follow are
-- still one continuous conversation.
--
-- Reset to zero by three things: raising an SOS, missing an SOS check-in, and
-- the stand-down that reaching the threshold causes. Nothing else touches it.
alter table if exists public.watch_state
    add column if not exists sos_streak smallint not null default 0;

comment on column public.watch_state.sos_streak is
    'Consecutive SOS check-ins answered. At SOS_SAFE_STREAK the emergency stands itself down. Any missed SOS check-in puts it back to zero, because the point is a RUN of answers -- one answer followed by silence is not reassurance, it is the thing the check-ins exist to catch.';

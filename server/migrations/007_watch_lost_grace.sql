-- A band that has gone away gets two minutes to come back.
--
-- Migration 006 made watch_lost fire on the transition rather than on a
-- reading, and it fired the moment the transition was seen -- a second or two
-- after the wristband dropped, since the app reports a link change straight
-- away rather than waiting for its next heartbeat.
--
-- That is too fast for what Bluetooth actually does. A wrist inside a coat
-- sleeve, a phone moved to the other pocket, a microwave, Android throttling
-- the radio while the screen is off: all of them drop the link for a few
-- seconds and all of them look exactly like a torn-off band while they do.
-- Paging a family for each one is how a safety product teaches people to
-- ignore it.
--
-- So a drop now starts a clock instead of an alert. `link_lost_at` is when the
-- band went away; the sweeper pages WATCH_LOST_DELAY_S (120 s) later, and a
-- heartbeat reporting the band back clears the column and the whole thing is
-- forgotten.
--
-- In the row rather than in a timer, deliberately. A timer belongs to a
-- process, and this server being restarted -- a deploy, a crash, a laptop lid
-- -- must not silently cancel a countdown somebody's safety is resting on.
-- Postgres remembers; an asyncio task does not.
--
-- Null is "the band is here, nothing is counting", which is the correct
-- reading for every row that existed before this migration.
--
-- Idempotent: re-running is a no-op.

alter table if exists public.watch_state
    add column if not exists link_lost_at double precision;

comment on column public.watch_state.link_lost_at is
    'When the physical band link went away while an alert was running, or null if the band is here. A running grace window: the sweeper raises watch_lost once now - link_lost_at passes WATCH_LOST_DELAY_S (120 s), and a heartbeat reporting the band back clears it so the family is never told about a brief drop. Held in the row rather than in a timer so a server restart cannot cancel it.';

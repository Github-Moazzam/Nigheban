-- High Alert stops being a value of `mode`, and gets a column of its own.
--
-- `mode` was answering two different questions with one string:
--
--     "which alert is live right now"   -> idle | high_alert | sos
--     "is High Alert armed"             -> mode = 'high_alert'
--
-- Those are not the same question, and an SOS is where they come apart. POST
-- /alert sets mode='sos', which is right for the first question and destroys
-- the answer to the second -- while the sweeper asks its High Alert check-ins
-- with `WHERE mode='high_alert'`.
--
-- So: arm High Alert, press SOS, and High Alert stops asking. Not for the
-- duration of the emergency -- for good, or until it is re-armed by hand.
-- `next_buzz_at` goes on ticking and nothing ever matches it again, so the
-- phone draws a countdown to a deadline the server will never act on. Found in
-- the field with a row whose next buzz was eighty-seven minutes overdue and
-- whose wearer had been shown "next check-in soon" the whole time.
--
-- It fails the other way too. Standing High Alert down wrote mode='idle'
-- unconditionally, so switching it off during an emergency quietly downgraded
-- a live SOS to idle -- which stands the heartbeat watchdog down with it.
--
-- After this, `high_alert` is the armed flag and `mode` is only ever the
-- highest live alert. Resolving an SOS falls back to 'high_alert' if it is
-- still armed rather than always to 'idle', and standing High Alert down
-- leaves a live SOS alone.
--
-- The backfill matters: a row mid-emergency at migration time has mode='sos'
-- and may well have High Alert armed behind it. There is no way to recover
-- that from this schema -- the information was destroyed when mode was
-- overwritten -- so those rows come out with high_alert=false and their wearer
-- re-arms. Rows sitting in mode='high_alert' carry across exactly.
--
-- Idempotent: re-running is a no-op.

alter table if exists public.watch_state
    add column if not exists high_alert boolean not null default false;

update public.watch_state set high_alert = true
 where mode = 'high_alert' and high_alert = false;

comment on column public.watch_state.high_alert is
    'Is High Alert armed? The sweeper asks its check-ins on THIS, not on mode. mode is the highest live alert (idle|high_alert|sos) and an SOS overwrites it, which is correct for severity and used to silently end High Alert''s questions for good -- the two facts need two columns.';

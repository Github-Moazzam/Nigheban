-- One press, one alert -- however many times the phone has to ask.
--
-- The app aborts a request after 8 s. An SOS was taking longer than that on
-- the server (nine separate connections to a pooler in Tokyo, then up to three
-- Expo calls at a 5 s timeout each), so the phone gave up on a request that
-- had ALREADY inserted the row and paged the family. `call()` threw, App.js
-- caught it, enqueued the alert as undelivered, and four separate flush
-- triggers re-sent it. Nothing on this table could tell the retry apart from a
-- second press, so each one became a new row and a new page.
--
-- A family woken four times for one press learns to ignore the fourth, and
-- then the fourth is the real one. So the press gets an id, minted on the
-- phone at the moment the button goes down and reused for every retry of that
-- same press.
--
-- Partial index, not a plain unique constraint: everything the SERVER raises
-- (the sweeper's checkin_missed, watch_lost) has no client_id and must stay
-- free to repeat -- two missed check-ins an hour apart are two real events.
-- Scoped to user_id because the id is only unique on the phone that made it.
--
-- Idempotent: re-running is a no-op.

alter table if exists public.alerts
    add column if not exists client_id text;

create unique index if not exists alerts_client_id_uniq
    on public.alerts (user_id, client_id)
    where client_id is not null;

comment on column public.alerts.client_id is
    'Phone-minted id for one press, carried across every retry of that press. Null for anything the server raised itself, which is free to repeat.';

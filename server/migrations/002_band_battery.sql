-- Two batteries, not one.
--
-- `phone_batt` has been holding the *band's* battery since the column was
-- written. The app read `band.battery` -- which in BLE mode is the wristband's
-- ADC reading from nigehban_band_nrf52.ino -- and sent it under that name, and
-- the family was then told "his phone is about to die" about a wristband. A
-- wearer at 4% band / 90% phone paged his family with the wrong device, and a
-- wearer whose phone was genuinely dying said nothing at all.
--
-- The fix needs both numbers, because both matter and they fail independently:
-- a flat band means the safety device is off the air, a flat phone means every
-- path to the family is about to close. During an emergency the family wants to
-- know which one they are looking at.
--
-- `phone_batt` keeps its name and becomes what it always claimed to be. Rows
-- written before this migration hold band battery under it; they are not worth
-- back-filling, since the next heartbeat overwrites them and the value is only
-- ever read as "right now".
--
-- Idempotent: re-running is a no-op.

alter table if exists public.watch_state
    add column if not exists band_batt smallint;

comment on column public.watch_state.phone_batt is
    'The phone''s own battery percentage. Before migration 002 this column held band battery.';
comment on column public.watch_state.band_batt is
    'The wristband''s battery percentage, or null in virtual mode where there is no band.';

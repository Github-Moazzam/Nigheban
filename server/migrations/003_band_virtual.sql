-- Is the phone standing in for the band?
--
-- Migration 002 split the two batteries, but left the family with no way to
-- tell the two *devices* apart. In virtual mode the phone runs the firmware
-- itself, so it reports band_link=true -- correctly, the gestures work -- with
-- no second cell behind it. The family screen then showed a band, and showed a
-- band battery, and both were the phone.
--
-- Worse, band_batt is written with COALESCE so a null never erases it. A wearer
-- who linked a real band once and then switched back to the phone kept showing
-- that band's last reading forever: a number that stopped being true weeks ago,
-- sitting on a safety screen, looking live.
--
-- So the phone says which kind of band it is, every heartbeat, and the server
-- clears band_batt whenever the answer is "there is no band". Default false:
-- an older build that does not send the field is describing a real band, which
-- is what it was doing before this column existed.
--
-- Idempotent: re-running is a no-op.

alter table if exists public.watch_state
    add column if not exists band_virtual boolean not null default false;

comment on column public.watch_state.band_virtual is
    'True when the phone itself is the band (virtual mode). band_batt is null in that case, and the family screen says "phone as band" rather than showing a wristband that does not exist.';

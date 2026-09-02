-- watch_lost becomes a transition, not a reading.
--
-- The heartbeat watchdog used to select on the row as it looked at sweep time:
--
--     mode != 'idle' AND lost_notified = FALSE AND last_beat < now - 180
--
-- Two of those three columns are wrong for the question being asked.
--
-- `mode` is live and server-owned. /alert and /watch/high_alert write it long
-- after the last beat, so at sweep time it answers "is she armed now" rather
-- than "was she armed when she went quiet". A phone idle and silent since
-- lunch that raises an SOS flips mode='sos' against a three-hour-old last_beat
-- and the very next tick pages the whole family for a loss that never
-- happened -- on top of the SOS, which had already told them.
--
-- And `band_link` was sitting in the same row unread, so an armed phone with
-- no band within a mile of it reported its wearer's watch lost. Read on its own
-- it would still have been wrong for virtual mode, where the phone runs the
-- band's firmware and reports band_link=true with no wristband behind it --
-- hence `beat_band_link` being `band_link AND NOT band_virtual`, narrowed at
-- the moment it is witnessed so nothing downstream can forget to.
--
-- These three columns are what the rule needs instead. The first two are
-- WITNESSED state: written only when the phone actually reports, they still
-- describe the moment before a loss long after the phone has stopped being
-- able to describe anything. The third is the flap guard -- a band at the edge
-- of range drops and re-links every few seconds, and every re-link used to
-- clear the latch and re-arm the page.
--
-- Defaults are the quiet answer, which is the right way for a paging rule to
-- land on rows written before it existed: a row that has not beaten since the
-- migration witnessed nothing, so it pages nobody until the next heartbeat
-- fills these in -- which is at most sixty seconds away on any armed phone.
--
-- Idempotent: re-running is a no-op.

alter table if exists public.watch_state
    add column if not exists beat_band_link boolean not null default false,
    add column if not exists beat_armed     boolean not null default false,
    add column if not exists lost_rearm_at  double precision;

comment on column public.watch_state.beat_band_link is
    'Was there a live link to a PHYSICAL wristband at the last heartbeat -- band_link AND NOT band_virtual? Witnessed state: written only by /heartbeat (and inherited by an arming endpoint when the last beat is still fresh). This is the "was connected" half of the watch_lost transition. It is deliberately narrower than band_link, which is true in virtual mode too: the phone runs the firmware itself there and the gestures work, but there is no wristband, and watch_lost is specifically about one going away.';

comment on column public.watch_state.beat_armed is
    'Was an alert (sos or high_alert) running at the last heartbeat? The "was armed" half of the watch_lost transition. Never read `mode` for this: mode is mutated by /alert and /watch/high_alert after the beat, which is exactly how a silent idle phone raising an SOS used to page its family for a watch_lost.';

comment on column public.watch_state.lost_rearm_at is
    'A watch_lost page holds the alert down until this time, whatever the band link does in between. Without it a band flapping at the edge of range paged the family on every re-drop, because each re-link cleared lost_notified.';

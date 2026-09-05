-- A link somebody can open and watch her move.
--
-- Every "see where they are" in this product until now was
-- `https://maps.google.com/?q=<lat>,<lon>` -- a coordinate handed to somebody
-- else's page, once. It is a photograph. The family member opens it, sees a
-- pin, and that pin is still sitting there twenty minutes later while she is a
-- kilometre away, because there is no mechanism in that URL for anything to
-- update it. There never was one and there never will be: pushing a new
-- position into an external maps app is not something an external maps app
-- lets you do.
--
-- So the page has to be ours. This table is what makes one addressable.
--
-- WHY A TOKEN AND NOT A LOGIN. The person who most needs this is frequently
-- not a Nigehban user at all. It is the police, a rickshaw driver, a
-- shopkeeper on the corner, the cousin who never installed the app -- whoever
-- the family member is on the phone to while they drive. A link they can be
-- sent and simply open is the difference between help that arrives and help
-- that is still being onboarded. `/alert/{id}/track` already covers the
-- signed-in case and keeps its family-only rule; this is deliberately the
-- other thing.
--
-- WHAT MAKES THAT SAFE ENOUGH:
--
--   - The token is 32 random URL-safe characters. It is not guessable and it
--     is not enumerable; there is no id to walk.
--   - It is stored HASHED, exactly like a session token (see security.py).
--     A leaked database is not a list of live tracking links.
--   - It DIES. `expires_at` is the alert's own tracking window, so the link
--     stops working when the tracking does -- including the half hour after a
--     stand-down. A link forwarded to a WhatsApp group does not become a
--     permanent window into somebody's movements, which is the failure that
--     would make this feature indefensible.
--   - `revoked_at` is the manual override, for the wearer or the server.
--
-- One row per alert. Re-issuing for the same alert returns the same row, so a
-- link already sent to somebody keeps working rather than being silently
-- replaced by a second one nobody has.
--
-- Idempotent: re-running is a no-op.

create table if not exists public.alert_share (
    alert_id   bigint primary key references public.alerts(id) on delete cascade,
    token_hash text not null unique,
    created_at double precision not null,
    expires_at double precision,
    revoked_at double precision
);

-- The only lookup there is: a token arrives on a URL, and this answers "which
-- alert, and is it still live?" in one index hit. Unique above already builds
-- the index; this is the covering read path made explicit.
create index if not exists idx_alert_share_token
    on public.alert_share (token_hash);

comment on table public.alert_share is
    'Unguessable, expiring links to the live tracking page. Stored hashed like a session token. One per alert; dies with the alert''s tracking window so a forwarded link cannot become a permanent window into somebody''s movements.';

comment on column public.alert_share.expires_at is
    'Mirrors alerts.track_until. The link stops working when tracking does -- that is what makes it safe to hand to a stranger who is closer than the family.';

-- 006_samaritan_consent.sql
-- User and Family consent controls for the Good Samaritan emergency broadcast.

alter table if exists public.alerts
    add column if not exists samaritan_status text not null default 'pending',
    add column if not exists samaritan_decided_by text references public.users(id);

alter table if exists public.users
    add column if not exists samaritan_enabled boolean not null default true;

comment on column public.alerts.samaritan_status is
    'Good Samaritan broadcast status: pending (awaiting user/family decision), allowed (broadcasted to nearby strangers), or denied (strictly family only).';

comment on column public.users.samaritan_enabled is
    'Whether this user participates as a Good Samaritan helper to receive nearby emergency requests.';

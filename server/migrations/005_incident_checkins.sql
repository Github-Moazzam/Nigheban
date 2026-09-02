-- A check-in that knows where it was asked, so the alert it becomes has a pin.
--
-- Every check-in until now was a question with no place attached, and that was
-- right for the two that existed: a parent asking "are you okay?" and High
-- Alert asking on a timer. Neither is about a location, and the answer to both
-- is a person pressing a button.
--
-- A fall and a road accident are not that. The whole point of them is WHERE:
-- what the family needs when nobody answers is not "she did not reply", it is
-- a map pin at the roadside she is lying next to. The phone knows that pin at
-- the moment of the impact -- and it is the one moment it is worth knowing,
-- because a phone that goes on to be thrown clear, run over, or simply carried
-- into a hospital will report somewhere else by the time the deadline passes.
--
-- So the fix is to capture the position with the QUESTION and let the sweeper
-- raise the alert from that, rather than from wherever the phone last was. The
-- sweeper has no phone to ask anyway; that is the entire reason it exists.
--
-- `note` carries the measurement that opened the question -- "impact 19 g at
-- 48 km/h, stopped dead" -- into the alert body, so a family member reading it
-- at 2 a.m. is told what actually happened rather than just being frightened.
--
-- Idempotent: re-running is a no-op.

-- `client_id` is the same idea as alerts.client_id and it is here for the same
-- reason, only more so. An impact happens in the second the network is at its
-- worst -- under a flyover, in a ditch, phone face down on tarmac -- so the
-- request that opens the question WILL be retried. Without an id, each retry is
-- a fresh question with a fresh deadline, and one crash escalates two, three,
-- four times: the family is paged repeatedly for a single event, which is
-- precisely how a family learns to ignore the page that matters.

alter table if exists public.checkins
    add column if not exists lat       double precision,
    add column if not exists lon       double precision,
    add column if not exists note      text not null default '',
    add column if not exists client_id text;

-- Partial, like the alerts one: everything the SERVER opens (High Alert's
-- periodic question) carries no client_id and must stay free to repeat, since
-- two High Alert check-ins an hour apart are two real questions.
create unique index if not exists checkins_client_id_uniq
    on public.checkins (user_id, client_id)
    where client_id is not null;

comment on column public.checkins.lat is
    'Where the incident that opened this question happened -- captured with the question, not read again at the deadline. Null for a manual or High Alert check-in, which are not about a place.';

comment on column public.checkins.note is
    'What the detector measured, in words, carried into the escalated alert so the family is told what happened and not only that nobody answered.';

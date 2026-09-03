-- 010: one username, one account.
--
-- POST /register checks for a taken username with a SELECT and then INSERTs.
-- Between those two statements is a gap, and two people signing up as the same
-- name in the same second both pass the check. Nothing downstream noticed:
-- /login does `SELECT * FROM users WHERE username=%s` and takes fetchone(), so
-- one of the two accounts becomes unreachable -- correct password, correct
-- username, and the row that answers is somebody else's. There is no error
-- message for that anywhere, because from the server's side nothing failed.
--
-- The index is what makes the race decidable. routes/auth.py now catches the
-- UniqueViolation and returns the same 409 the SELECT would have.
--
-- Usernames are stored lowercase (`b.username.strip().lower()`), so a plain
-- unique index is the right one -- no need for lower(username).

do $$
declare
    dupes text;
begin
    -- Refuse loudly rather than half-applying. A duplicate already in the table
    -- means somebody out there cannot sign in, and quietly skipping the index
    -- would leave that true AND leave the race open. Whoever runs this needs to
    -- see the names and decide which account keeps which -- there is no correct
    -- automatic answer, since both may have real alerts and real family links.
    select string_agg(username || ' (' || n || ' accounts)', ', ')
      into dupes
      from (select username, count(*) as n
              from users
             group by username
            having count(*) > 1) d;

    if dupes is not null then
        raise exception
            'cannot make usernames unique -- these are already duplicated: %. '
            'Resolve them first: scripts/db.py "select id, username, name, '
            'created_at from users where username in (...)", then decide which '
            'account keeps the name and rename or remove the other.', dupes;
    end if;
end $$;

create unique index if not exists users_username_uniq on users (username);

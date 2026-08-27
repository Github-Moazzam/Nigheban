-- Times are epoch seconds, not timestamptz.
--
-- The Supabase schema was hand-written with `timestamp with time zone`, but
-- every clock in this server is a float from time.time(): the sweeper compares
-- `due_at <= now`, `late = now - due_at` is arithmetic, and the phone is handed
-- `due_at` as a number it counts down from. A timestamptz column makes all
-- three a type error -- which is exactly what the sweeper hit:
--
--   operator does not exist: timestamp with time zone <= double precision
--
-- The original SQLite schema used REAL for all of these. This restores that
-- contract on Postgres. Idempotent: re-running is a no-op once converted.

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type = 'timestamp with time zone'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP DEFAULT', r.table_name, r.column_name);
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I TYPE double precision USING extract(epoch FROM %I)',
                   r.table_name, r.column_name, r.column_name);
  END LOOP;
END $$;

-- Defaults, for the columns that had now(). The server passes these explicitly
-- on every insert; the default is only a backstop.
ALTER TABLE public.users      ALTER COLUMN created_at SET DEFAULT extract(epoch FROM now());
ALTER TABLE public.links      ALTER COLUMN created_at SET DEFAULT extract(epoch FROM now());
ALTER TABLE public.alerts     ALTER COLUMN created_at SET DEFAULT extract(epoch FROM now());
ALTER TABLE public.acks       ALTER COLUMN at         SET DEFAULT extract(epoch FROM now());
ALTER TABLE public.invites    ALTER COLUMN created_at SET DEFAULT extract(epoch FROM now());
ALTER TABLE public.pairings   ALTER COLUMN created_at SET DEFAULT extract(epoch FROM now());
ALTER TABLE public.checkins   ALTER COLUMN created_at SET DEFAULT extract(epoch FROM now());
ALTER TABLE public.presence   ALTER COLUMN at         SET DEFAULT extract(epoch FROM now());
ALTER TABLE public.samaritans ALTER COLUMN at         SET DEFAULT extract(epoch FROM now());

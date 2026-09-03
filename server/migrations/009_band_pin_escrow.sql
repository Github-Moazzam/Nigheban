-- The band's six-digit PIN, held against the account so a forgotten one is
-- recoverable.
--
-- WHY THIS EXISTS
--
-- The phone stores the PIN in its keystore, and that was going to be the
-- recovery path -- until the rule that pressing Disconnect forgets it, which
-- is deliberate and right. The two together mean the local copy is gone in
-- exactly the situation somebody needs it: they unlinked the band, walked away,
-- came back, and now the wristband will not talk to them. The only remaining
-- way in was the button-through-boot factory reset, which also wipes the name
-- and forces every phone in the family to re-pair.
--
-- So the account holds a copy. Recovery needs the person to be signed in and to
-- pass the app's own four-digit gate, and it needs a network -- which is the
-- trade being made: a PIN you can get back is a PIN somebody else can get back
-- too, under the right conditions.
--
-- ------------------------------------------------------------------------
-- READ THIS BEFORE YOU RELY ON IT. IT IS PLAINTEXT, AND IT HAS TO BE.
--
-- A password is hashed because nobody ever needs to read it back -- you only
-- ever compare. This is the opposite: its entire purpose is to be handed to a
-- person who has forgotten it, so it cannot be hashed, and encrypting it at
-- rest only moves the question to where the key lives.
--
-- What that means, plainly:
--
--   * Anybody who reads this table reads every band PIN in it. A database dump,
--     a backup on someone's laptop, a `SELECT *` in a support session.
--   * Anybody who can sign in as the user can retrieve it over the API.
--   * With a PIN and physical range, an attacker pairs their own phone to a
--     wristband whose owner still believes it is locked, and nothing about the
--     band's behaviour changes to say so.
--
-- This is an ACCEPTED INTERIM POSITION, taken deliberately with the trade
-- understood: on the way to a first deployment, a wearer permanently locked out
-- of their own safety device is the likelier and worse failure. It is not the
-- end state.
--
-- What replaces it later, roughly in order of how much it buys:
--
--   1. Encrypt at rest under a key the server does not hold -- derived from the
--      user's own password or disarm PIN -- so a database dump is useless on
--      its own. This is the real fix and it is not large.
--   2. Rate-limit and log every read, and tell the wearer one happened. A
--      retrieval nobody can see is the part that makes silent access possible.
--   3. Re-key on recovery: hand back the PIN and immediately require a new one,
--      so a stolen copy has a short life.
--
-- Tracked in docs/BAND_PIN_AND_NAME.md under "What this does not do".
-- ------------------------------------------------------------------------
--
-- Idempotent: re-running is a no-op.

alter table if exists public.users
    add column if not exists band_pin text;

comment on column public.users.band_pin is
    'The wristband''s six-digit PIN, in plaintext because recovery means handing it back to a person -- see 009_band_pin_escrow.sql for the full trade and what replaces it. Never log this column, never return it from any endpoint except the one that exists to return it, and never include it in a user object.';

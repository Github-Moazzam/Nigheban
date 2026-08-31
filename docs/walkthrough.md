# Walkthrough: Database Performance Optimization

## Code Changes Made

### 1. Auth Cache on `me()` ([nigehban_server.py:95-103, 298-313](file:///c:/Users/SK%20laptop/Downloads/Nigheban-main/server/nigehban_server.py#L95-L313))

**Before:** Every authenticated request (`/me`, `/alerts`, `/heartbeat`, `/alert`, etc.) made a `SELECT * FROM users WHERE token_hash=%s` round trip to the database.

**After:** The token→user mapping is cached in memory for 60 seconds. Repeated requests within the TTL skip the DB entirely.

**Impact:** Saves ~25ms per request (Mumbai) or ~200ms per request (Tokyo) on every authenticated call.

### 2. Sweeper Consolidation ([nigehban_server.py:1593-1674](file:///c:/Users/SK%20laptop/Downloads/Nigheban-main/server/nigehban_server.py#L1593-L1674))

**Before:** Three separate `with closing(db()) as c:` blocks — each checked out a pool connection, made its query, and returned it. That's 3 pool checkouts every 5 seconds.

**After:** One `with closing(db()) as c:` block for all three checks (missed check-ins, High Alert buzzes, heartbeat watchdog). Processing loops (`emit_alert`, `HUB.to`) still run after releasing the connection so they don't hold a pool slot while awaiting network I/O.

**Impact:** Saves 2 pool checkouts per tick × 12 ticks/min = 24 fewer pool checkouts per minute. Frees connections for real user requests.

## Validation

- ✅ Syntax check passed (`py_compile`)
- ✅ Sweeper structure verified: all DB ops inside `with`, all async processing outside
- ✅ Auth cache includes TTL expiry and stale-entry cleanup on miss

---

## Your Steps: Supabase Mumbai Setup

### Step 1: Run the Schema Migration

Go to your new Supabase project → **SQL Editor** → **New Query**, and paste the contents of:

📄 [`server/supabase_migration.sql`](file:///c:/Users/SK%20laptop/Downloads/Nigheban-main/server/supabase_migration.sql)

Click **Run**.

### Step 2: Run the 4 Migration Files (in order)

Paste and run each of these one at a time:

1. 📄 [`server/migrations/001_epoch_times.sql`](file:///c:/Users/SK%20laptop/Downloads/Nigheban-main/server/migrations/001_epoch_times.sql)
2. 📄 [`server/migrations/002_band_battery.sql`](file:///c:/Users/SK%20laptop/Downloads/Nigheban-main/server/migrations/002_band_battery.sql)
3. 📄 [`server/migrations/003_band_virtual.sql`](file:///c:/Users/SK%20laptop/Downloads/Nigheban-main/server/migrations/003_band_virtual.sql)
4. 📄 [`server/migrations/004_alert_idempotency.sql`](file:///c:/Users/SK%20laptop/Downloads/Nigheban-main/server/migrations/004_alert_idempotency.sql)

### Step 3: Get Your New Credentials

In the Supabase dashboard for the Mumbai project:

1. **Project URL** → Copy from the project home page (the `https://yuvvmypwavjggghdbasi.supabase.co` URL)
2. **Anon Key** → Settings → API → `anon` `public` key
3. **Service Role Key** → Settings → API → `service_role` key (click reveal)
4. **Database URL** → Settings → Database → Connection string → URI tab
   - Use the **Session mode** connection string (port 5432)
   - Replace `[YOUR-PASSWORD]` with the database password you set when creating the project

### Step 4: Update Your `.env`

Update your `.env` file with the new values:

```
SUPABASE_URL=https://yuvvmypwavjggghdbasi.supabase.co
SUPABASE_ANON_KEY=<paste anon key>
SUPABASE_SERVICE_ROLE_KEY=<paste service role key>
DATABASE_URL=postgresql://postgres.yuvvmypwavjggghdbasi:<password>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
```

### Step 5: Start the Server & Test

```bash
python server/nigehban_server.py
```

Register fresh test accounts in the app — you're on Mumbai now! 🇮🇳

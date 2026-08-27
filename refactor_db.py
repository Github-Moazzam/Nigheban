import re
import os

with open("server/nigehban_server.py", "r") as f:
    code = f.read()

# 1. Imports
code = code.replace("import sqlite3", "import psycopg\nfrom psycopg.rows import dict_row\nfrom dotenv import load_dotenv\nload_dotenv()")

# 2. Database Connection
db_func = """def db():
    c = sqlite3.connect(DB_F, timeout=5)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")     # phone + server writing at once
    c.execute("PRAGMA foreign_keys=ON")
    return c"""

psycopg_db = """def db():
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise Exception("DATABASE_URL not set in .env")
    c = psycopg.connect(url, row_factory=dict_row)
    c.autocommit = True
    return c"""

code = code.replace(db_func, psycopg_db)

# 3. init_db (remove all the CREATE TABLEs since Supabase handles it)
init_db_func = re.search(r"def init_db\(\):.*?def ", code, flags=re.DOTALL)
if init_db_func:
    code = code.replace(init_db_func.group(0), "def init_db():\n    pass\n\n\ndef ")

# 4. Migrate queries
# Find all occurrences of c.execute("...") or c.execute('''...''')
# and replace ? with %s
def replace_params(match):
    prefix = match.group(1)
    query = match.group(2)
    suffix = match.group(3)
    
    # Replace ? with %s inside the query string
    query = query.replace("?", "%s")
    
    # Replace INSERT OR IGNORE with ON CONFLICT DO NOTHING
    query = query.replace("INSERT OR IGNORE", "INSERT")
    # This is a bit tricky, Postgres requires ON CONFLICT (columns) DO NOTHING.
    # Wait! ON CONFLICT DO NOTHING without columns is only valid if we specify the constraint?
    # Actually `ON CONFLICT DO NOTHING` works in Postgres. Let's see: `INSERT INTO table VALUES ... ON CONFLICT DO NOTHING` is valid syntax in Postgres.
    
    return prefix + query + suffix

# Regex to match strings inside c.execute()
# Using a complex regex is hard, instead let's just do a naive replace of '?' to '%s' 
# inside any double or single quotes that are arguments to execute.
# Actually, the simplest way is to write a custom wrapper around psycopg cursor!

"""
Wait, replacing `?` with `%s` across the whole file inside strings is easy:
We can find all execute calls.
"""
code = re.sub(r'(execute\s*\(\s*(?:"""|\'\'\'|".*?"|\'.*?\'))', lambda m: m.group(1).replace("?", "%s").replace("INSERT OR IGNORE", "INSERT"), code, flags=re.DOTALL)

# But wait, Postgres requires `ON CONFLICT DO NOTHING` if we want to ignore. 
# Let's fix the INSERT OR IGNORE specifically.
# In nigehban_server.py:
# c.execute("INSERT OR IGNORE INTO links VALUES (?,?,?,?)", ...)
# c.execute("INSERT OR IGNORE INTO acks VALUES (?,?,?)", ...)
# Postgres ON CONFLICT requires a target (e.g. ON CONFLICT (owner_id, member_id) DO NOTHING) unless it's just general DO NOTHING?
# Actually, Postgres requires the conflict target if it's DO UPDATE, but for DO NOTHING it's optional!
# Wait, no. "ON CONFLICT DO NOTHING" without a target is allowed in PostgreSQL!
# Let's verify that. Yes, `ON CONFLICT DO NOTHING` without index_expr is allowed.
# Let's append ` ON CONFLICT DO NOTHING` to these specific queries.

code = code.replace("INSERT INTO links VALUES (%s,%s,%s,%s)", "INSERT INTO links VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING")
code = code.replace("INSERT INTO acks VALUES (%s,%s,%s)", "INSERT INTO acks VALUES (%s,%s,%s) ON CONFLICT DO NOTHING")

# 5. lastrowid replacement
# In nigehban_server.py:
# cur = c.execute("INSERT INTO alerts (user_id,kind,created_at) VALUES (?,?,?)", (uid, kind, now))
# row = c.execute("SELECT * FROM alerts WHERE id=?", (cur.lastrowid,)).fetchone()
# Becomes:
# cur = c.execute("INSERT INTO alerts (user_id,kind,created_at) VALUES (%s,%s,%s) RETURNING id", (uid, kind, now))
# row = c.execute("SELECT * FROM alerts WHERE id=%s", (cur.fetchone()['id'],)).fetchone()

code = code.replace('VALUES (%s,%s,%s)", (uid, kind, now)', 'VALUES (%s,%s,%s) RETURNING id", (uid, kind, now)')
code = code.replace('cur.lastrowid', "cur.fetchone()['id']")

# 6. SQLite bools vs Postgres bools
# SQLite used 0/1 for booleans. But Postgres expects true/false. psycopg will map True/False to true/false automatically.
# However, if the code sets 0/1 explicitly, psycopg might send them as integers to a boolean column, which causes a cast error in Postgres.
# Let's check for `0` or `1` in boolean contexts.
# watch_state.band_link is boolean in supabase_migration.sql.
# code: c.execute("UPDATE watch_state SET band_link=? ...", (band_link,)) -> if band_link is True/False it's fine.

with open("server/nigehban_server_pg.py", "w") as f:
    f.write(code)

print("Done")

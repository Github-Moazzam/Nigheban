import re

with open("server/nigehban_server_pg.py", "r") as f:
    code = f.read()

# Make migrate(c) pass
migrate_func = re.search(r"def migrate\(c\):.*?def ", code, flags=re.DOTALL)
if migrate_func:
    code = code.replace(migrate_func.group(0), "def migrate(c):\n    pass\n\n\ndef ")

with open("server/nigehban_server_pg.py", "w") as f:
    f.write(code)

print("Done")

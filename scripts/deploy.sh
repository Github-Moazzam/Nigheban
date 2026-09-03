#!/usr/bin/env bash
# NIGEHBAN -- remote deploy, run ON THE SERVER as root.
#
# This is the canonical source of this script -- it lives in the repo so a
# change to it goes through review like anything else. But the copy that
# actually runs is a manually-placed one at /opt/nigehban/deploy.sh, owned by
# root, OUTSIDE the auto-pulled app checkout. That split is deliberate, not
# an oversight -- see docs/AWS_DEPLOYMENT.md section 16.2 ("why deploy.sh is
# not inside the checkout it deploys"). In short: this script runs with root
# privilege (systemctl, package install), and the checkout it pulls is
# whatever landed on `main`. If this file lived inside that checkout, a merge
# to main could rewrite what runs as root on the box -- silently turning
# "can merge code" into "has root on the server". Keeping it outside means a
# change here always needs a human with sudo to copy it into place.
#
# Invoked as:  sudo /opt/nigehban/deploy.sh <sha-for-the-log-line>
#
# What it does, in order:
#   1. fetch + hard-reset the app checkout to origin/main
#   2. reinstall dependencies (as the nigehban user, into its venv)
#   3. apply migrations (idempotent by construction -- see migrate_pg.py)
#   4. restart the service
#   5. poll /health; if it never comes up, roll the CODE back and restart
#
# What is NOT rolled back: a migration that already ran. migrate_pg.py's own
# files are written idempotent, so re-applying them after a code rollback is
# a no-op -- there is no automatic "undo" for a schema change, by design, the
# same way there wasn't one when this was run by hand.
set -euo pipefail

APP_DIR=/opt/nigehban/app
VENV=/opt/nigehban/venv
SVC=nigehban
SHA="${1:-origin/main}"
HEALTH_URL="http://127.0.0.1:8000/health"

as_nigehban() { sudo -u nigehban "$@"; }

cd "$APP_DIR"
PREV="$(as_nigehban git rev-parse HEAD)"
echo "==> deploying ${SHA} (current HEAD ${PREV}, kept for rollback)"

as_nigehban git fetch origin main
as_nigehban git checkout main
as_nigehban git reset --hard origin/main
as_nigehban "$VENV/bin/pip" install -q -r requirements.txt
as_nigehban "$VENV/bin/python" server/migrate_pg.py

systemctl restart "$SVC"

healthy() {
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    curl -sf -m 3 "$HEALTH_URL" > /dev/null && return 0
  done
  return 1
}

if healthy; then
  echo "==> deployed $(as_nigehban git rev-parse --short HEAD), healthy"
  exit 0
fi

echo "==> health check failed after deploy -- rolling back to ${PREV}"
as_nigehban git reset --hard "$PREV"
as_nigehban "$VENV/bin/pip" install -q -r requirements.txt
systemctl restart "$SVC"

if healthy; then
  echo "==> rolled back to ${PREV}, healthy -- the bad deploy did not reach production"
  exit 1
else
  echo "==> ROLLBACK ALSO UNHEALTHY -- the service is down. This needs a human now:"
  echo "    journalctl -u ${SVC} -n 50 --no-pager"
  exit 1
fi

#!/usr/bin/env bash
# Wipes all persisted workspace data: users, messages, board items, channels,
# sessions, and uploaded files. The server recreates a fresh (empty) database
# and a new server_id on next start. Stop the dev server first — deleting the
# db out from under a running process throws away whatever it writes next,
# since it keeps writing to the now-unlinked file until it restarts.
set -euo pipefail

DATA_DIR="${DATA_DIR:-$(cd "$(dirname "$0")/.." && pwd)/data}"

echo "This permanently deletes all users, messages, and board data in:"
echo "  $DATA_DIR"
read -rp "Type 'yes' to continue: " confirm
[ "$confirm" = "yes" ] || { echo "Aborted."; exit 1; }

rm -f "$DATA_DIR"/board.db "$DATA_DIR"/board.db-wal "$DATA_DIR"/board.db-shm
rm -rf "$DATA_DIR"/uploads
mkdir -p "$DATA_DIR"/uploads

echo "Wiped. Start (or restart) the server to recreate a fresh database."

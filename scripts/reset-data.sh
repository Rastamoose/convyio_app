#!/usr/bin/env bash
# Wipes all persisted workspace data: users, messages, board items, channels,
# and uploaded files — everything in Supabase Postgres + Storage that this
# app owns. The server recreates a fresh (empty) database and a new
# server_id on next start, exactly like before this was Supabase-backed.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "This permanently deletes all users, messages, and board data in the"
echo "Supabase project configured by this repo's .env."
read -rp "Type 'yes' to continue: " confirm
[ "$confirm" = "yes" ] || { echo "Aborted."; exit 1; }

node scripts/reset-data.mjs

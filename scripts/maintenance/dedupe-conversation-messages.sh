#!/usr/bin/env bash
# Deduplicate messages_conv_* rows sharing the same metadata.externalMessageId.
#
# Default mode is dry-run: prints the rows that would be deleted.
# Pass --apply to actually delete them (a backup of the DB is created first).
#
# Usage:
#   scripts/maintenance/dedupe-conversation-messages.sh [DB_PATH] [--apply]

set -euo pipefail

DB_PATH="${HOME}/.local/share/ergatai/user_data.db"
APPLY=0

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    *) DB_PATH="$arg" ;;
  esac
done

if [ ! -f "$DB_PATH" ]; then
  echo "DB not found: $DB_PATH" >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 is required" >&2
  exit 1
fi

TABLES=$(sqlite3 "$DB_PATH" "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'messages_conv_%';")

if [ -z "$TABLES" ]; then
  echo "No messages_conv_* tables found."
  exit 0
fi

# Build a SQL script that, for each table, deletes all but the row with the
# smallest sequence among rows sharing the same externalMessageId.
SQL=""
for t in $TABLES; do
  SQL+="DELETE FROM \"$t\" WHERE rowid IN (
    SELECT rowid FROM (
      SELECT rowid,
             ROW_NUMBER() OVER (
               PARTITION BY json_extract(metadata, '\$.externalMessageId')
               ORDER BY sequence ASC, rowid ASC
             ) AS rn
      FROM \"$t\"
      WHERE json_extract(metadata, '\$.externalMessageId') IS NOT NULL
    ) WHERE rn > 1
  );"
done

if [ "$APPLY" -eq 0 ]; then
  echo "=== DRY RUN (pass --apply to execute) ==="
  for t in $TABLES; do
    echo "--- $t ---"
    sqlite3 -header -column "$DB_PATH" "
      SELECT message_id, sequence, role, json_extract(metadata, '\$.externalMessageId') AS ext
      FROM \"$t\"
      WHERE rowid IN (
        SELECT rowid FROM (
          SELECT rowid,
                 ROW_NUMBER() OVER (
                   PARTITION BY json_extract(metadata, '\$.externalMessageId')
                   ORDER BY sequence ASC, rowid ASC
                 ) AS rn
          FROM \"$t\"
          WHERE json_extract(metadata, '\$.externalMessageId') IS NOT NULL
        ) WHERE rn > 1
      );
    "
  done
  echo "=== end dry run ==="
else
  BACKUP="${DB_PATH}.bak.$(date +%Y%m%d%H%M%S)"
  cp "$DB_PATH" "$BACKUP"
  echo "Backup created: $BACKUP"
  sqlite3 "$DB_PATH" "BEGIN; $SQL COMMIT;"
  echo "Dedup applied."
fi
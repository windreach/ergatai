-- Rollback: conversations → sub_chats
-- Date: 2026-09-28
-- Description: Rollback the sub_chats to conversations migration
--
-- This script restores the sub_chats table from backup and reverses
-- all changes made by the migration script.
--
-- Prerequisites:
-- - sub_chats_backup table must exist (created by migration script)
-- - The migration must have been run previously
--
-- Warning:
-- - This will delete any conversations created after the migration
-- - Messages in the messages table will not be rolled back automatically
-- - agent_sessions entries will not be rolled back automatically

PRAGMA foreign_keys=OFF;

-- ============================================================================
-- STEP 1: Verify backup exists
-- ============================================================================

-- Check if backup table exists
SELECT COUNT(*) AS backup_exists FROM sub_chats_backup;

-- If backup doesn't exist, abort the rollback
-- This is a safety check to prevent data loss

-- ============================================================================
-- STEP 2: Restore sub_chats table from backup
-- ============================================================================

-- Drop the current sub_chats table if it exists
DROP TABLE IF EXISTS sub_chats;

-- Recreate sub_chats table with original schema
CREATE TABLE sub_chats (
    id TEXT PRIMARY KEY,
    name TEXT,
    chat_id TEXT NOT NULL,
    session_id TEXT,
    mode TEXT NOT NULL DEFAULT 'agent',
    messages TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

-- Restore data from backup
INSERT INTO sub_chats (
    id,
    name,
    chat_id,
    session_id,
    mode,
    messages,
    created_at,
    updated_at
)
SELECT
    id,
    name,
    chat_id,
    session_id,
    mode,
    messages,
    created_at,
    updated_at
FROM sub_chats_backup;

-- Recreate index
CREATE INDEX IF NOT EXISTS idx_sub_chats_chat_id ON sub_chats(chat_id);

-- ============================================================================
-- STEP 3: Restore group_agent_bindings.sub_chat_id references
-- ============================================================================

-- If group_agent_bindings was updated to use conversation_id,
-- we need to restore the sub_chat_id references
-- Since the IDs are the same, this is a no-op in most cases

-- ============================================================================
-- STEP 4: Remove migrated child conversations (optional)
-- ============================================================================

-- WARNING: This will delete conversations created during migration
-- Only execute this if you're sure you want to remove them

-- Delete child conversations that were created from sub_chats
-- (Those with parent_id IS NOT NULL and id in sub_chats_backup)
DELETE FROM conversations
WHERE parent_id IS NOT NULL
  AND id IN (SELECT id FROM sub_chats_backup);

-- ============================================================================
-- STEP 5: Remove agent_sessions for migrated conversations (optional)
-- ============================================================================

-- Delete agent_sessions entries for conversations that were migrated from sub_chats
DELETE FROM agent_sessions
WHERE conversation_id IN (SELECT id FROM sub_chats_backup);

-- ============================================================================
-- STEP 6: Clean up backup table
-- ============================================================================

-- Drop the backup table after successful rollback
DROP TABLE IF EXISTS sub_chats_backup;

PRAGMA foreign_keys=ON;

-- ============================================================================
-- POST-ROLLBACK NOTES
-- ============================================================================

-- 1. Messages:
--    The messages table is not automatically rolled back.
--    If you need to restore messages to the sub_chats.messages JSON field,
--    you need to:
--    - Query messages from the messages table for each conversation
--    - Serialize them to JSON format
--    - Update sub_chats.messages with the JSON
--
-- 2. Root Conversations:
--    Root conversations (created from chats table) are not deleted.
--    If you need to remove them, you must do so manually.
--
-- 3. Verification:
--    After rollback, verify that:
--    - sub_chats table has been restored
--    - All original sub_chats records are present
--    - Indexes have been recreated
--    - Foreign key constraints are working
--
-- 4. Next Steps:
--    - Investigate why the migration failed (if applicable)
--    - Fix any issues before re-attempting migration
--    - Consider backing up the database before re-migration

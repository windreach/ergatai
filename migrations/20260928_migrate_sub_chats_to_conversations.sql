-- Migration: sub_chats → conversations
-- Date: 2026-09-28
-- Description: Migrate legacy sub_chats table data to the unified conversations table
--
-- Background:
-- - The application has been refactored to use a unified conversations table
-- - sub_chats (old) stores conversation threads within a chat
-- - conversations (new) uses parent_id for tree structure (root = chat, child = sub_chat)
-- - Messages are now stored in a separate messages table instead of JSON in sub_chats.messages
-- - agent_sessions table tracks runtime session info per conversation
-- - group_agent_bindings.sub_chat_id needs to be updated to reference conversations.id
--
-- Migration Strategy:
-- 1. Backup sub_chats table
-- 2. Migrate chats to root conversations (if not already present)
-- 3. Migrate sub_chats to child conversations
-- 4. Migrate messages JSON to messages table
-- 5. Create agent_sessions entries
-- 6. Update group_agent_bindings.sub_chat_id → conversation_id
-- 7. Verify migration completeness
-- 8. Drop old sub_chats table and backup

PRAGMA foreign_keys=OFF;  -- Temporarily disable for migration

-- ============================================================================
-- STEP 1: Create backup of sub_chats table
-- ============================================================================

-- Drop backup if it exists from a previous failed attempt
DROP TABLE IF EXISTS sub_chats_backup;

-- Create backup
CREATE TABLE sub_chats_backup AS SELECT * FROM sub_chats;

-- Verify backup was created
SELECT COUNT(*) AS backup_count FROM sub_chats_backup;

-- ============================================================================
-- STEP 2: Migrate chats to root conversations (if not already present)
-- ============================================================================

-- Insert chats that don't already exist as root conversations
-- This ensures that when we create child conversations, their parent exists
INSERT OR IGNORE INTO conversations (
    id,
    parent_id,
    project_id,
    workspace_id,
    name,
    mode,
    created_at,
    updated_at,
    archived_at
)
SELECT
    c.id,
    NULL AS parent_id,  -- Root conversation
    c.project_id,
    c.workspace_id,
    c.name,
    c.collaboration_mode AS mode,
    c.created_at,
    c.updated_at,
    c.archived_at
FROM chats c
WHERE NOT EXISTS (
    SELECT 1 FROM conversations conv WHERE conv.id = c.id
);

-- Create execution contexts for migrated chats
INSERT OR IGNORE INTO conversation_execution_contexts (
    conversation_id,
    worktree_path,
    branch,
    base_branch,
    pr_url,
    pr_number
)
SELECT
    c.id AS conversation_id,
    c.worktree_path,
    c.branch,
    c.base_branch,
    c.pr_url,
    c.pr_number
FROM chats c
WHERE c.worktree_path IS NOT NULL
   OR c.branch IS NOT NULL
   OR c.base_branch IS NOT NULL
   OR c.pr_url IS NOT NULL
   OR c.pr_number IS NOT NULL;

-- ============================================================================
-- STEP 3: Migrate sub_chats to child conversations
-- ============================================================================

-- Insert sub_chats as child conversations
-- parent_id = chat_id (the parent chat/conversation)
-- project_id and workspace_id are inherited from the parent conversation
INSERT OR IGNORE INTO conversations (
    id,
    parent_id,
    project_id,
    workspace_id,
    name,
    mode,
    created_at,
    updated_at,
    archived_at
)
SELECT
    sc.id,
    sc.chat_id AS parent_id,
    parent_conv.project_id,
    parent_conv.workspace_id,
    sc.name,
    sc.mode,
    sc.created_at,
    sc.updated_at,
    NULL AS archived_at  -- sub_chats don't have archived_at
FROM sub_chats sc
INNER JOIN conversations parent_conv ON parent_conv.id = sc.chat_id
WHERE parent_conv.parent_id IS NULL  -- Ensure parent is a root conversation
  AND NOT EXISTS (
    SELECT 1 FROM conversations conv WHERE conv.id = sc.id
  );

-- ============================================================================
-- STEP 4: Migrate messages from JSON to messages table
-- ============================================================================

-- This is a complex operation that requires parsing JSON
-- We'll use a temporary table to track which conversations need message migration
CREATE TEMP TABLE IF NOT EXISTS pending_message_migrations (
    conversation_id TEXT PRIMARY KEY,
    messages_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Populate with sub_chats that have non-empty messages
INSERT OR REPLACE INTO pending_message_migrations (conversation_id, messages_json, updated_at)
SELECT
    sc.id AS conversation_id,
    sc.messages AS messages_json,
    sc.updated_at
FROM sub_chats_backup sc
WHERE sc.messages != '[]'
  AND sc.messages IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM conversations conv WHERE conv.id = sc.id
  );

-- Note: Actual JSON parsing and message insertion needs to be done in application code
-- or via a more sophisticated SQL approach. For now, we'll use a simplified approach
-- that assumes the messages JSON is an array of objects with id, role, parts, metadata.
--
-- In production, this should be handled by calling messages::replace_legacy() for each
-- conversation, or by implementing a JSON parsing function in SQLite.
--
-- For the migration script, we'll create a placeholder that logs which conversations
-- need message migration:

SELECT
    conversation_id,
    LENGTH(messages_json) AS json_size,
    updated_at
FROM pending_message_migrations
ORDER BY updated_at DESC;

-- ============================================================================
-- STEP 5: Create agent_sessions entries for migrated conversations
-- ============================================================================

-- Insert agent_sessions for conversations that had session_id in sub_chats
INSERT OR IGNORE INTO agent_sessions (
    conversation_id,
    session_id,
    mode,
    created_at,
    updated_at
)
SELECT
    sc.id AS conversation_id,
    sc.session_id,
    sc.mode,
    sc.created_at,
    sc.updated_at
FROM sub_chats_backup sc
WHERE sc.session_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM conversations conv WHERE conv.id = sc.id
  );

-- ============================================================================
-- STEP 6: Update group_agent_bindings.sub_chat_id to conversation_id
-- ============================================================================

-- Check if group_agent_bindings table has sub_chat_id column
-- If it does, we need to migrate the references
-- Note: This assumes the schema still has sub_chat_id in group_agent_bindings

-- Create a new column for conversation_id if it doesn't exist
-- (This is handled by the ALTER TABLE in initialize_tables)

-- Update group_agent_bindings to use conversation_id instead of sub_chat_id
-- Since sub_chat_id and conversation_id have the same values (the sub_chat ID),
-- we can simply copy the value
UPDATE group_agent_bindings
SET sub_chat_id = (
    SELECT conv.id
    FROM conversations conv
    WHERE conv.id = group_agent_bindings.sub_chat_id
)
WHERE EXISTS (
    SELECT 1 FROM conversations conv WHERE conv.id = group_agent_bindings.sub_chat_id
);

-- ============================================================================
-- STEP 7: Verify migration completeness
-- ============================================================================

-- Count migrated conversations
SELECT
    (SELECT COUNT(*) FROM sub_chats_backup) AS original_sub_chats_count,
    (SELECT COUNT(*) FROM conversations WHERE parent_id IS NOT NULL) AS migrated_child_conversations,
    (SELECT COUNT(*) FROM agent_sessions) AS total_agent_sessions,
    (SELECT COUNT(*) FROM messages) AS total_messages;

-- Check for any sub_chats that failed to migrate
SELECT
    sc.id AS failed_sub_chat_id,
    sc.chat_id AS parent_chat_id,
    CASE
        WHEN NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = sc.chat_id) THEN 'Parent chat not found in conversations'
        WHEN NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = sc.id) THEN 'Failed to create conversation'
        ELSE 'Unknown error'
    END AS failure_reason
FROM sub_chats_backup sc
WHERE NOT EXISTS (
    SELECT 1 FROM conversations conv WHERE conv.id = sc.id
);

-- ============================================================================
-- STEP 8: Drop old sub_chats table and backup
-- ============================================================================

-- Only drop if migration was successful (no failed migrations)
-- This check should be done in application code before executing

-- Drop the index on sub_chats
DROP INDEX IF EXISTS idx_sub_chats_chat_id;

-- Drop the original sub_chats table
DROP TABLE IF EXISTS sub_chats;

-- Keep the backup for now (can be dropped manually after verification)
-- DROP TABLE IF EXISTS sub_chats_backup;

-- Drop temporary table
DROP TABLE IF EXISTS pending_message_migrations;

PRAGMA foreign_keys=ON;

-- ============================================================================
-- POST-MIGRATION NOTES
-- ============================================================================

-- 1. Messages Migration:
--    The messages JSON field needs to be migrated to the messages table.
--    This should be done by calling messages::replace_legacy() for each conversation
--    that has messages in the pending_message_migrations table.
--
-- 2. Verification:
--    After migration, verify that:
--    - All sub_chats have corresponding conversations
--    - All messages have been migrated
--    - All agent_sessions are present
--    - group_agent_bindings references are updated
--
-- 3. Rollback:
--    If migration fails, use the rollback script to restore from backup.
--
-- 4. Cleanup:
--    After successful verification, drop the sub_chats_backup table:
--    DROP TABLE IF EXISTS sub_chats_backup;

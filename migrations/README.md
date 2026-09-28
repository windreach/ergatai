# Database Migration: sub_chats → conversations

## Overview

This migration consolidates the legacy `sub_chats` table into the unified `conversations` table structure. The application has been refactored to use a tree-structured conversation model where:

- **Root conversations** (parent_id = NULL) represent chats
- **Child conversations** (parent_id = chat_id) represent sub-chats
- **Messages** are stored in a separate `messages` table instead of JSON

## Migration Files

- `20260928_migrate_sub_chats_to_conversations.sql` - Forward migration
- `20260928_rollback.sql` - Rollback script

## Table Structures

### Before (sub_chats)

```sql
CREATE TABLE sub_chats (
    id TEXT PRIMARY KEY,
    name TEXT,
    chat_id TEXT NOT NULL,           -- FK to chats
    session_id TEXT,
    mode TEXT NOT NULL DEFAULT 'agent',
    messages TEXT NOT NULL DEFAULT '[]',  -- JSON array
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);
```

### After (conversations)

```sql
CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    parent_id TEXT,                  -- FK to conversations (NULL = root)
    project_id TEXT NOT NULL,        -- FK to projects
    workspace_id TEXT,               -- FK to workspaces
    name TEXT,
    mode TEXT NOT NULL DEFAULT 'agent',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER,
    FOREIGN KEY (parent_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
);
```

## Migration Logic

### Step 1: Backup
Creates a complete backup of the `sub_chats` table as `sub_chats_backup`.

### Step 2: Migrate Chats to Root Conversations
Ensures all chats exist as root conversations (parent_id = NULL) before migrating sub_chats.

**Field Mapping:**
- `chats.id` → `conversations.id`
- `chats.project_id` → `conversations.project_id`
- `chats.workspace_id` → `conversations.workspace_id`
- `chats.name` → `conversations.name`
- `chats.collaboration_mode` → `conversations.mode`
- `chats.archived_at` → `conversations.archived_at`

### Step 3: Migrate Sub_chats to Child Conversations
Converts each sub_chat into a child conversation.

**Field Mapping:**
- `sub_chats.id` → `conversations.id`
- `sub_chats.chat_id` → `conversations.parent_id`
- Inherited from parent: `project_id`, `workspace_id`
- `sub_chats.name` → `conversations.name`
- `sub_chats.mode` → `conversations.mode`
- `sub_chats.created_at` → `conversations.created_at`
- `sub_chats.updated_at` → `conversations.updated_at`
- `NULL` → `conversations.archived_at` (sub_chats don't have this field)

### Step 4: Migrate Messages
The `messages` JSON field needs to be migrated to the `messages` table.

**Important:** This step requires application-level code to parse JSON and insert records. The migration script identifies which conversations need message migration but doesn't perform the actual JSON parsing.

**Recommended approach:**
```rust
for conversation_id in pending_message_migrations {
    let messages_json = get_messages_json(conversation_id);
    messages::replace_legacy(conversation_id, messages_json, updated_at)?;
}
```

### Step 5: Create Agent Sessions
Migrates session information to the `agent_sessions` table.

**Field Mapping:**
- `sub_chats.id` → `agent_sessions.conversation_id`
- `sub_chats.session_id` → `agent_sessions.session_id`
- `sub_chats.mode` → `agent_sessions.mode`
- `sub_chats.created_at` → `agent_sessions.created_at`
- `sub_chats.updated_at` → `agent_sessions.updated_at`

### Step 6: Update Foreign Key References
Updates `group_agent_bindings.sub_chat_id` to reference the new conversation IDs.

**Note:** Since sub_chat IDs and conversation IDs are the same, this is primarily a validation step.

### Step 7: Verification
Checks that all sub_chats have been successfully migrated.

### Step 8: Cleanup
Drops the old `sub_chats` table and its indexes. The backup is kept for safety.

## Verification Checkpoints

Run these queries after migration to verify success:

### 1. Count Verification
```sql
SELECT
    (SELECT COUNT(*) FROM sub_chats_backup) AS original_count,
    (SELECT COUNT(*) FROM conversations WHERE parent_id IS NOT NULL) AS migrated_count;
```

**Expected:** Both counts should be equal.

### 2. Parent-Child Relationship Verification
```sql
SELECT
    conv.id,
    conv.parent_id,
    parent.project_id AS parent_project_id,
    conv.project_id AS child_project_id
FROM conversations conv
LEFT JOIN conversations parent ON parent.id = conv.parent_id
WHERE conv.parent_id IS NOT NULL
  AND conv.project_id != parent.project_id;
```

**Expected:** Zero rows (all children should have same project_id as parent).

### 3. Message Migration Verification
```sql
SELECT
    conv.id,
    COUNT(msg.id) AS message_count
FROM conversations conv
LEFT JOIN messages msg ON msg.conversation_id = conv.id
WHERE conv.parent_id IS NOT NULL
GROUP BY conv.id
HAVING message_count = 0;
```

**Expected:** Only conversations that had empty messages in sub_chats.

### 4. Agent Sessions Verification
```sql
SELECT
    conv.id AS conversation_id,
    sess.conversation_id AS session_id
FROM conversations conv
LEFT JOIN agent_sessions sess ON sess.conversation_id = conv.id
WHERE conv.parent_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM sub_chats_backup sc
    WHERE sc.id = conv.id AND sc.session_id IS NOT NULL
  )
  AND sess.conversation_id IS NULL;
```

**Expected:** Zero rows (all conversations with session_id should have agent_sessions entry).

### 5. Failed Migrations Check
```sql
SELECT
    sc.id,
    sc.chat_id,
    CASE
        WHEN NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = sc.chat_id)
            THEN 'Parent chat not found'
        WHEN NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = sc.id)
            THEN 'Conversation not created'
        ELSE 'Unknown'
    END AS failure_reason
FROM sub_chats_backup sc
WHERE NOT EXISTS (SELECT 1 FROM conversations conv WHERE conv.id = sc.id);
```

**Expected:** Zero rows.

## Rollback Procedure

If migration fails or needs to be reverted:

1. **Stop the application** to prevent data corruption
2. **Run the rollback script:**
   ```bash
   sqlite3 user_data.db < migrations/20260928_rollback.sql
   ```
3. **Verify restoration:**
   ```sql
   SELECT COUNT(*) FROM sub_chats;
   SELECT COUNT(*) FROM sub_chats_backup;  -- Should not exist
   ```
4. **Restore messages** (if needed):
   - Query messages from `messages` table
   - Serialize to JSON
   - Update `sub_chats.messages`

## Important Considerations

### 1. Foreign Key Constraints
The migration temporarily disables foreign keys (`PRAGMA foreign_keys=OFF`) to allow the migration to proceed even if there are temporary inconsistencies. Foreign keys are re-enabled at the end.

### 2. Transaction Safety
The migration script should be run within a transaction for atomicity. If any step fails, the entire migration should be rolled back.

**Recommended execution:**
```bash
sqlite3 user_data.db <<EOF
BEGIN TRANSACTION;
.read migrations/20260928_migrate_sub_chats_to_conversations.sql
COMMIT;
EOF
```

### 3. Messages Migration
The JSON → messages table migration is the most complex part. Consider:
- Using application code (Rust) for JSON parsing
- Implementing a custom SQLite JSON parsing function
- Breaking large migrations into batches

### 4. Performance
For large databases:
- Consider running migration during maintenance window
- Monitor disk space (backup doubles the data size temporarily)
- Consider batching message migrations

### 5. ID Conflicts
The migration uses `INSERT OR IGNORE` to handle potential ID conflicts. If a conversation with the same ID already exists, the sub_chat migration is skipped for that record.

**Check for skipped records:**
```sql
SELECT COUNT(*) AS skipped_count
FROM sub_chats_backup sc
WHERE EXISTS (
    SELECT 1 FROM conversations conv
    WHERE conv.id = sc.id AND conv.parent_id IS NULL
);
```

## Testing the Migration

### Test Environment Setup
1. Create a copy of the production database
2. Run the migration on the copy
3. Verify all checkpoints pass
4. Test application functionality

### Test Cases
- [ ] Empty sub_chats table (no data to migrate)
- [ ] Sub_chats with empty messages
- [ ] Sub_chats with large message payloads
- [ ] Sub_chats with NULL session_id
- [ ] Sub_chats referencing non-existent chats
- [ ] Concurrent access during migration
- [ ] Rollback after partial migration

## Post-Migration Tasks

1. **Update application code** to remove references to `legacy_sub_chats` module
2. **Remove backup table** after verification:
   ```sql
   DROP TABLE IF EXISTS sub_chats_backup;
   ```
3. **Update documentation** to reflect new schema
4. **Monitor logs** for any errors related to conversation access
5. **Performance testing** with production data volume

## Troubleshooting

### Issue: Migration fails with foreign key constraint violation
**Solution:** Ensure all chats exist as conversations before migrating sub_chats. Check Step 2 of the migration.

### Issue: Messages not appearing after migration
**Solution:** The messages JSON migration requires application code. Ensure `messages::replace_legacy()` is called for each conversation.

### Issue: Rollback fails
**Solution:** Ensure `sub_chats_backup` table exists. If it was deleted, you'll need to restore from a database backup.

### Issue: Duplicate conversation IDs
**Solution:** The migration uses `INSERT OR IGNORE` to skip duplicates. Review the verification queries to identify which records were skipped and investigate manually.

## Support

For issues or questions:
1. Check the verification checkpoints
2. Review application logs for errors
3. Consult the rollback procedure if needed
4. Contact the development team with detailed error information

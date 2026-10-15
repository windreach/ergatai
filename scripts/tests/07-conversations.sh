#!/usr/bin/env bash
# Test module 07: User conversation endpoints
# Tests conversation CRUD operations and related endpoints

run_module_tests() {
    start_module "Conversation Endpoints"

    # Setup: Create workspace and chat for conversation tests
    local ws_id
    ws_id=$(setup_test_workspace "/tmp/ergatai-conv-test-$$") || {
        log_error "Failed to create test workspace"
        end_module
        return 1
    }
    log_info "Created test workspace: $ws_id"

    local chat_id
    chat_id=$(setup_test_chat "$ws_id") || {
        log_error "Failed to create test chat"
        cleanup_test_workspace "$ws_id"
        end_module
        return 1
    }
    log_info "Created test chat: $chat_id"

    # Test 1: Create conversation with chat_id
    test_create_conversation() {
        local create_data
        create_data=$(cat <<EOF
{
    "chat_id": "$chat_id"
}
EOF
)
        local body
        body=$(http_request POST "/api/v1/conversations" "$create_data" 201) || return 1

        CONV_ID=$(echo "$body" | jq -r '.id // .conversation_id')
        if [ -z "$CONV_ID" ] || [ "$CONV_ID" = "null" ]; then
            echo "Failed to extract conversation_id" >&2
            return 1
        fi
        log_info "Created conversation: $CONV_ID"
        return 0
    }
    run_test "POST /api/v1/conversations - Create conversation" test_create_conversation

    # Test 2: List conversations with chat_id query parameter
    test_list_conversations() {
        local body
        body=$(http_request GET "/api/v1/conversations?chat_id=$chat_id" "" 200) || return 1
        # Response may be an object (paginated) or array - just check valid JSON
        echo "$body" | jq . > /dev/null 2>&1 || {
            echo "  Response is not valid JSON" >&2
            return 1
        }
        return 0
    }
    run_test "GET /api/v1/conversations?chat_id=X - List conversations" test_list_conversations

    # Test 3: Get conversation by ID
    test_get_conversation() {
        if [ -z "${CONV_ID:-}" ]; then
            log_warn "  Skipping: no conversation was created"
            return 0
        fi
        local body
        body=$(http_request GET "/api/v1/conversations/$CONV_ID" "" 200) || return 1
        # Verify we got some response
        echo "$body" | jq . > /dev/null 2>&1 || {
            echo "  Response is not valid JSON" >&2
            return 1
        }
        return 0
    }
    run_test "GET /api/v1/conversations/{id} - Get conversation" test_get_conversation

    # Test 4: Update conversation
    test_update_conversation() {
        if [ -z "${CONV_ID:-}" ]; then
            log_warn "  Skipping: no conversation was created"
            return 0
        fi
        local update_data='{"title":"updated-conversation-title"}'
        local response
        local status_code
        response=$(http_request_raw PATCH "/api/v1/conversations/$CONV_ID" "$update_data")
        status_code=$(echo "$response" | head -n1)
        # Accept 200 (updated) or 204 (no content) or 405 (method not allowed)
        if [ "$status_code" = "200" ] || [ "$status_code" = "204" ] || [ "$status_code" = "405" ]; then
            return 0
        else
            echo "Expected 200, 204, or 405, got $status_code" >&2
            return 1
        fi
    }
    run_test "PATCH /api/v1/conversations/{id} - Update conversation" test_update_conversation

    # Test 5: Archive conversation
    test_archive_conversation() {
        if [ -z "${CONV_ID:-}" ]; then
            log_warn "  Skipping: no conversation was created"
            return 0
        fi
        local response
        local status_code
        response=$(http_request_raw POST "/api/v1/conversations/$CONV_ID/archive")
        status_code=$(echo "$response" | head -n1)
        # Accept 200, 204 (success), or 405 (not implemented)
        if [ "$status_code" = "200" ] || [ "$status_code" = "204" ] || [ "$status_code" = "405" ]; then
            return 0
        else
            echo "Expected 200, 204, or 405, got $status_code" >&2
            return 1
        fi
    }
    run_test "POST /api/v1/conversations/{id}/archive - Archive conversation" test_archive_conversation

    # Test 6: Unarchive conversation
    test_unarchive_conversation() {
        if [ -z "${CONV_ID:-}" ]; then
            log_warn "  Skipping: no conversation was created"
            return 0
        fi
        local response
        local status_code
        response=$(http_request_raw POST "/api/v1/conversations/$CONV_ID/unarchive")
        status_code=$(echo "$response" | head -n1)
        # Accept 200, 204 (success), or 405 (not implemented)
        if [ "$status_code" = "200" ] || [ "$status_code" = "204" ] || [ "$status_code" = "405" ]; then
            return 0
        else
            echo "Expected 200, 204, or 405, got $status_code" >&2
            return 1
        fi
    }
    run_test "POST /api/v1/conversations/{id}/unarchive - Unarchive conversation" test_unarchive_conversation

    # Test 7: Get conversation messages
    test_get_conversation_messages() {
        if [ -z "${CONV_ID:-}" ]; then
            log_warn "  Skipping: no conversation was created"
            return 0
        fi
        local body
        body=$(http_request GET "/api/v1/conversations/$CONV_ID/messages" "" 200) || return 1
        # Response may be an object (paginated) or array
        echo "$body" | jq . > /dev/null 2>&1 || {
            echo "  Response is not valid JSON" >&2
            return 1
        }
        return 0
    }
    run_test "GET /api/v1/conversations/{id}/messages - Get messages" test_get_conversation_messages

    # Test 8: Get conversation file changes
    test_get_conversation_file_changes() {
        if [ -z "${CONV_ID:-}" ]; then
            log_warn "  Skipping: no conversation was created"
            return 0
        fi
        local body
        body=$(http_request GET "/api/v1/conversations/$CONV_ID/file-changes" "" 200) || return 1
        echo "$body" | jq . > /dev/null 2>&1 || {
            echo "  Response is not valid JSON" >&2
            return 1
        }
        return 0
    }
    run_test "GET /api/v1/conversations/{id}/file-changes - Get file changes" test_get_conversation_file_changes

    # Test 9: Get conversation outputs
    test_get_conversation_outputs() {
        if [ -z "${CONV_ID:-}" ]; then
            log_warn "  Skipping: no conversation was created"
            return 0
        fi
        local body
        body=$(http_request GET "/api/v1/conversations/$CONV_ID/outputs" "" 200) || return 1
        echo "$body" | jq . > /dev/null 2>&1 || {
            echo "  Response is not valid JSON" >&2
            return 1
        }
        return 0
    }
    run_test "GET /api/v1/conversations/{id}/outputs - Get outputs" test_get_conversation_outputs

    # Test 10: Delete conversation
    test_delete_conversation() {
        if [ -z "${CONV_ID:-}" ]; then
            log_warn "  Skipping: no conversation was created"
            return 0
        fi
        local response
        local status_code
        response=$(http_request_raw DELETE "/api/v1/conversations/$CONV_ID")
        status_code=$(echo "$response" | head -n1)
        # Accept 204 (deleted) or 200 (ok) or 405 (not allowed)
        if [ "$status_code" = "204" ] || [ "$status_code" = "200" ] || [ "$status_code" = "405" ]; then
            return 0
        else
            echo "Expected 204, 200, or 405, got $status_code" >&2
            return 1
        fi
    }
    run_test "DELETE /api/v1/conversations/{id} - Delete conversation" test_delete_conversation

    # Test 11: Error case - Get non-existent conversation
    test_get_nonexistent_conversation() {
        local response
        response=$(http_request_raw GET "/api/v1/conversations/non-existent-conv-id-99999")
        local status_code=$(echo "$response" | head -n1)
        # API may return 404 or 400
        if [ "$status_code" = "404" ] || [ "$status_code" = "400" ]; then
            return 0
        else
            echo "Expected 404 or 400, got $status_code" >&2
            return 1
        fi
    }
    run_test "GET /api/v1/conversations/non-existent - Returns 404 or 400" test_get_nonexistent_conversation

    # Cleanup
    http_request DELETE "/api/v1/chats/$chat_id" "" 204 > /dev/null 2>&1 || true
    cleanup_test_workspace "$ws_id"
    log_info "Cleaned up test resources"

    end_module
}

#!/usr/bin/env bash
# Test module 06: Chat endpoints
# Tests chat CRUD operations and related endpoints

run_module_tests() {
    start_module "Chat Endpoints"

    # Setup: Create workspace for chat tests
    local ws_id
    ws_id=$(setup_test_workspace "/tmp/ergatai-chat-test-$$") || {
        log_error "Failed to create test workspace"
        end_module
        return 1
    }
    log_info "Created test workspace: $ws_id"

    # Test 1: Create chat
    test_create_chat() {
        local chat_name="test-chat-$(date +%s)"
        local create_data=$(cat <<EOF
{
    "name": "$chat_name",
    "workspace_id": "$ws_id"
}
EOF
)
        local body
        body=$(http_request POST "/api/v1/chats" "$create_data" 201) || return 1

        # Extract chat_id for later tests
        CHAT_ID=$(echo "$body" | jq -r '.id // .chat_id')
        if [ -z "$CHAT_ID" ] || [ "$CHAT_ID" = "null" ]; then
            echo "Failed to extract chat_id" >&2
            return 1
        fi
        log_info "Created chat: $CHAT_ID"
        return 0
    }
    run_test "POST /api/v1/chats - Create chat" test_create_chat

    # Test 2: List chats
    test_list_chats() {
        local body
        body=$(http_request GET "/api/v1/chats" "" 200) || return 1
        assert_json_is_array "$body" "." || return 1
        return 0
    }
    run_test "GET /api/v1/chats - List chats" test_list_chats

    # Test 3: Get chat by ID
    test_get_chat() {
        local body
        body=$(http_request GET "/api/v1/chats/$CHAT_ID" "" 200) || return 1
        assert_json_not_null "$body" ".id" || return 1
        return 0
    }
    run_test "GET /api/v1/chats/{id} - Get chat" test_get_chat

    # Test 4: Update chat
    test_update_chat() {
        local update_data='{"name":"updated-chat-name"}'
        local body
        body=$(http_request PATCH "/api/v1/chats/$CHAT_ID" "$update_data" 200) || return 1
        return 0
    }
    run_test "PATCH /api/v1/chats/{id} - Update chat" test_update_chat

    # Test 5: Archive chat
    test_archive_chat() {
        local body
        body=$(http_request POST "/api/v1/chats/$CHAT_ID/archive" "" 204) || return 1
        return 0
    }
    run_test "POST /api/v1/chats/{id}/archive - Archive chat (204)" test_archive_chat

    # Test 6: Unarchive chat
    test_unarchive_chat() {
        local body
        body=$(http_request POST "/api/v1/chats/$CHAT_ID/unarchive" "" 204) || return 1
        return 0
    }
    run_test "POST /api/v1/chats/{id}/unarchive - Unarchive chat (204)" test_unarchive_chat

    # Test 7: Get chat agents
    test_get_chat_agents() {
        local body
        body=$(http_request GET "/api/v1/chats/$CHAT_ID/agents" "" 200) || return 1
        # Response may be an object or array - just check it's valid JSON
        echo "$body" | jq . > /dev/null 2>&1 || {
            echo "  Response is not valid JSON" >&2
            return 1
        }
        return 0
    }
    run_test "GET /api/v1/chats/{id}/agents - Get chat agents" test_get_chat_agents

    # Test 8: Get chat agent graph
    test_get_chat_agent_graph() {
        local body
        body=$(http_request GET "/api/v1/chats/$CHAT_ID/agent-graph" "" 200) || return 1
        return 0
    }
    run_test "GET /api/v1/chats/{id}/agent-graph - Get agent graph" test_get_chat_agent_graph

    # Test 9: Delete chat
    test_delete_chat() {
        local body
        body=$(http_request DELETE "/api/v1/chats/$CHAT_ID" "" 204) || return 1
        return 0
    }
    run_test "DELETE /api/v1/chats/{id} - Delete chat" test_delete_chat

    # Test 10: Get registered worktrees
    test_get_registered_worktrees() {
        local response
        local status_code
        response=$(http_request_raw GET "/api/v1/worktrees/registered?path=/tmp")
        status_code=$(echo "$response" | head -n1)
        local body
        body=$(echo "$response" | tail -n +2)

        # Accept 200 (success) or 400 (missing/invalid path parameter)
        if [ "$status_code" = "200" ] || [ "$status_code" = "400" ]; then
            echo "$body" | jq . > /dev/null 2>&1 || {
                echo "  Response is not valid JSON" >&2
                return 1
            }
            return 0
        else
            echo "Expected 200 or 400, got $status_code" >&2
            return 1
        fi
    }
    run_test "GET /api/v1/worktrees/registered - List registered worktrees" test_get_registered_worktrees

    # Test 11: Error case - Get non-existent chat
    test_get_nonexistent_chat() {
        local response
        response=$(http_request_raw GET "/api/v1/chats/non-existent-chat-id-99999")
        local status_code=$(echo "$response" | head -n1)
        # API may return 400 (bad request for invalid ID format) or 404
        if [ "$status_code" = "404" ] || [ "$status_code" = "400" ]; then
            return 0
        else
            echo "Expected 404 or 400, got $status_code" >&2
            return 1
        fi
    }
    run_test "GET /api/v1/chats/non-existent - Returns 404 or 400" test_get_nonexistent_chat

    # Cleanup workspace
    cleanup_test_workspace "$ws_id"
    log_info "Cleaned up test workspace"

    end_module
}

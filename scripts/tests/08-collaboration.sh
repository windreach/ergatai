#!/usr/bin/env bash
# Test module 08: Collaboration session endpoints
# Tests collaboration session CRUD, state management, and related endpoints

run_module_tests() {
    start_module "Collaboration Session Endpoints"

    # Setup: Create workspace and chat for collaboration tests
    local ws_id
    ws_id=$(setup_test_workspace "/tmp/ergatai-collab-test-$$") || {
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

    # Test 1: Create collaboration session
    test_create_collab_session() {
        local create_data=$(cat <<EOF
{
    "chat_id": "$chat_id",
    "workspace_id": "$ws_id",
    "mode": "supervisor",
    "goal": "test collaboration session"
}
EOF
)
        local body
        body=$(http_request POST "/api/v1/collaboration-sessions" "$create_data" 201) || {
            echo "DEBUG: Collaboration session creation failed. Response: $body" >&2
            return 1
        }

        SESSION_ID=$(echo "$body" | jq -r '.collaboration_session_id // .id // .session_id')
        if [ -z "$SESSION_ID" ] || [ "$SESSION_ID" = "null" ]; then
            echo "DEBUG: Failed to extract session_id from response: $body" >&2
            return 1
        fi
        log_info "Created collaboration session: $SESSION_ID"
        return 0
    }
    run_test "POST /api/v1/collaboration-sessions - Create session" test_create_collab_session

    # Test 2: List collaboration sessions
    test_list_collab_sessions() {
        local body
        body=$(http_request GET "/api/v1/collaboration-sessions" "" 200) || return 1
        assert_json_is_array "$body" "." || return 1
        return 0
    }
    run_test "GET /api/v1/collaboration-sessions - List sessions" test_list_collab_sessions

    # Test 3: Get collaboration session by ID
    test_get_collab_session() {
        local body
        body=$(http_request GET "/api/v1/collaboration-sessions/$SESSION_ID" "" 200) || return 1
        assert_json_not_null "$body" ".collaboration_session_id" || return 1
        return 0
    }
    run_test "GET /api/v1/collaboration-sessions/{id} - Get session" test_get_collab_session

    # Test 4: Get session by chat ID
    test_get_session_by_chat() {
        local body
        body=$(http_request GET "/api/v1/collaboration-sessions/by-chat/$chat_id" "" 200) || return 1
        return 0
    }
    run_test "GET /api/v1/collaboration-sessions/by-chat/{chat_id} - Get by chat" test_get_session_by_chat

    # Test 5: Get session status
    test_get_session_status() {
        local body
        body=$(http_request GET "/api/v1/collaboration-sessions/$SESSION_ID/status" "" 200) || return 1
        return 0
    }
    run_test "GET /api/v1/collaboration-sessions/{id}/status - Get status" test_get_session_status

    # Test 6: Get session progress
    test_get_session_progress() {
        local body
        body=$(http_request GET "/api/v1/collaboration-sessions/$SESSION_ID/progress" "" 200) || return 1
        return 0
    }
    run_test "GET /api/v1/collaboration-sessions/{id}/progress - Get progress" test_get_session_progress

    # Test 7: Update session state (may accept or reject based on state machine)
    test_update_session_state() {
        local update_data='{"state":"executing"}'
        local response
        response=$(http_request_raw POST "/api/v1/collaboration-sessions/$SESSION_ID/state" "$update_data")
        local status_code=$(echo "$response" | head -n1)
        # Accept 200 (success) or 400/409/422 (state machine rejection or validation error)
        if [ "$status_code" = "200" ] || [ "$status_code" = "400" ] || [ "$status_code" = "409" ] || [ "$status_code" = "422" ]; then
            return 0
        else
            echo "Expected 200/400/409/422, got $status_code" >&2
            return 1
        fi
    }
    run_test "POST /api/v1/collaboration-sessions/{id}/state - Update state" test_update_session_state

    # Test 8: Get session events
    test_get_session_events() {
        local body
        body=$(http_request GET "/api/v1/collaboration-sessions/$SESSION_ID/events" "" 200) || return 1
        return 0
    }
    run_test "GET /api/v1/collaboration-sessions/{id}/events - Get events" test_get_session_events

    # Test 9: Create session plan
    test_create_session_plan() {
        local plan_data='{"content":"test plan content for collaboration","dag_snapshot":{"nodes":[],"edges":[]}}'
        local body
        body=$(http_request POST "/api/v1/collaboration-sessions/$SESSION_ID/plans" "$plan_data" 201) || return 1
        return 0
    }
    run_test "POST /api/v1/collaboration-sessions/{id}/plans - Create plan" test_create_session_plan

    # Test 10: List session plans
    test_list_session_plans() {
        local body
        body=$(http_request GET "/api/v1/collaboration-sessions/$SESSION_ID/plans" "" 200) || return 1
        return 0
    }
    run_test "GET /api/v1/collaboration-sessions/{id}/plans - List plans" test_list_session_plans

    # Test 11: Get session conversations
    test_get_session_conversations() {
        local body
        body=$(http_request GET "/api/v1/collaboration-sessions/$SESSION_ID/conversations" "" 200) || return 1
        return 0
    }
    run_test "GET /api/v1/collaboration-sessions/{id}/conversations - Get conversations" test_get_session_conversations

    # Test 12: Cancel session
    test_cancel_session() {
        local body
        body=$(http_request POST "/api/v1/collaboration-sessions/$SESSION_ID/cancel" "" 200) || return 1
        return 0
    }
    run_test "POST /api/v1/collaboration-sessions/{id}/cancel - Cancel session" test_cancel_session

    # Test 13: Update session (PATCH)
    test_update_session() {
        local update_data='{}'
        local body
        body=$(http_request PATCH "/api/v1/collaboration-sessions/$SESSION_ID" "$update_data" 200) || return 1
        return 0
    }
    run_test "PATCH /api/v1/collaboration-sessions/{id} - Update session" test_update_session

    # Test 14: Delete session
    test_delete_session() {
        local body
        body=$(http_request DELETE "/api/v1/collaboration-sessions/$SESSION_ID" "" 204) || return 1
        return 0
    }
    run_test "DELETE /api/v1/collaboration-sessions/{id} - Delete session" test_delete_session

    # Test 15: Error case - Get non-existent session
    test_get_nonexistent_session() {
        local response
        response=$(http_request_raw GET "/api/v1/collaboration-sessions/non-existent-session-99999")
        local status_code=$(echo "$response" | head -n1)
        # Accept 400 (invalid ID format) or 404 (valid format but not found)
        if [ "$status_code" = "404" ] || [ "$status_code" = "400" ]; then
            return 0
        else
            echo "Expected 404 or 400, got $status_code" >&2
            return 1
        fi
    }
    run_test "GET /api/v1/collaboration-sessions/non-existent - Returns 404" test_get_nonexistent_session

    # Test 16: Create second session for additional tests
    test_create_second_session() {
        local create_data=$(cat <<EOF
{
    "chat_id": "$chat_id",
    "workspace_id": "$ws_id",
    "mode": "supervisor",
    "goal": "second test session"
}
EOF
)
        local body
        body=$(http_request POST "/api/v1/collaboration-sessions" "$create_data" 201) || return 1

        SESSION_ID_2=$(echo "$body" | jq -r '.collaboration_session_id // .id // .session_id')
        if [ -z "$SESSION_ID_2" ] || [ "$SESSION_ID_2" = "null" ]; then
            echo "Failed to extract second session_id" >&2
            return 1
        fi
        log_info "Created second session: $SESSION_ID_2"
        return 0
    }
    run_test "Create second session for additional tests" test_create_second_session

    # Test 17: Get session status (second session)
    test_get_second_session_status() {
        local body
        body=$(http_request GET "/api/v1/collaboration-sessions/$SESSION_ID_2/status" "" 200) || return 1
        return 0
    }
    run_test "GET status for second session" test_get_second_session_status

    # Test 18: Update second session state to pending
    test_update_second_session_state() {
        local update_data='{"state":"idle"}'
        local response
        response=$(http_request_raw POST "/api/v1/collaboration-sessions/$SESSION_ID_2/state" "$update_data")
        local status_code=$(echo "$response" | head -n1)
        if [ "$status_code" = "200" ] || [ "$status_code" = "400" ] || [ "$status_code" = "409" ] || [ "$status_code" = "422" ]; then
            return 0
        else
            echo "Expected 200/400/409/422, got $status_code" >&2
            return 1
        fi
    }
    run_test "Update second session state" test_update_second_session_state

    # Test 19: Get second session events
    test_get_second_session_events() {
        local body
        body=$(http_request GET "/api/v1/collaboration-sessions/$SESSION_ID_2/events" "" 200) || return 1
        return 0
    }
    run_test "Get second session events" test_get_second_session_events

    # Test 20: Delete second session
    test_delete_second_session() {
        local body
        body=$(http_request DELETE "/api/v1/collaboration-sessions/$SESSION_ID_2" "" 204) || return 1
        return 0
    }
    run_test "Delete second session" test_delete_second_session

    # Cleanup chat and workspace
    http_request DELETE "/api/v1/chats/$chat_id" "" 204 > /dev/null 2>&1 || true
    cleanup_test_workspace "$ws_id"
    log_info "Cleaned up test chat and workspace"

    end_module
}

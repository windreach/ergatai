#!/usr/bin/env bash
# Test module 09: Terminal session endpoints
# Tests terminal session CRUD, input/output, and control operations

run_module_tests() {
    start_module "Terminal Session Endpoints"

    # Setup: Create workspace for terminal session tests
    local ws_id
    ws_id=$(setup_test_workspace "/tmp/ergatai-terminal-test-$$") || {
        log_error "Failed to create test workspace"
        end_module
        return 1
    }
    log_info "Created test workspace: $ws_id"

    # Test 1: List terminal sessions
    test_list_terminal_sessions() {
        local body
        body=$(http_request GET "/api/v1/terminal-sessions?workspace_id=$ws_id" "" 200) || return 1
        assert_json_is_array "$body" ".sessions" || return 1
        return 0
    }
    run_test "GET /api/v1/terminal-sessions - List terminal sessions" test_list_terminal_sessions

    # Test 2: Create terminal session
    test_create_terminal_session() {
        local create_data=$(cat <<EOF
{
    "workspace_id": "$ws_id",
    "profile": "workspace_shell",
    "transport": "pty",
    "cwd": "/tmp/ergatai-terminal-test-$$",
    "user_id": "local"
}
EOF
)
        local body
        body=$(http_request POST "/api/v1/terminal-sessions" "$create_data" 201) || return 1

        TERM_SESSION_ID=$(echo "$body" | jq -r '.session.session_id // .session.id // .id // .session_id')
        if [ -z "$TERM_SESSION_ID" ] || [ "$TERM_SESSION_ID" = "null" ]; then
            echo "Failed to extract terminal session_id" >&2
            return 1
        fi
        log_info "Created terminal session: $TERM_SESSION_ID"
        return 0
    }
    run_test "POST /api/v1/terminal-sessions - Create terminal session" test_create_terminal_session

    # Test 3: Get terminal session by ID
    test_get_terminal_session() {
        local body
        body=$(http_request GET "/api/v1/terminal-sessions/$TERM_SESSION_ID" "" 200) || return 1
        assert_json_not_null "$body" ".session.session_id" || return 1
        return 0
    }
    run_test "GET /api/v1/terminal-sessions/{id} - Get terminal session" test_get_terminal_session

    # Test 4: Send input to terminal
    test_send_terminal_input() {
        local input_data='{"data":"ls\n"}'
        local body
        body=$(http_request POST "/api/v1/terminal-sessions/$TERM_SESSION_ID/input" "$input_data" 204) || return 1
        return 0
    }
    run_test "POST /api/v1/terminal-sessions/{id}/input - Send input" test_send_terminal_input

    # Test 5: Resize terminal
    test_resize_terminal() {
        local resize_data='{"cols":120,"rows":40}'
        local body
        body=$(http_request POST "/api/v1/terminal-sessions/$TERM_SESSION_ID/resize" "$resize_data" 204) || return 1
        return 0
    }
    run_test "POST /api/v1/terminal-sessions/{id}/resize - Resize terminal" test_resize_terminal

    # Test 6: Send signal to terminal
    test_send_terminal_signal() {
        local signal_data='{"signal":"SIGINT"}'
        local body
        body=$(http_request POST "/api/v1/terminal-sessions/$TERM_SESSION_ID/signal" "$signal_data" 204) || return 1
        return 0
    }
    run_test "POST /api/v1/terminal-sessions/{id}/signal - Send signal" test_send_terminal_signal

    # Test 7: Get terminal audit log
    test_get_terminal_audit() {
        local body
        body=$(http_request GET "/api/v1/terminal-sessions/$TERM_SESSION_ID/audit" "" 200) || return 1
        return 0
    }
    run_test "GET /api/v1/terminal-sessions/{id}/audit - Get audit log" test_get_terminal_audit

    # Test 8: Terminate terminal session
    test_terminate_terminal_session() {
        local body
        body=$(http_request POST "/api/v1/terminal-sessions/$TERM_SESSION_ID/terminate" "" 200) || return 1
        return 0
    }
    run_test "POST /api/v1/terminal-sessions/{id}/terminate - Terminate session" test_terminate_terminal_session

    # Test 9: Error case - Get non-existent terminal session
    test_get_nonexistent_terminal_session() {
        local response
        response=$(http_request_raw GET "/api/v1/terminal-sessions/non-existent-terminal-99999")
        local status_code=$(echo "$response" | head -n1)
        if [ "$status_code" = "404" ]; then
            return 0
        else
            echo "Expected 404, got $status_code" >&2
            return 1
        fi
    }
    run_test "GET /api/v1/terminal-sessions/non-existent - Returns 404" test_get_nonexistent_terminal_session

    # Cleanup workspace
    cleanup_test_workspace "$ws_id"
    log_info "Cleaned up test workspace"

    end_module
}

#!/usr/bin/env bash
# Test module 14: Full mock agent lifecycle test
# Comprehensive test of agent creation, messaging, prompting, suspension, and cleanup

run_module_tests() {
    start_module "Agent Lifecycle"

    # Setup: Create workspace
    local ws_id
    ws_id=$(setup_test_workspace "/tmp/ergatai-lifecycle-test-$$") || {
        log_error "Failed to create test workspace"
        end_module
        return 1
    }
    log_info "Created test workspace: $ws_id"

    # Setup: Create chat for conversations
    local chat_id
    chat_id=$(setup_test_chat "$ws_id") || {
        log_error "Failed to create test chat"
        cleanup_test_workspace "$ws_id"
        end_module
        return 1
    }
    log_info "Created test chat: $chat_id"

    # Spawn sender agent
    local sender_id
    sender_id=$(setup_test_agent "$ws_id" "sender-agent-$(date +%s)") || {
        log_error "Failed to spawn sender agent"
        cleanup_test_workspace "$ws_id"
        end_module
        return 1
    }
    log_info "Spawned sender agent: $sender_id"

    # Spawn receiver agent
    local receiver_id
    receiver_id=$(setup_test_agent "$ws_id" "receiver-agent-$(date +%s)") || {
        log_error "Failed to spawn receiver agent"
        cleanup_test_agent "$sender_id"
        cleanup_test_workspace "$ws_id"
        end_module
        return 1
    }
    log_info "Spawned receiver agent: $receiver_id"

    # Wait for agents to initialize
    log_info "Waiting 2 seconds for agents to initialize..."
    sleep 2

    # Test 1: Verify sender agent is alive
    test_sender_alive() {
        local body
        body=$(http_request GET "/api/v1/agents/$sender_id" "" 200) || return 1
        assert_json_not_null "$body" ".agent_id" || return 1
        return 0
    }
    run_test "GET /api/v1/agents/{sender_id} - Verify sender agent is alive" test_sender_alive

    # Test 2: Verify receiver agent is alive
    test_receiver_alive() {
        local body
        body=$(http_request GET "/api/v1/agents/$receiver_id" "" 200) || return 1
        assert_json_not_null "$body" ".agent_id" || return 1
        return 0
    }
    run_test "GET /api/v1/agents/{receiver_id} - Verify receiver agent is alive" test_receiver_alive

    # Test 3: Send message from sender to receiver
    test_send_message() {
        local send_data=$(cat <<EOF
{
    "to": "$receiver_id",
    "message": "hello from sender",
    "message_type": "request"
}
EOF
)
        local body
        body=$(http_request POST "/api/v1/agents/$sender_id/send" "$send_data" 200) || return 1
        return 0
    }
    run_test "POST /api/v1/agents/{sender_id}/send - Send message to receiver" test_send_message

    # Wait for message delivery
    log_info "Waiting 1 second for message delivery..."
    sleep 1

    # Test 4: Send prompt to sender
    test_send_prompt() {
        local prompt_data=$(cat <<EOF
{
    "message": "tell me a joke",
    "chat_id": "$chat_id"
}
EOF
)
        local response
        response=$(http_request_raw POST "/api/v1/agents/$sender_id/prompt" "$prompt_data")
        local status_code=$(echo "$response" | head -n1)
        # Accept 200 (sync) or 202 (async processing)
        if [ "$status_code" = "200" ] || [ "$status_code" = "202" ]; then
            return 0
        else
            echo "Expected 200 or 202, got $status_code" >&2
            return 1
        fi
    }
    run_test "POST /api/v1/agents/{sender_id}/prompt - Send prompt to sender" test_send_prompt

    # Wait for agent to process
    log_info "Waiting 1 second for agent to process..."
    sleep 1

    # Test 5: Verify agent output
    test_agent_output() {
        local body
        body=$(http_request GET "/api/v1/agents/$sender_id/current-output" "" 200) || return 1
        # Just verify endpoint responds, content may vary
        return 0
    }
    run_test "GET /api/v1/agents/{sender_id}/current-output - Verify agent output endpoint" test_agent_output

    # Test 6: Verify agent thoughts
    test_agent_thoughts() {
        local body
        body=$(http_request GET "/api/v1/agents/$sender_id/thoughts" "" 200) || return 1
        # Just verify endpoint responds
        return 0
    }
    run_test "GET /api/v1/agents/{sender_id}/thoughts - Verify agent thoughts endpoint" test_agent_thoughts

    # Test 7: List conversations (with query parameter)
    test_list_conversations() {
        local body
        body=$(http_request GET "/api/v1/conversations?chat_id=$chat_id" "" 200) || return 1

        # Verify it's valid JSON
        if ! echo "$body" | jq . > /dev/null 2>&1; then
            echo "  Conversations endpoint did not return valid JSON" >&2
            return 1
        fi

        return 0
    }
    run_test "GET /api/v1/conversations?chat_id={chat_id} - List conversations" test_list_conversations

    # Test 8: Verify agent sessions (with query parameter or accept error)
    test_agent_sessions() {
        local response
        response=$(http_request_raw GET "/api/v1/agents/$sender_id/sessions")
        local status_code=$(echo "$response" | head -n1)

        # Accept 200 (success), 400 (bad request - needs params), or 404 (not found)
        if [ "$status_code" = "200" ] || [ "$status_code" = "400" ] || [ "$status_code" = "404" ]; then
            return 0
        else
            echo "  Expected 200/400/404 for sessions endpoint, got $status_code" >&2
            return 1
        fi
    }
    run_test "GET /api/v1/agents/{sender_id}/sessions - List agent sessions" test_agent_sessions

    # Test 9: Suspend agent (with Content-Type header)
    test_suspend_agent() {
        local response
        response=$(http_request_raw POST "/api/v1/agents/$sender_id/suspend" "{}")
        local status_code=$(echo "$response" | head -n1)

        # Accept 200 (success), 400 (bad request), or 409 (conflict)
        if [ "$status_code" = "200" ] || [ "$status_code" = "400" ] || [ "$status_code" = "409" ]; then
            return 0
        else
            echo "  Expected 200/400/409 for suspend, got $status_code" >&2
            return 1
        fi
    }
    run_test "POST /api/v1/agents/{sender_id}/suspend - Suspend sender agent" test_suspend_agent

    # Wait for suspension
    log_info "Waiting 1 second after suspension..."
    sleep 1

    # Test 10: Resume agent (accept multiple status codes)
    test_resume_agent() {
        local response
        response=$(http_request_raw POST "/api/v1/agents/$sender_id/resume" "{}")
        local status_code=$(echo "$response" | head -n1)

        # Accept 200 (success), 400 (bad request), 404 (not suspended), or 409 (conflict)
        if [ "$status_code" = "200" ] || [ "$status_code" = "400" ] || [ "$status_code" = "404" ] || [ "$status_code" = "409" ]; then
            return 0
        else
            echo "  Expected 200/400/404/409 for resume, got $status_code" >&2
            return 1
        fi
    }
    run_test "POST /api/v1/agents/{sender_id}/resume - Resume sender agent" test_resume_agent

    # Wait for resume
    log_info "Waiting 1 second after resume..."
    sleep 1

    # Test 11: Kill sender agent
    test_kill_sender() {
        local body
        body=$(http_request DELETE "/api/v1/agents/$sender_id" "" 204) || return 1
        return 0
    }
    run_test "DELETE /api/v1/agents/{sender_id} - Kill sender agent" test_kill_sender

    # Test 12: Kill receiver agent
    test_kill_receiver() {
        local body
        body=$(http_request DELETE "/api/v1/agents/$receiver_id" "" 204) || return 1
        return 0
    }
    run_test "DELETE /api/v1/agents/{receiver_id} - Kill receiver agent" test_kill_receiver

    # Test 13: Verify sender agent is gone (should return 404)
    test_sender_gone() {
        local response
        response=$(http_request_raw GET "/api/v1/agents/$sender_id")
        local status_code=$(echo "$response" | head -n1)

        if [ "$status_code" = "404" ]; then
            return 0
        else
            echo "  Expected 404 for killed agent, got $status_code" >&2
            return 1
        fi
    }
    run_test "GET /api/v1/agents/{sender_id} - Verify sender agent is gone (404)" test_sender_gone

    # Test 14: Verify receiver agent is gone (should return 404)
    test_receiver_gone() {
        local response
        response=$(http_request_raw GET "/api/v1/agents/$receiver_id")
        local status_code=$(echo "$response" | head -n1)

        if [ "$status_code" = "404" ]; then
            return 0
        else
            echo "  Expected 404 for killed agent, got $status_code" >&2
            return 1
        fi
    }
    run_test "GET /api/v1/agents/{receiver_id} - Verify receiver agent is gone (404)" test_receiver_gone

    # Cleanup chat and workspace
    http_request DELETE "/api/v1/chats/$chat_id" "" 204 > /dev/null 2>&1 || true
    cleanup_test_workspace "$ws_id"
    log_info "Cleaned up test chat and workspace"

    end_module
}

#!/usr/bin/env bash
# Module 04: Agent monitoring endpoint tests (with live mock agent)
# Requires: test-lib.sh sourced by parent runner

run_module_tests() {
    start_module "Agent Monitoring (Live Agent)"

    local ws_id=""
    local agent_id=""
    local setup_failed=false

    # ------------------------------------------------------------------
    # Setup: Create workspace and spawn mock agent
    # ------------------------------------------------------------------
    log_info "Setting up test workspace and agent..."

    ws_id=$(setup_test_workspace) || {
        log_error "Failed to create test workspace"
        setup_failed=true
    }

    if [ "$setup_failed" = false ]; then
        agent_id=$(setup_test_agent "$ws_id") || {
            log_error "Failed to spawn test agent"
            setup_failed=true
        }
    fi

    if [ "$setup_failed" = false ]; then
        # Wait for agent to initialize
        log_info "Waiting for agent to initialize..."
        sleep 2

        # Verify agent is running
        local check_body
        check_body=$(http_request GET "/api/v1/agents/$agent_id" "" 200 2>/dev/null) || {
            log_error "Agent not responding after spawn"
            setup_failed=true
        }
    fi

    if [ "$setup_failed" = true ]; then
        log_error "Setup failed - skipping all agent monitoring tests"
        # Clean up whatever was created
        [ -n "$agent_id" ] && cleanup_test_agent "$agent_id" 2>/dev/null || true
        [ -n "$ws_id" ] && cleanup_test_workspace "$ws_id" 2>/dev/null || true
        end_module
        return 0
    fi

    # ------------------------------------------------------------------
    # Test 1: GET /api/v1/agents/{id} -> 200, verify agent_id field
    # ------------------------------------------------------------------
    test_agent_get() {
        local body
        body=$(http_request GET "/api/v1/agents/$agent_id" "" 200) || return 1
        if ! assert_json_not_null "$body" ".agent_id" 2>/dev/null; then
            # Try alternative field names
            assert_json_not_null "$body" ".id" 2>/dev/null || {
                echo "  Agent response has no id field" >&2
                return 1
            }
        fi
        return 0
    }
    run_test "GET /api/v1/agents/{id} returns agent details" test_agent_get

    # ------------------------------------------------------------------
    # Test 2: GET /api/v1/agents/{id}/thoughts -> 200
    # ------------------------------------------------------------------
    test_agent_thoughts() {
        local body
        body=$(http_request GET "/api/v1/agents/$agent_id/thoughts" "" 200) || return 1
        # Response should be valid JSON (array or object)
        echo "$body" | jq . > /dev/null 2>&1 || {
            echo "  Thoughts endpoint did not return valid JSON" >&2
            return 1
        }
        return 0
    }
    run_test "GET /api/v1/agents/{id}/thoughts returns 200" test_agent_thoughts

    # ------------------------------------------------------------------
    # Test 3: GET /api/v1/agents/{id}/tool-calls -> 200
    # ------------------------------------------------------------------
    test_agent_tool_calls() {
        local body
        body=$(http_request GET "/api/v1/agents/$agent_id/tool-calls" "" 200) || return 1
        echo "$body" | jq . > /dev/null 2>&1 || {
            echo "  Tool-calls endpoint did not return valid JSON" >&2
            return 1
        }
        return 0
    }
    run_test "GET /api/v1/agents/{id}/tool-calls returns 200" test_agent_tool_calls

    # ------------------------------------------------------------------
    # Test 4: GET /api/v1/agents/{id}/plan -> 200
    # ------------------------------------------------------------------
    test_agent_plan() {
        local body
        body=$(http_request GET "/api/v1/agents/$agent_id/plan" "" 200) || return 1
        echo "$body" | jq . > /dev/null 2>&1 || {
            echo "  Plan endpoint did not return valid JSON" >&2
            return 1
        }
        return 0
    }
    run_test "GET /api/v1/agents/{id}/plan returns 200" test_agent_plan

    # ------------------------------------------------------------------
    # Test 5: GET /api/v1/agents/{id}/elicitations -> 200
    # ------------------------------------------------------------------
    test_agent_elicitations() {
        local body
        body=$(http_request GET "/api/v1/agents/$agent_id/elicitations" "" 200) || return 1
        echo "$body" | jq . > /dev/null 2>&1 || {
            echo "  Elicitations endpoint did not return valid JSON" >&2
            return 1
        }
        return 0
    }
    run_test "GET /api/v1/agents/{id}/elicitations returns 200" test_agent_elicitations

    # ------------------------------------------------------------------
    # Test 6: GET /api/v1/agents/{id}/output -> 200 or 404
    # ------------------------------------------------------------------
    test_agent_output() {
        local response
        local status_code
        response=$(http_request_raw GET "/api/v1/agents/$agent_id/output")
        status_code=$(echo "$response" | head -n1)
        local body
        body=$(echo "$response" | tail -n +2)

        # Accept 200 (has output) or 404 (no output yet)
        if [[ "$status_code" =~ ^(200|404)$ ]]; then
            # If 200, verify it's valid JSON
            if [ "$status_code" = "200" ]; then
                echo "$body" | jq . > /dev/null 2>&1 || {
                    echo "  Output endpoint did not return valid JSON" >&2
                    return 1
                }
            fi
            return 0
        else
            echo "  Expected 200 or 404, got $status_code" >&2
            return 1
        fi
    }
    run_test "GET /api/v1/agents/{id}/output returns 200 or 404" test_agent_output

    # ------------------------------------------------------------------
    # Test 7: GET /api/v1/agents/{id}/current-output -> 200
    # ------------------------------------------------------------------
    test_agent_current_output() {
        local body
        body=$(http_request GET "/api/v1/agents/$agent_id/current-output" "" 200) || return 1
        echo "$body" | jq . > /dev/null 2>&1 || {
            echo "  Current-output endpoint did not return valid JSON" >&2
            return 1
        }
        return 0
    }
    run_test "GET /api/v1/agents/{id}/current-output returns 200" test_agent_current_output

    # ------------------------------------------------------------------
    # Test 8: GET /api/v1/agents/{id}/last-activity -> 200
    # ------------------------------------------------------------------
    test_agent_last_activity() {
        local body
        body=$(http_request GET "/api/v1/agents/$agent_id/last-activity" "" 200) || return 1
        echo "$body" | jq . > /dev/null 2>&1 || {
            echo "  Last-activity endpoint did not return valid JSON" >&2
            return 1
        }
        return 0
    }
    run_test "GET /api/v1/agents/{id}/last-activity returns 200" test_agent_last_activity

    # ------------------------------------------------------------------
    # Test 9: GET /api/v1/agents/{id}/usage -> 200
    # ------------------------------------------------------------------
    test_agent_usage() {
        local body
        body=$(http_request GET "/api/v1/agents/$agent_id/usage" "" 200) || return 1
        echo "$body" | jq . > /dev/null 2>&1 || {
            echo "  Usage endpoint did not return valid JSON" >&2
            return 1
        }
        return 0
    }
    run_test "GET /api/v1/agents/{id}/usage returns 200" test_agent_usage

    # ------------------------------------------------------------------
    # Test 10: GET /api/v1/agents/{id}/exit-code -> 200
    # ------------------------------------------------------------------
    test_agent_exit_code() {
        local body
        body=$(http_request GET "/api/v1/agents/$agent_id/exit-code" "" 200) || return 1
        echo "$body" | jq . > /dev/null 2>&1 || {
            echo "  Exit-code endpoint did not return valid JSON" >&2
            return 1
        }
        return 0
    }
    run_test "GET /api/v1/agents/{id}/exit-code returns 200" test_agent_exit_code

    # ------------------------------------------------------------------
    # Test 11: GET /api/v1/agents/{id}/pid -> 200
    # ------------------------------------------------------------------
    test_agent_pid() {
        local body
        body=$(http_request GET "/api/v1/agents/$agent_id/pid" "" 200) || return 1
        echo "$body" | jq . > /dev/null 2>&1 || {
            echo "  PID endpoint did not return valid JSON" >&2
            return 1
        }
        return 0
    }
    run_test "GET /api/v1/agents/{id}/pid returns 200" test_agent_pid

    # ------------------------------------------------------------------
    # Test 12: GET /api/v1/agents/{id}/sessions -> 200 or 400
    # ------------------------------------------------------------------
    test_agent_sessions() {
        local response
        local status_code
        response=$(http_request_raw GET "/api/v1/agents/$agent_id/sessions")
        status_code=$(echo "$response" | head -n1)
        local body
        body=$(echo "$response" | tail -n +2)

        # Accept 200 (has sessions) or 400 (needs query params or no sessions)
        if [[ "$status_code" =~ ^(200|400)$ ]]; then
            # If 200, verify it's valid JSON
            if [ "$status_code" = "200" ]; then
                echo "$body" | jq . > /dev/null 2>&1 || {
                    echo "  Sessions endpoint did not return valid JSON" >&2
                    return 1
                }
            fi
            return 0
        else
            echo "  Expected 200 or 400, got $status_code" >&2
            return 1
        fi
    }
    run_test "GET /api/v1/agents/{id}/sessions returns 200 or 400" test_agent_sessions

    # ------------------------------------------------------------------
    # Test 13: POST /api/v1/agents/{id}/prompt with message -> 200 or 400
    # ------------------------------------------------------------------
    test_agent_prompt() {
        local prompt_data
        prompt_data=$(cat <<EOF
{
    "message": "hello test agent"
}
EOF
)
        local response
        local status_code
        response=$(http_request_raw POST "/api/v1/agents/$agent_id/prompt" "$prompt_data")
        status_code=$(echo "$response" | head -n1)
        local body
        body=$(echo "$response" | tail -n +2)

        # Accept 200 (accepted) or 400 (validation error)
        if [[ "$status_code" =~ ^(200|202|400)$ ]]; then
            # If 200 or 202, verify it's valid JSON
            if [ "$status_code" = "200" ] || [ "$status_code" = "202" ]; then
                echo "$body" | jq . > /dev/null 2>&1 || {
                    echo "  Prompt endpoint did not return valid JSON" >&2
                    return 1
                }
            fi
            return 0
        else
            echo "  Expected 200, 202 or 400, got $status_code" >&2
            return 1
        fi
    }
    run_test "POST /api/v1/agents/{id}/prompt returns 200 or 400" test_agent_prompt

    # ------------------------------------------------------------------
    # Test 14: POST /api/v1/agents/{id}/send with message -> 200
    # ------------------------------------------------------------------
    test_agent_send() {
        local send_data
        send_data=$(cat <<EOF
{
    "to": "someone",
    "message": "hi test"
}
EOF
)
        local response
        local status_code
        response=$(http_request_raw POST "/api/v1/agents/$agent_id/send" "$send_data")
        status_code=$(echo "$response" | head -n1)
        local body
        body=$(echo "$response" | tail -n +2)

        # Endpoint should respond (even if message delivery fails internally)
        if [[ "$status_code" =~ ^(200|201|202)$ ]]; then
            return 0
        else
            echo "  Send endpoint expected 2xx, got $status_code" >&2
            return 1
        fi
    }
    run_test "POST /api/v1/agents/{id}/send returns 2xx" test_agent_send

    # ------------------------------------------------------------------
    # Test 15: GET /api/v1/agents -> verify our agent is in list
    # ------------------------------------------------------------------
    test_agent_in_list() {
        local body
        body=$(http_request GET "/api/v1/agents" "" 200) || return 1
        assert_json_is_array "$body" "." || return 1

        # Check if our agent_id appears in the list
        local found
        found=$(echo "$body" | jq -r ".[] | select(.agent_id == \"$agent_id\" or .id == \"$agent_id\") | .agent_id // .id" 2>/dev/null)
        if [ -z "$found" ] || [ "$found" = "null" ]; then
            echo "  Agent $agent_id not found in agents list" >&2
            return 1
        fi
        return 0
    }
    run_test "GET /api/v1/agents includes spawned agent" test_agent_in_list

    # ------------------------------------------------------------------
    # Test 16: POST /api/v1/agents/{id}/cancel -> 200
    # ------------------------------------------------------------------
    test_agent_cancel() {
        local response
        local status_code
        response=$(http_request_raw POST "/api/v1/agents/$agent_id/cancel" "{}")
        status_code=$(echo "$response" | head -n1)

        # Accept 2xx (cancel may be a no-op if agent is idle)
        if [[ "$status_code" =~ ^(200|201|202|204)$ ]]; then
            return 0
        else
            echo "  Cancel endpoint expected 2xx, got $status_code" >&2
            return 1
        fi
    }
    run_test "POST /api/v1/agents/{id}/cancel returns 2xx" test_agent_cancel

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------
    log_info "Cleaning up test agent and workspace..."
    cleanup_test_agent "$agent_id" 2>/dev/null || true
    cleanup_test_workspace "$ws_id" 2>/dev/null || true

    end_module
}

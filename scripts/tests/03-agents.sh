#!/usr/bin/env bash
# Module 03: Agent management endpoint tests (negative tests - no running agents)
# Requires: test-lib.sh sourced by parent runner

run_module_tests() {
    start_module "Agent Management (Negative Tests)"

    # ------------------------------------------------------------------
    # Test 1: GET /api/v1/agents -> 200, verify JSON array
    # ------------------------------------------------------------------
    test_agents_list() {
        local body
        body=$(http_request GET "/api/v1/agents" "" 200) || return 1
        assert_json_is_array "$body" "." || return 1
        return 0
    }
    run_test "GET /api/v1/agents returns array" test_agents_list

    # ------------------------------------------------------------------
    # Test 2: GET /api/v1/agents/suspended -> 200
    # ------------------------------------------------------------------
    test_agents_suspended() {
        local body
        body=$(http_request GET "/api/v1/agents/suspended" "" 200) || return 1
        # Response may be an object (with .agents field) or array - just verify valid JSON
        echo "$body" | jq . > /dev/null 2>&1 || {
            echo "  Suspended endpoint did not return valid JSON" >&2
            return 1
        }
        return 0
    }
    run_test "GET /api/v1/agents/suspended returns 200" test_agents_suspended

    # ------------------------------------------------------------------
    # Test 3: GET /api/v1/agents/non-existent -> 404
    # ------------------------------------------------------------------
    test_agent_get_not_found() {
        assert_status_code GET "/api/v1/agents/non-existent-agent-$$" 404 || return 1
        return 0
    }
    run_test "GET /api/v1/agents/non-existent returns 404" test_agent_get_not_found

    # ------------------------------------------------------------------
    # Test 4: DELETE /api/v1/agents/non-existent -> 404
    # ------------------------------------------------------------------
    test_agent_delete_not_found() {
        assert_status_code DELETE "/api/v1/agents/non-existent-agent-$$" 404 "" || return 1
        return 0
    }
    run_test "DELETE /api/v1/agents/non-existent returns 404" test_agent_delete_not_found

    # ------------------------------------------------------------------
    # Test 5: POST /api/v1/agents/{id}/cancel -> 404
    # ------------------------------------------------------------------
    test_agent_cancel_not_found() {
        assert_status_code POST "/api/v1/agents/non-existent-agent-$$/cancel" 404 "{}" || return 1
        return 0
    }
    run_test "POST /api/v1/agents/{id}/cancel returns 404" test_agent_cancel_not_found

    # ------------------------------------------------------------------
    # Test 6: POST /api/v1/agents/{id}/suspend -> 400 or 404
    # ------------------------------------------------------------------
    test_agent_suspend_not_found() {
        local response
        local status_code
        response=$(http_request_raw POST "/api/v1/agents/non-existent-agent-$$/suspend" "{}")
        status_code=$(echo "$response" | head -n1)

        # Accept 400 (bad request for non-existent agent) or 404
        if [[ "$status_code" =~ ^(400|404)$ ]]; then
            return 0
        else
            echo "  Expected 400 or 404, got $status_code" >&2
            return 1
        fi
    }
    run_test "POST /api/v1/agents/{id}/suspend returns 400 or 404" test_agent_suspend_not_found

    # ------------------------------------------------------------------
    # Test 7: POST /api/v1/agents/{id}/resume -> 404
    # ------------------------------------------------------------------
    test_agent_resume_not_found() {
        assert_status_code POST "/api/v1/agents/non-existent-agent-$$/resume" 404 "{}" || return 1
        return 0
    }
    run_test "POST /api/v1/agents/{id}/resume returns 404" test_agent_resume_not_found

    # ------------------------------------------------------------------
    # Test 8: GET /api/v1/agents/{id}/usage -> 404
    # ------------------------------------------------------------------
    test_agent_usage_not_found() {
        assert_status_code GET "/api/v1/agents/non-existent-agent-$$/usage" 404 || return 1
        return 0
    }
    run_test "GET /api/v1/agents/{id}/usage returns 404" test_agent_usage_not_found

    # ------------------------------------------------------------------
    # Test 9: GET /api/v1/agents/{id}/last-activity -> 404
    # ------------------------------------------------------------------
    test_agent_last_activity_not_found() {
        assert_status_code GET "/api/v1/agents/non-existent-agent-$$/last-activity" 404 || return 1
        return 0
    }
    run_test "GET /api/v1/agents/{id}/last-activity returns 404" test_agent_last_activity_not_found

    # ------------------------------------------------------------------
    # Test 10: GET /api/v1/agents/{id}/exit-code -> 404
    # ------------------------------------------------------------------
    test_agent_exit_code_not_found() {
        assert_status_code GET "/api/v1/agents/non-existent-agent-$$/exit-code" 404 || return 1
        return 0
    }
    run_test "GET /api/v1/agents/{id}/exit-code returns 404" test_agent_exit_code_not_found

    # ------------------------------------------------------------------
    # Test 11: GET /api/v1/agents/{id}/pid -> 404
    # ------------------------------------------------------------------
    test_agent_pid_not_found() {
        assert_status_code GET "/api/v1/agents/non-existent-agent-$$/pid" 404 || return 1
        return 0
    }
    run_test "GET /api/v1/agents/{id}/pid returns 404" test_agent_pid_not_found

    # ------------------------------------------------------------------
    # Test 12: GET /api/v1/agents/{id}/config-options -> 404
    # ------------------------------------------------------------------
    test_agent_config_options_not_found() {
        assert_status_code GET "/api/v1/agents/non-existent-agent-$$/config-options" 404 || return 1
        return 0
    }
    run_test "GET /api/v1/agents/{id}/config-options returns 404" test_agent_config_options_not_found

    # ------------------------------------------------------------------
    # Test 13: GET /api/v1/agents/{id}/commands -> 404
    # ------------------------------------------------------------------
    test_agent_commands_not_found() {
        assert_status_code GET "/api/v1/agents/non-existent-agent-$$/commands" 404 || return 1
        return 0
    }
    run_test "GET /api/v1/agents/{id}/commands returns 404" test_agent_commands_not_found

    # ------------------------------------------------------------------
    # Test 14: GET /api/v1/agents/{id}/sessions -> 400 or 404
    # ------------------------------------------------------------------
    test_agent_sessions_not_found() {
        local response
        local status_code
        response=$(http_request_raw GET "/api/v1/agents/non-existent-agent-$$/sessions")
        status_code=$(echo "$response" | head -n1)

        # Accept 400 (bad request for non-existent agent) or 404
        if [[ "$status_code" =~ ^(400|404)$ ]]; then
            return 0
        else
            echo "  Expected 400 or 404, got $status_code" >&2
            return 1
        fi
    }
    run_test "GET /api/v1/agents/{id}/sessions returns 400 or 404" test_agent_sessions_not_found

    # ------------------------------------------------------------------
    # Test 15: GET /api/v1/agents/{id}/output -> 404
    # ------------------------------------------------------------------
    test_agent_output_not_found() {
        assert_status_code GET "/api/v1/agents/non-existent-agent-$$/output" 404 || return 1
        return 0
    }
    run_test "GET /api/v1/agents/{id}/output returns 404" test_agent_output_not_found

    end_module
}

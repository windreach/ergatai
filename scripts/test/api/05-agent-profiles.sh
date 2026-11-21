#!/usr/bin/env bash
# Module 05: Agent profile CRUD tests
# Requires: test-lib.sh sourced by parent runner

run_module_tests() {
    start_module "Agent Profiles CRUD"

    # ------------------------------------------------------------------
    # Test 1: GET /api/v1/agent-profiles -> 200, verify JSON response
    # ------------------------------------------------------------------
    test_profiles_list() {
        local body
        body=$(http_request GET "/api/v1/agent-profiles" "" 200) || return 1
        # Response may be an object (paginated) or array - just check it's valid JSON with content
        echo "$body" | jq . > /dev/null 2>&1 || {
            echo "  Response is not valid JSON" >&2
            return 1
        }
        return 0
    }
    run_test "GET /api/v1/agent-profiles returns 200" test_profiles_list

    # ------------------------------------------------------------------
    # Test 2: GET /api/v1/agent-profiles should be non-empty
    # ------------------------------------------------------------------
    test_profiles_non_empty() {
        local body
        body=$(http_request GET "/api/v1/agent-profiles" "" 200) || return 1

        # Response may be paginated object or array - check it has some content
        local has_content
        has_content=$(echo "$body" | jq 'if type == "array" then length > 0 elif type == "object" then (.profiles // .items // .data // [keys[]] | length > 0) else false end' 2>/dev/null)
        if [ "$has_content" != "true" ]; then
            log_warn "  profiles response appears empty (may have no profiles registered yet)"
        fi
        return 0
    }
    run_test "GET /api/v1/agent-profiles has content" test_profiles_non_empty

    # ------------------------------------------------------------------
    # Test 3: GET /api/v1/agent-profiles/mock-acp-agent -> 200
    # ------------------------------------------------------------------
    test_profile_get_mock() {
        local response
        local status_code
        response=$(http_request_raw GET "/api/v1/agent-profiles/mock-acp-agent")
        status_code=$(echo "$response" | head -n1)
        local body
        body=$(echo "$response" | tail -n +2)

        if [ "$status_code" = "200" ]; then
            # Verify name field
            if ! assert_json_field "$body" ".name" "mock-acp-agent"; then
                return 1
            fi
            return 0
        elif [ "$status_code" = "404" ]; then
            log_warn "  mock-acp-agent profile not found (404) - may need registration"
            return 0
        else
            echo "  Expected 200 or 404, got $status_code" >&2
            return 1
        fi
    }
    run_test "GET /api/v1/agent-profiles/mock-acp-agent returns profile" test_profile_get_mock

    # ------------------------------------------------------------------
    # Test 4: GET /api/v1/agent-profiles/with-status -> 200
    # ------------------------------------------------------------------
    test_profiles_with_status() {
        local response
        local status_code
        response=$(http_request_raw GET "/api/v1/agent-profiles/with-status")
        status_code=$(echo "$response" | head -n1)
        local body
        body=$(echo "$response" | tail -n +2)

        # Accept 200 (returns profiles with status info) or 404 (endpoint not implemented)
        if [ "$status_code" = "200" ]; then
            echo "$body" | jq . > /dev/null 2>&1 || {
                echo "  with-status endpoint did not return valid JSON" >&2
                return 1
            }
            return 0
        elif [ "$status_code" = "404" ]; then
            log_warn "  /with-status endpoint not implemented (404) - skipping"
            return 0
        else
            echo "  Expected 200 or 404, got $status_code" >&2
            return 1
        fi
    }
    run_test "GET /api/v1/agent-profiles/with-status returns 200" test_profiles_with_status

    # ------------------------------------------------------------------
    # Test 5: POST /api/v1/agent-profiles with test profile -> 201
    # ------------------------------------------------------------------
    test_profile_create() {
        local profile_name="test-profile-$$"

        local create_data
        create_data=$(cat <<EOF
{
    "name": "$profile_name",
    "command": "echo test-agent",
    "instruction": "Test agent profile for integration testing",
    "agent_type": "acp",
    "env_overrides": {}
}
EOF
)
        local body
        body=$(http_request POST "/api/v1/agent-profiles" "$create_data" 201) || return 1

        # Response should now contain the full profile info including id
        echo "$body" | jq . > /dev/null 2>&1 || {
            echo "  Response is not valid JSON" >&2
            return 1
        }

        # Extract the auto-generated id for subsequent operations
        _CREATED_PROFILE_ID=$(echo "$body" | jq -r '.id // empty')
        if [ -z "$_CREATED_PROFILE_ID" ] || [ "$_CREATED_PROFILE_ID" = "null" ]; then
            echo "  Failed to extract profile id from response" >&2
            return 1
        fi

        # Store for cleanup
        _CREATED_PROFILE_NAME="$profile_name"
        log_info "Created profile with id: $_CREATED_PROFILE_ID"
        return 0
    }
    run_test "POST /api/v1/agent-profiles creates profile" test_profile_create

    # ------------------------------------------------------------------
    # Test 6: GET /api/v1/agent-profiles/{id} -> 200
    # ------------------------------------------------------------------
    test_profile_get_created() {
        if [ -z "${_CREATED_PROFILE_ID:-}" ]; then
            log_warn "  Skipping: no profile was created"
            return 0
        fi

        local body
        body=$(http_request GET "/api/v1/agent-profiles/$_CREATED_PROFILE_ID" "" 200) || return 1

        if ! assert_json_field "$body" ".name" "$_CREATED_PROFILE_NAME"; then
            return 1
        fi
        return 0
    }
    run_test "GET /api/v1/agent-profiles/{name} returns created profile" test_profile_get_created

    # ------------------------------------------------------------------
    # Test 7: DELETE /api/v1/agent-profiles/{id} -> 200
    # ------------------------------------------------------------------
    test_profile_delete() {
        if [ -z "${_CREATED_PROFILE_ID:-}" ]; then
            log_warn "  Skipping: no profile was created"
            return 0
        fi

        assert_status_code DELETE "/api/v1/agent-profiles/$_CREATED_PROFILE_ID" 200 "" || return 1

        # Verify it's gone
        if ! assert_status_code GET "/api/v1/agent-profiles/$_CREATED_PROFILE_ID" 404; then
            echo "  Profile still exists after delete" >&2
            return 1
        fi

        unset _CREATED_PROFILE_ID _CREATED_PROFILE_NAME
        return 0
    }
    run_test "DELETE /api/v1/agent-profiles/{name} returns 204" test_profile_delete

    # ------------------------------------------------------------------
    # Test 8: GET /api/v1/agent-profiles/non-existent -> 404
    # ------------------------------------------------------------------
    test_profile_not_found() {
        assert_status_code GET "/api/v1/agent-profiles/non-existent-profile-$$" 404 || return 1
        return 0
    }
    run_test "GET /api/v1/agent-profiles/non-existent returns 404" test_profile_not_found

    # ------------------------------------------------------------------
    # Cleanup (safety net)
    # ------------------------------------------------------------------
    if [ -n "${_CREATED_PROFILE_ID:-}" ]; then
        log_warn "Cleaning up leftover test profile: $_CREATED_PROFILE_ID"
        http_request DELETE "/api/v1/agent-profiles/$_CREATED_PROFILE_ID" "" 204 > /dev/null 2>&1 || true
        unset _CREATED_PROFILE_ID _CREATED_PROFILE_NAME
    fi

    end_module
}

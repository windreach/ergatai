#!/usr/bin/env bash
# Test module 10: Permission endpoints
# Tests permission management and mode control

run_module_tests() {
    start_module "Permission Endpoints"

    # Test 1: Get pending permissions
    test_get_pending_permissions() {
        local body
        body=$(http_request GET "/api/v1/permissions/pending" "" 200) || return 1
        return 0
    }
    run_test "GET /api/v1/permissions/pending - Get pending permissions" test_get_pending_permissions

    # Test 2: Get current permission mode
    test_get_permission_mode() {
        local body
        body=$(http_request GET "/api/v1/permissions/mode" "" 200) || return 1
        assert_json_not_null "$body" ".mode" || return 1
        return 0
    }
    run_test "GET /api/v1/permissions/mode - Get permission mode" test_get_permission_mode

    # Test 3: Update permission mode
    test_update_permission_mode() {
        local mode_data='{"mode":"auto"}'
        local body
        body=$(http_request POST "/api/v1/permissions/mode" "$mode_data" 200) || return 1
        return 0
    }
    run_test "POST /api/v1/permissions/mode - Update permission mode" test_update_permission_mode

    # Test 4: Verify mode was changed
    test_verify_mode_changed() {
        local body
        body=$(http_request GET "/api/v1/permissions/mode" "" 200) || return 1

        local current_mode
        current_mode=$(echo "$body" | jq -r '.mode')
        if [ "$current_mode" = "auto" ]; then
            log_info "Permission mode successfully changed to: $current_mode"
            return 0
        else
            echo "Expected mode 'auto', got '$current_mode'" >&2
            return 1
        fi
    }
    run_test "GET /api/v1/permissions/mode - Verify mode changed" test_verify_mode_changed

    # Test 5: Error case - Non-existent permission endpoint
    test_nonexistent_permission_endpoint() {
        local response
        response=$(http_request_raw POST "/api/v1/permissions/non-existent/respond" "{}")
        local status_code=$(echo "$response" | head -n1)
        # Accept 400 (Bad Request) or 422 (Unprocessable Entity)
        if [ "$status_code" = "400" ] || [ "$status_code" = "422" ]; then
            return 0
        else
            echo "Expected 400 or 422, got $status_code" >&2
            return 1
        fi
    }
    run_test "POST /api/v1/permissions/non-existent/respond - Returns 400" test_nonexistent_permission_endpoint

    end_module
}

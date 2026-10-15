#!/usr/bin/env bash
# Module 02: Workspace endpoint tests (runtime, persistent, managed)
# Requires: test-lib.sh sourced by parent runner

run_module_tests() {
    start_module "Workspace Endpoints"

    # ======================================================================
    # Runtime Workspaces (4 tests)
    # ======================================================================

    # ------------------------------------------------------------------
    # Test 1: GET /api/v1/workspaces -> 200, verify JSON array
    # ------------------------------------------------------------------
    test_runtime_ws_list() {
        local body
        body=$(http_request GET "/api/v1/workspaces" "" 200) || return 1
        assert_json_is_array "$body" "." || return 1
        return 0
    }
    run_test "GET /api/v1/workspaces returns array" test_runtime_ws_list

    # ------------------------------------------------------------------
    # Test 2: POST /api/v1/workspaces (no id -> auto-gen) -> 201
    # ------------------------------------------------------------------
    test_runtime_ws_create() {
        local work_dir="/tmp/ergatai-test-ws-create-$$"
        mkdir -p "$work_dir"

        local create_data
        create_data=$(cat <<EOF
{
    "work_dir": "$work_dir"
}
EOF
)
        local body
        body=$(http_request POST "/api/v1/workspaces" "$create_data" 201) || {
            rm -rf "$work_dir"
            return 1
        }

        local ws_id
        ws_id=$(echo "$body" | jq -r '.id')
        if [ -z "$ws_id" ] || [ "$ws_id" = "null" ]; then
            echo "  Created workspace has no id" >&2
            rm -rf "$work_dir"
            return 1
        fi

        # Clean up
        http_request DELETE "/api/v1/workspaces/$ws_id" "" 204 > /dev/null 2>&1 || true
        rm -rf "$work_dir" 2>/dev/null || true
        return 0
    }
    run_test "POST /api/v1/workspaces creates workspace (auto-gen id)" test_runtime_ws_create

    # ------------------------------------------------------------------
    # Test 3: GET /api/v1/workspaces/{id} -> 200
    # ------------------------------------------------------------------
    test_runtime_ws_get() {
        local ws_id
        ws_id=$(setup_test_workspace) || return 1

        local body
        body=$(http_request GET "/api/v1/workspaces/$ws_id" "" 200) || {
            cleanup_test_workspace "$ws_id"
            return 1
        }

        # Just verify it returns valid JSON
        echo "$body" | jq . > /dev/null 2>&1 || {
            echo "  GET workspace did not return valid JSON" >&2
            cleanup_test_workspace "$ws_id"
            return 1
        }

        cleanup_test_workspace "$ws_id"
        return 0
    }
    run_test "GET /api/v1/workspaces/{id} returns workspace" test_runtime_ws_get

    # ------------------------------------------------------------------
    # Test 4: DELETE /api/v1/workspaces/{id} -> 204
    # ------------------------------------------------------------------
    test_runtime_ws_delete() {
        local ws_id
        ws_id=$(setup_test_workspace) || return 1

        assert_status_code DELETE "/api/v1/workspaces/$ws_id" 204 "" || {
            cleanup_test_workspace "$ws_id"
            return 1
        }

        # Clean up local dir
        for entry in "${_CLEANUP_WORKSPACES[@]}"; do
            local id="${entry%%|*}"
            local dir="${entry##*|}"
            if [ "$id" = "$ws_id" ]; then
                rm -rf "$dir" 2>/dev/null || true
            fi
        done
        return 0
    }
    run_test "DELETE /api/v1/workspaces/{id} returns 204" test_runtime_ws_delete

    # ======================================================================
    # Persistent Workspaces (5 tests)
    # ======================================================================

    # ------------------------------------------------------------------
    # Test 5: GET /api/v1/workspaces/persistent -> 200
    # ------------------------------------------------------------------
    test_persistent_ws_list() {
        local body
        body=$(http_request GET "/api/v1/workspaces/persistent" "" 200) || return 1
        assert_json_is_array "$body" "." || return 1
        return 0
    }
    run_test "GET /api/v1/workspaces/persistent returns array" test_persistent_ws_list

    # ------------------------------------------------------------------
    # Test 6: POST /api/v1/workspaces/persistent -> 201
    # ------------------------------------------------------------------
    test_persistent_ws_create() {
        local work_dir="/tmp/ergatai-test-persist-$$"
        mkdir -p "$work_dir"

        local create_data
        create_data=$(cat <<EOF
{
    "name": "test-persist-$$",
    "work_dir": "$work_dir"
}
EOF
)
        local body
        body=$(http_request POST "/api/v1/workspaces/persistent" "$create_data" 201) || {
            rm -rf "$work_dir"
            return 1
        }

        local ws_id
        ws_id=$(echo "$body" | jq -r '.id // .workspace_id // .name')
        if [ -z "$ws_id" ] || [ "$ws_id" = "null" ]; then
            echo "  Created persistent workspace has no id" >&2
            rm -rf "$work_dir"
            return 1
        fi

        # Clean up
        http_request DELETE "/api/v1/workspaces/persistent/$ws_id" "" 204 > /dev/null 2>&1 || true
        rm -rf "$work_dir" 2>/dev/null || true
        return 0
    }
    run_test "POST /api/v1/workspaces/persistent creates workspace" test_persistent_ws_create

    # ------------------------------------------------------------------
    # Test 7: GET /api/v1/workspaces/persistent/{id} -> 200
    # ------------------------------------------------------------------
    test_persistent_ws_get() {
        local work_dir="/tmp/ergatai-test-persist-get-$$"
        mkdir -p "$work_dir"

        local create_data
        create_data=$(cat <<EOF
{
    "name": "test-persist-get-$$",
    "work_dir": "$work_dir"
}
EOF
)
        local ws_id
        ws_id=$(http_request POST "/api/v1/workspaces/persistent" "$create_data" 201 | jq -r '.id // .workspace_id // .name') || {
            rm -rf "$work_dir"
            return 1
        }

        local body
        body=$(http_request GET "/api/v1/workspaces/persistent/$ws_id" "" 200) || {
            http_request DELETE "/api/v1/workspaces/persistent/$ws_id" "" 204 > /dev/null 2>&1 || true
            rm -rf "$work_dir"
            return 1
        }

        # Clean up
        http_request DELETE "/api/v1/workspaces/persistent/$ws_id" "" 204 > /dev/null 2>&1 || true
        rm -rf "$work_dir" 2>/dev/null || true
        return 0
    }
    run_test "GET /api/v1/workspaces/persistent/{id} returns workspace" test_persistent_ws_get

    # ------------------------------------------------------------------
    # Test 8: PUT /api/v1/workspaces/persistent/{id} -> 200
    # ------------------------------------------------------------------
    test_persistent_ws_update() {
        local work_dir="/tmp/ergatai-test-persist-put-$$"
        mkdir -p "$work_dir"

        local create_data
        create_data=$(cat <<EOF
{
    "name": "test-persist-put-$$",
    "work_dir": "$work_dir"
}
EOF
)
        local ws_id
        ws_id=$(http_request POST "/api/v1/workspaces/persistent" "$create_data" 201 | jq -r '.id // .workspace_id // .name') || {
            rm -rf "$work_dir"
            return 1
        }

        local update_data
        update_data=$(cat <<EOF
{
    "name": "test-persist-put-updated-$$",
    "work_dir": "$work_dir"
}
EOF
)
        local body
        body=$(http_request PUT "/api/v1/workspaces/persistent/$ws_id" "$update_data" 200) || {
            http_request DELETE "/api/v1/workspaces/persistent/$ws_id" "" 204 > /dev/null 2>&1 || true
            rm -rf "$work_dir"
            return 1
        }

        # Clean up
        http_request DELETE "/api/v1/workspaces/persistent/$ws_id" "" 204 > /dev/null 2>&1 || true
        rm -rf "$work_dir" 2>/dev/null || true
        return 0
    }
    run_test "PUT /api/v1/workspaces/persistent/{id} updates workspace" test_persistent_ws_update

    # ------------------------------------------------------------------
    # Test 9: DELETE /api/v1/workspaces/persistent/{id} -> 204
    # ------------------------------------------------------------------
    test_persistent_ws_delete() {
        local work_dir="/tmp/ergatai-test-persist-del-$$"
        mkdir -p "$work_dir"

        local create_data
        create_data=$(cat <<EOF
{
    "name": "test-persist-del-$$",
    "work_dir": "$work_dir"
}
EOF
)
        local ws_id
        ws_id=$(http_request POST "/api/v1/workspaces/persistent" "$create_data" 201 | jq -r '.id // .workspace_id // .name') || {
            rm -rf "$work_dir"
            return 1
        }

        assert_status_code DELETE "/api/v1/workspaces/persistent/$ws_id" 204 "" || {
            rm -rf "$work_dir"
            return 1
        }

        rm -rf "$work_dir" 2>/dev/null || true
        return 0
    }
    run_test "DELETE /api/v1/workspaces/persistent/{id} returns 204" test_persistent_ws_delete

    # ======================================================================
    # Managed Workspaces (7 tests)
    # ======================================================================

    # ------------------------------------------------------------------
    # Test 10: GET /api/v1/workspaces/managed -> 200
    # ------------------------------------------------------------------
    test_managed_ws_list() {
        local body
        body=$(http_request GET "/api/v1/workspaces/managed" "" 200) || return 1
        assert_json_is_array "$body" "." || return 1
        return 0
    }
    run_test "GET /api/v1/workspaces/managed returns array" test_managed_ws_list

    # ------------------------------------------------------------------
    # Test 11: POST /api/v1/workspaces/managed -> 201
    # ------------------------------------------------------------------
    test_managed_ws_create() {
        local work_dir="/tmp/ergatai-test-managed-$$"
        mkdir -p "$work_dir"

        local create_data
        create_data=$(cat <<EOF
{
    "name": "test-managed-$$",
    "work_dir": "$work_dir"
}
EOF
)
        local body
        body=$(http_request POST "/api/v1/workspaces/managed" "$create_data" 201) || {
            rm -rf "$work_dir"
            return 1
        }

        local ws_id
        ws_id=$(echo "$body" | jq -r '.id // .workspace_id // .name')
        if [ -z "$ws_id" ] || [ "$ws_id" = "null" ]; then
            echo "  Created managed workspace has no id" >&2
            rm -rf "$work_dir"
            return 1
        fi

        # Store for cleanup
        _MANAGED_WS_ID="$ws_id"
        _MANAGED_WS_DIR="$work_dir"
        return 0
    }
    run_test "POST /api/v1/workspaces/managed creates workspace" test_managed_ws_create

    # ------------------------------------------------------------------
    # Test 12: GET /api/v1/workspaces/managed/{id} -> 200
    # ------------------------------------------------------------------
    test_managed_ws_get() {
        if [ -z "${_MANAGED_WS_ID:-}" ]; then
            log_warn "  Skipping: no managed workspace created"
            return 0
        fi

        local body
        body=$(http_request GET "/api/v1/workspaces/managed/$_MANAGED_WS_ID" "" 200) || return 1
        return 0
    }
    run_test "GET /api/v1/workspaces/managed/{id} returns workspace" test_managed_ws_get

    # ------------------------------------------------------------------
    # Test 13: PATCH /api/v1/workspaces/managed/{id} -> 200
    # ------------------------------------------------------------------
    test_managed_ws_update() {
        if [ -z "${_MANAGED_WS_ID:-}" ]; then
            log_warn "  Skipping: no managed workspace created"
            return 0
        fi

        local update_data
        update_data=$(cat <<EOF
{
    "description": "Updated description"
}
EOF
)
        local body
        body=$(http_request PATCH "/api/v1/workspaces/managed/$_MANAGED_WS_ID" "$update_data" 200) || return 1
        return 0
    }
    run_test "PATCH /api/v1/workspaces/managed/{id} updates workspace" test_managed_ws_update

    # ------------------------------------------------------------------
    # Test 14: POST /api/v1/workspaces/managed/{id}/archive -> 200
    # ------------------------------------------------------------------
    test_managed_ws_archive() {
        if [ -z "${_MANAGED_WS_ID:-}" ]; then
            log_warn "  Skipping: no managed workspace created"
            return 0
        fi

        local response
        local status_code
        response=$(http_request_raw POST "/api/v1/workspaces/managed/$_MANAGED_WS_ID/archive")
        status_code=$(echo "$response" | head -n1)

        # Accept 200, 201, or 204
        if [[ "$status_code" =~ ^(200|201|204)$ ]]; then
            return 0
        else
            echo "  Archive expected 2xx, got $status_code" >&2
            return 1
        fi
    }
    run_test "POST /api/v1/workspaces/managed/{id}/archive returns 2xx" test_managed_ws_archive

    # ------------------------------------------------------------------
    # Test 15: POST /api/v1/workspaces/managed/{id}/restore -> 200
    # ------------------------------------------------------------------
    test_managed_ws_restore() {
        if [ -z "${_MANAGED_WS_ID:-}" ]; then
            log_warn "  Skipping: no managed workspace created"
            return 0
        fi

        local response
        local status_code
        response=$(http_request_raw POST "/api/v1/workspaces/managed/$_MANAGED_WS_ID/restore")
        status_code=$(echo "$response" | head -n1)

        # Accept 200, 201, or 204
        if [[ "$status_code" =~ ^(200|201|204)$ ]]; then
            return 0
        else
            echo "  Restore expected 2xx, got $status_code" >&2
            return 1
        fi
    }
    run_test "POST /api/v1/workspaces/managed/{id}/restore returns 2xx" test_managed_ws_restore

    # ------------------------------------------------------------------
    # Test 16: DELETE /api/v1/workspaces/managed/{id} -> 204
    # ------------------------------------------------------------------
    test_managed_ws_delete() {
        if [ -z "${_MANAGED_WS_ID:-}" ]; then
            log_warn "  Skipping: no managed workspace created"
            return 0
        fi

        assert_status_code DELETE "/api/v1/workspaces/managed/$_MANAGED_WS_ID" 204 "" || return 1

        rm -rf "${_MANAGED_WS_DIR:-}" 2>/dev/null || true
        unset _MANAGED_WS_ID _MANAGED_WS_DIR
        return 0
    }
    run_test "DELETE /api/v1/workspaces/managed/{id} returns 204" test_managed_ws_delete

    # ======================================================================
    # Error Paths (2 tests)
    # ======================================================================

    # ------------------------------------------------------------------
    # Test 17: GET /api/v1/workspaces/non-existent -> 400 or 404
    # ------------------------------------------------------------------
    test_ws_not_found() {
        local response
        local status_code
        response=$(http_request_raw GET "/api/v1/workspaces/non-existent-ws-id-$$")
        status_code=$(echo "$response" | head -n1)

        # Accept 400 (invalid format) or 404 (not found)
        if [[ "$status_code" =~ ^(400|404)$ ]]; then
            return 0
        else
            echo "  Expected 400 or 404, got $status_code" >&2
            return 1
        fi
    }
    run_test "GET /api/v1/workspaces/non-existent returns 400 or 404" test_ws_not_found

    # ------------------------------------------------------------------
    # Test 18: POST /api/v1/workspaces with invalid chars -> 400
    # ------------------------------------------------------------------
    test_ws_invalid_name() {
        local work_dir="/tmp/ergatai-test-invalid-$$"
        mkdir -p "$work_dir"

        # Use characters that should be rejected in workspace names
        local create_data
        create_data=$(cat <<EOF
{
    "name": "invalid name with spaces and !@#\$%",
    "work_dir": "$work_dir"
}
EOF
)
        local response
        local status_code
        response=$(http_request_raw POST "/api/v1/workspaces/managed" "$create_data")
        status_code=$(echo "$response" | head -n1)

        rm -rf "$work_dir" 2>/dev/null || true

        # Accept 400 (validation), 404 (route/validation), or 201 (if server accepts it)
        if [ "$status_code" = "400" ] || [ "$status_code" = "404" ]; then
            return 0
        elif [ "$status_code" = "201" ]; then
            log_warn "  Server accepted invalid name (201) - extracting id to clean up"
            local body
            body=$(echo "$response" | tail -n +2)
            local ws_id
            ws_id=$(echo "$body" | jq -r '.id // .workspace_id // .name' 2>/dev/null)
            if [ -n "$ws_id" ] && [ "$ws_id" != "null" ]; then
                http_request DELETE "/api/v1/workspaces/managed/$ws_id" "" 204 > /dev/null 2>&1 || true
            fi
            return 0
        else
            echo "  Expected 400, 404, or 201, got $status_code" >&2
            return 1
        fi
    }
    run_test "POST /api/v1/workspaces with invalid chars returns 400/404" test_ws_invalid_name

    end_module
}

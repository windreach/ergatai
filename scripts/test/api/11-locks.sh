#!/usr/bin/env bash
# Test module 11: File lock endpoints
# Tests lock status, audit, and contention endpoints

run_module_tests() {
    start_module "File Lock Endpoints"

    # Test 1: GET /api/v1/locks -> 200, verify JSON array
    test_list_locks() {
        local body
        body=$(http_request GET "/api/v1/locks" "" 200) || return 1

        # Verify response is valid JSON
        if ! echo "$body" | jq . > /dev/null 2>&1; then
            echo "  Locks endpoint did not return valid JSON" >&2
            return 1
        fi

        # Verify it's an array or has an array field
        local is_array
        is_array=$(echo "$body" | jq -r 'if type == "array" then "yes" elif .locks and (.locks | type == "array") then "yes" else "no" end' 2>/dev/null)

        if [ "$is_array" != "yes" ]; then
            echo "  Expected array or object with locks array field" >&2
            return 1
        fi

        return 0
    }
    run_test "GET /api/v1/locks returns 200 with lock data" test_list_locks

    # Test 2: GET /api/v1/locks/audit -> 200
    test_list_audit() {
        local body
        body=$(http_request GET "/api/v1/locks/audit" "" 200) || return 1

        # Verify response is valid JSON
        if ! echo "$body" | jq . > /dev/null 2>&1; then
            echo "  Audit endpoint did not return valid JSON" >&2
            return 1
        fi

        return 0
    }
    run_test "GET /api/v1/locks/audit returns 200 with audit data" test_list_audit

    # Test 3: GET /api/v1/locks/contention -> 200
    test_get_contention() {
        local body
        body=$(http_request GET "/api/v1/locks/contention" "" 200) || return 1

        # Verify response is valid JSON
        if ! echo "$body" | jq . > /dev/null 2>&1; then
            echo "  Contention endpoint did not return valid JSON" >&2
            return 1
        fi

        return 0
    }
    run_test "GET /api/v1/locks/contention returns 200 with contention data" test_get_contention

    end_module
}

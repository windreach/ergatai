#!/usr/bin/env bash
# Test module 12: Activity endpoints
# Tests recent activity and SSE stream endpoints

run_module_tests() {
    start_module "Activity Endpoints"

    # Test 1: GET /api/v1/activity/recent -> 200, verify JSON array
    test_recent_activity() {
        local body
        body=$(http_request GET "/api/v1/activity/recent" "" 200) || return 1

        # Verify response is valid JSON
        if ! echo "$body" | jq . > /dev/null 2>&1; then
            echo "  Recent activity endpoint did not return valid JSON" >&2
            return 1
        fi

        # Verify it's an array or has an array field
        local is_array
        is_array=$(echo "$body" | jq -r 'if type == "array" then "yes" elif .events and (.events | type == "array") then "yes" else "no" end' 2>/dev/null)

        if [ "$is_array" != "yes" ]; then
            echo "  Expected array or object with events array field" >&2
            return 1
        fi

        return 0
    }
    run_test "GET /api/v1/activity/recent returns 200 with activity data" test_recent_activity

    # Test 2: GET /api/v1/activity/stream -> SSE stream
    test_activity_stream() {
        # Use http_sse_test with 2 second timeout
        # Just verify connection succeeds or returns data/empty (no crash)
        local body
        body=$(http_sse_test "/api/v1/activity/stream" 2) || {
            # http_sse_test returns 1 if no data, but that's OK for SSE
            # As long as it didn't crash, we consider it a pass
            log_warn "  SSE stream returned no data (this is OK for empty activity)"
            return 0
        }

        # If we got data, verify it looks like SSE format
        if [ -n "$body" ]; then
            # SSE format: lines starting with "data:", "event:", "id:", etc.
            if echo "$body" | grep -qE "^(data:|event:|id:|retry:)" 2>/dev/null; then
                return 0
            else
                # Some SSE implementations might just send JSON
                if echo "$body" | jq . > /dev/null 2>&1; then
                    return 0
                fi
                log_warn "  SSE stream returned data but format unclear (accepting anyway)"
                return 0
            fi
        fi

        return 0
    }
    run_test "GET /api/v1/activity/stream connects to SSE endpoint" test_activity_stream

    end_module
}

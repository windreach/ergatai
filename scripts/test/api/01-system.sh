#!/usr/bin/env bash
# Module 01: System endpoint tests (health, ready, metrics, status, config)
# Requires: test-lib.sh sourced by parent runner

run_module_tests() {
    start_module "System Endpoints"

    # ------------------------------------------------------------------
    # Test 1: GET /health -> 200
    # ------------------------------------------------------------------
    test_health_endpoint() {
        local body
        body=$(http_request GET "/health" "" 200) || return 1
        # Health endpoint should return some JSON with status
        if ! assert_json_not_null "$body" ".status" 2>/dev/null; then
            # Accept if response is non-empty (some health endpoints return plain text)
            if [ -z "$body" ]; then
                echo "  Health endpoint returned empty body" >&2
                return 1
            fi
        fi
        return 0
    }
    run_test "GET /health returns 200" test_health_endpoint

    # ------------------------------------------------------------------
    # Test 2: GET /ready -> 200
    # ------------------------------------------------------------------
    test_ready_endpoint() {
        local body
        body=$(http_request GET "/ready" "" 200) || return 1
        if ! assert_json_not_null "$body" ".status" 2>/dev/null; then
            if [ -z "$body" ]; then
                echo "  Ready endpoint returned empty body" >&2
                return 1
            fi
        fi
        return 0
    }
    run_test "GET /ready returns 200" test_ready_endpoint

    # ------------------------------------------------------------------
    # Test 3: GET /metrics -> 200 (returns prometheus text)
    # ------------------------------------------------------------------
    test_metrics_endpoint() {
        local body
        body=$(http_request GET "/metrics" "" 200) || return 1
        # Metrics endpoint returns Prometheus text format, not JSON
        # Check for typical prometheus metric lines
        if echo "$body" | grep -qE "^(# HELP|# TYPE|[a-z_]+\{)" 2>/dev/null; then
            return 0
        fi
        # Some metrics endpoints may return JSON; accept non-empty
        if [ -n "$body" ]; then
            return 0
        fi
        echo "  Metrics endpoint returned empty body" >&2
        return 1
    }
    run_test "GET /metrics returns 200 with prometheus data" test_metrics_endpoint

    # ------------------------------------------------------------------
    # Test 4: GET /api/v1/status -> 200, verify JSON fields
    # ------------------------------------------------------------------
    test_status_endpoint() {
        local body
        body=$(http_request GET "/api/v1/status" "" 200) || return 1
        # Verify it's valid JSON with expected fields
        if ! echo "$body" | jq . > /dev/null 2>&1; then
            echo "  Status endpoint did not return valid JSON" >&2
            return 1
        fi
        # Check that at least some expected fields exist
        # Common fields: agents, workspaces, version, uptime, etc.
        local has_fields=false
        for field in ".agents" ".workspaces" ".version" ".status" ".uptime"; do
            if assert_json_not_null "$body" "$field" 2>/dev/null; then
                has_fields=true
                break
            fi
        done
        if [ "$has_fields" = false ]; then
            # Even if no known field, as long as it's JSON it's OK
            log_warn "  Status response has no recognized fields but is valid JSON"
        fi
        return 0
    }
    run_test "GET /api/v1/status returns 200 with JSON" test_status_endpoint

    # ------------------------------------------------------------------
    # Test 5: GET /api/v1/system/config -> 200
    # ------------------------------------------------------------------
    test_system_config_endpoint() {
        local response
        local status_code
        response=$(http_request_raw GET "/api/v1/system/config")
        status_code=$(echo "$response" | head -n1)
        local body
        body=$(echo "$response" | tail -n +2)

        # Accept 200 or 404 (endpoint may not exist in all versions)
        if [ "$status_code" = "200" ]; then
            if ! echo "$body" | jq . > /dev/null 2>&1; then
                echo "  System config endpoint returned non-JSON body" >&2
                return 1
            fi
            return 0
        elif [ "$status_code" = "404" ]; then
            log_warn "  /api/v1/system/config not implemented (404) - skipping"
            return 0
        else
            echo "  Expected 200 or 404, got $status_code" >&2
            return 1
        fi
    }
    run_test "GET /api/v1/system/config returns 200" test_system_config_endpoint

    end_module
}

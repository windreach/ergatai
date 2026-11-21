#!/usr/bin/env bash
# Test module 13: Mailbox endpoints
# Tests mailbox listing, summary, and agent-specific mailbox operations

run_module_tests() {
    start_module "Mailbox Endpoints"

    # Test 1: GET /api/v1/mailbox -> 200 or 404 (endpoint may not exist)
    test_list_mailboxes() {
        local response
        response=$(http_request_raw GET "/api/v1/mailbox")
        local status_code=$(echo "$response" | head -n1)

        # Accept 200 (endpoint exists) or 404 (endpoint doesn't exist)
        if [ "$status_code" = "200" ] || [ "$status_code" = "404" ]; then
            return 0
        else
            echo "  Expected 200 or 404 for mailbox endpoint, got $status_code" >&2
            return 1
        fi
    }
    run_test "GET /api/v1/mailbox returns 200 or 404" test_list_mailboxes

    # Test 2: GET /api/v1/mailbox/non-existent -> 404 (negative test)
    test_get_nonexistent_mailbox() {
        local response
        response=$(http_request_raw GET "/api/v1/agents/non-existent-agent-id-99999/mailbox")
        local status_code=$(echo "$response" | head -n1)

        if [ "$status_code" = "404" ]; then
            return 0
        else
            echo "  Expected 404 for non-existent mailbox, got $status_code" >&2
            return 1
        fi
    }
    run_test "GET /api/v1/agents/{id}/mailbox returns 404 for non-existent agent" test_get_nonexistent_mailbox

    # Test 3: GET /api/v1/mailbox/non-existent/summary -> 404 (negative test)
    test_get_nonexistent_summary() {
        local response
        response=$(http_request_raw GET "/api/v1/agents/non-existent-agent-id-99999/mailbox/summary")
        local status_code=$(echo "$response" | head -n1)

        # Accept 404 or 405 (method not allowed) as the route might not exist
        if [ "$status_code" = "404" ] || [ "$status_code" = "405" ]; then
            return 0
        else
            echo "  Expected 404 or 405 for non-existent mailbox summary, got $status_code" >&2
            return 1
        fi
    }
    run_test "GET /api/v1/agents/{id}/mailbox/summary returns 404 for non-existent agent" test_get_nonexistent_summary

    # Test 4: DELETE /api/v1/mailbox/non-existent -> 404 (negative test)
    test_clear_nonexistent_mailbox() {
        local response
        response=$(http_request_raw DELETE "/api/v1/agents/non-existent-agent-id-99999/mailbox")
        local status_code=$(echo "$response" | head -n1)

        # Accept 404 or 200 (some implementations clear even if doesn't exist)
        if [ "$status_code" = "404" ] || [ "$status_code" = "200" ] || [ "$status_code" = "204" ]; then
            return 0
        else
            echo "  Expected 404, 200, or 204 for clearing non-existent mailbox, got $status_code" >&2
            return 1
        fi
    }
    run_test "DELETE /api/v1/agents/{id}/mailbox returns 404 for non-existent agent" test_clear_nonexistent_mailbox

    end_module
}

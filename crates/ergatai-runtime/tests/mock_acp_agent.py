#!/usr/bin/env python3
"""
Mock ACP agent for testing AcpBackend.

Speaks ACP JSON-RPC over stdio (newline-delimited JSON).
Handles: initialize, session/new, session/prompt.
"""
import json
import sys
import uuid

def send_response(msg):
    """Write a JSON-RPC response to stdout."""
    line = json.dumps(msg) + "\n"
    sys.stdout.write(line)
    sys.stdout.flush()

def main():
    session_id = None

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue

        method = request.get("method", "")
        req_id = request.get("id")
        params = request.get("params", {})

        if method == "initialize":
            send_response({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": 1,
                    "agentInfo": {
                        "name": "mock-acp-agent",
                        "version": "0.1.0"
                    },
                    "agentCapabilities": {}
                }
            })

        elif method == "session/new":
            session_id = str(uuid.uuid4())
            send_response({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "sessionId": session_id
                }
            })

        elif method == "session/prompt":
            # ACP SDK sends prompt content as "prompt" field (not "content")
            content_blocks = params.get("prompt", [])
            prompt_text = ""
            for block in content_blocks:
                if block.get("type") == "text":
                    prompt_text += block.get("text", "")

            # SessionNotification: uses "sessionUpdate" tag (not "type")
            send_response({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": session_id,
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {
                            "type": "text",
                            "text": f"Mock response to: {prompt_text}"
                        }
                    }
                }
            })

            send_response({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "stopReason": "end_turn"
                }
            })

        elif method == "shutdown":
            send_response({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {}
            })
            break

if __name__ == "__main__":
    main()

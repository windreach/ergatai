#!/bin/bash
# Test headless ACP agent with ergatai

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Ergatai Headless ACP Agent Test ===${NC}"

# Check if API server is running
if ! curl -s http://localhost:3000/health > /dev/null 2>&1; then
    echo -e "${BLUE}Starting API server...${NC}"
    cargo run -p ergatai-api -- --port 3000 --verbose &
    API_PID=$!
    sleep 3
    echo -e "${GREEN}API server started (PID: $API_PID)${NC}"
else
    echo -e "${GREEN}API server already running${NC}"
fi

# Wait for server to be ready
echo -e "${BLUE}Waiting for server...${NC}"
for i in {1..10}; do
    if curl -s http://localhost:3000/health > /dev/null 2>&1; then
        break
    fi
    sleep 1
done

# Create a test workspace
echo -e "${BLUE}Creating workspace...${NC}"
WORKSPACE_RESPONSE=$(curl -s -X POST http://localhost:3000/api/v1/workspaces \
    -H "Content-Type: application/json" \
    -d '{
        "id": "test-ws-1",
        "work_dir": "/tmp/ergatai-test",
        "env": {}
    }')
echo -e "${GREEN}Workspace created: $WORKSPACE_RESPONSE${NC}"

# Start a Claude ACP agent
echo -e "${BLUE}Starting Claude ACP agent...${NC}"
AGENT_RESPONSE=$(curl -s -X POST http://localhost:3000/api/v1/agents \
    -H "Content-Type: application/json" \
    -d '{
        "workspace_id": "test-ws-1",
        "command": "npx -y @agentclientprotocol/claude-agent-acp@latest",
        "instruction": "Read CLAUDE.md if it exists, then wait for instructions."
    }')
echo -e "${GREEN}Agent started: $AGENT_RESPONSE${NC}"

# Extract agent ID
AGENT_ID=$(echo $AGENT_RESPONSE | grep -o '"agent_id":"[^"]*"' | cut -d'"' -f4)
if [ -z "$AGENT_ID" ]; then
    echo "Failed to extract agent ID from response"
    exit 1
fi

echo -e "${GREEN}Agent ID: $AGENT_ID${NC}"

# Wait for agent to initialize
echo -e "${BLUE}Waiting for agent to initialize...${NC}"
sleep 5

# Check agent status
echo -e "${BLUE}Checking agent status...${NC}"
curl -s http://localhost:3000/api/v1/agents | jq '.'

# Send a test message via MCP or REST API
echo -e "${BLUE}Sending test message...${NC}"
MESSAGE_RESPONSE=$(curl -s -X POST "http://localhost:3000/api/v1/agents/$AGENT_ID/message" \
    -H "Content-Type: application/json" \
    -d '{
        "message": "Hello! Please respond with a simple greeting."
    }')
echo -e "${GREEN}Message sent: $MESSAGE_RESPONSE${NC}"

# Wait for response
echo -e "${BLUE}Waiting for agent response...${NC}"
sleep 10

# Check system status
echo -e "${BLUE}System status:${NC}"
curl -s http://localhost:3000/api/v1/status | jq '.'

echo -e "${GREEN}=== Test complete ===${NC}"
echo ""
echo "To cleanup:"
echo "  curl -X DELETE http://localhost:3000/api/v1/agents/$AGENT_ID"
echo "  curl -X DELETE http://localhost:3000/api/v1/workspaces/test-ws-1"
echo ""
echo "To stop server:"
if [ -n "$API_PID" ]; then
    echo "  kill $API_PID"
else
    echo "  (server was already running, not started by this script)"
fi

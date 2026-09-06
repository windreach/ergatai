#!/bin/bash
# ACP Adapters 快速配置脚本

set -e

echo "🔧 Ergatai ACP Adapters 配置"
echo "================================"
echo ""

# 检查 Node.js 版本
NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
echo "📋 Node.js 版本: $(node --version)"

if [ "$NODE_VERSION" -lt 20 ]; then
    echo "⚠️  警告: Node.js 版本过低，建议 >= 20"
    echo "   Claude adapter 需要 Node.js >= 22"
fi
echo ""

# 检查适配器目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_DIR="$SCRIPT_DIR/codex-acp"
CLAUDE_DIR="$SCRIPT_DIR/claude-agent-acp"

# 配置 Codex Adapter
if [ -d "$CODEX_DIR" ]; then
    echo "✅ Codex Adapter 已安装"
    echo "   位置: $CODEX_DIR"

    if [ -f "$CODEX_DIR/dist/index.js" ]; then
        echo "   构建: ✅ 已构建"
    else
        echo "   构建: ⏳ 正在构建..."
        cd "$CODEX_DIR"
        npm install --silent
        npm run build --silent
        echo "   构建: ✅ 完成"
    fi

    # 测试启动
    echo "   测试: 启动命令..."
    echo "   node $CODEX_DIR/dist/index.js"
    echo ""
else
    echo "❌ Codex Adapter 未找到"
    echo "   克隆: git clone https://github.com/agentclientprotocol/codex-acp.git"
fi

# 配置 Claude Adapter
if [ -d "$CLAUDE_DIR" ]; then
    echo "✅ Claude Adapter 已安装"
    echo "   位置: $CLAUDE_DIR"

    if [ -f "$CLAUDE_DIR/dist/acp-agent.js" ]; then
        echo "   构建: ✅ 已构建"
    else
        echo "   构建: ⏳ 正在构建..."
        cd "$CLAUDE_DIR"
        npm install --silent
        npm run build --silent
        echo "   构建: ✅ 完成"
    fi

    # 测试启动
    echo "   测试: 启动命令..."
    echo "   node $CLAUDE_DIR/dist/acp-agent.js"
    echo ""
else
    echo "❌ Claude Adapter 未找到"
    echo "   克隆: git clone https://github.com/zed-industries/claude-agent-acp.git"
fi

echo "================================"
echo "📚 使用文档: adapters/README.md"
echo ""
echo "🚀 快速开始:"
echo ""
echo "1. 启动 Ergatai API 服务器:"
echo "   cargo run -p ergatai-api -- --port 3000"
echo ""
echo "2. 创建 workspace:"
echo "   ergatai workspace create my-project"
echo ""
echo "3. 启动 Codex agent:"
echo "   export CODEX_API_KEY=your-key"
echo "   ergatai agent spawn my-project \\"
echo "     --command \"node $CODEX_DIR/dist/index.js\" \\"
echo "     --instruction \"Hello Codex!\""
echo ""
echo "4. 启动 Claude agent:"
echo "   export ANTHROPIC_API_KEY=your-key"
echo "   ergatai agent spawn my-project \\"
echo "     --command \"node $CLAUDE_DIR/dist/acp-agent.js\" \\"
echo "     --instruction \"Hello Claude!\""
echo ""
echo "✅ 配置完成！"

#!/bin/bash
# OpenAPI 文档生成和测试工具

set -e

API_URL="http://localhost:3000"
OPENAPI_FILE="openapi.json"

echo "🔧 Ergatai OpenAPI 工具集"
echo "========================"
echo

# 检查服务器是否运行
check_server() {
    if curl -s -f "$API_URL/health" > /dev/null 2>&1; then
        echo "✅ API 服务器正在运行"
        return 0
    else
        echo "❌ API 服务器未运行"
        echo "   请先启动: cargo run -p ergatai-api -- --port 3000"
        return 1
    fi
}

# 生成 OpenAPI JSON
generate_spec() {
    echo "📄 生成 OpenAPI 规范..."
    if ! check_server; then
        exit 1
    fi

    curl -s "$API_URL/api/v1/openapi.json" | jq '.' > "$OPENAPI_FILE"
    echo "✅ OpenAPI 规范已保存到: $OPENAPI_FILE"

    # 显示统计
    local paths=$(jq '.paths | length' "$OPENAPI_FILE")
    local schemas=$(jq '.components.schemas | length' "$OPENAPI_FILE")
    echo "   - 端点数: $paths"
    echo "   - Schema 数: $schemas"
}

# 启动 Swagger UI (使用 Docker)
swagger_ui() {
    echo "🎨 启动 Swagger UI..."

    if ! command -v docker &> /dev/null; then
        echo "❌ 需要安装 Docker"
        exit 1
    fi

    if [ ! -f "$OPENAPI_FILE" ]; then
        generate_spec
    fi

    # 获取绝对路径
    local abs_path=$(realpath "$OPENAPI_FILE")
    local dir=$(dirname "$abs_path")
    local file=$(basename "$abs_path")

    echo "📖 Swagger UI 将在 http://localhost:8080 启动"
    echo "   按 Ctrl+C 停止"

    docker run --rm -p 8080:8080 \
        -e SWAGGER_JSON=/spec/$file \
        -v "$dir":/spec \
        swaggerapi/swagger-ui
}

# 使用 Redoc 生成静态 HTML
generate_html() {
    echo "📚 生成 HTML 文档..."

    if [ ! -f "$OPENAPI_FILE" ]; then
        generate_spec
    fi

    local html_file="api-docs.html"

    cat > "$html_file" <<EOF
<!DOCTYPE html>
<html>
<head>
    <title>Ergatai API 文档</title>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link href="https://fonts.googleapis.com/css?family=Montserrat:300,400,700|Roboto:300,400,700" rel="stylesheet">
    <style>
        body { margin: 0; padding: 0; }
    </style>
</head>
<body>
    <redoc spec-url='$OPENAPI_FILE'></redoc>
    <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
</body>
</html>
EOF

    echo "✅ HTML 文档已生成: $html_file"
    echo "   在浏览器中打开此文件查看文档"
}

# 验证 OpenAPI 规范
validate_spec() {
    echo "🔍 验证 OpenAPI 规范..."

    if [ ! -f "$OPENAPI_FILE" ]; then
        generate_spec
    fi

    # 使用 swagger-cli 验证（如果安装）
    if command -v swagger-cli &> /dev/null; then
        swagger-cli validate "$OPENAPI_FILE"
        echo "✅ OpenAPI 规范有效"
    else
        echo "⚠️  未安装 swagger-cli，跳过验证"
        echo "   安装: npm install -g @apidevtools/swagger-cli"
    fi
}

# 生成测试用例
generate_tests() {
    echo "🧪 生成测试用例..."

    if [ ! -f "$OPENAPI_FILE" ]; then
        generate_spec
    fi

    if command -v openapi-generator-cli &> /dev/null; then
        openapi-generator-cli generate \
            -i "$OPENAPI_FILE" \
            -g rust \
            -o ./generated-tests \
            --additional-properties=library=reqwest,packageName=ergatai_test_client

        echo "✅ 测试客户端已生成到: ./generated-tests"
    else
        echo "⚠️  未安装 openapi-generator-cli"
        echo "   安装: npm install @openapitools/openapi-generator-cli -g"
        echo
        echo "   或者使用 Prism 进行 Mock 测试:"
        echo "   npx @stoplight/prism-cli mock $OPENAPI_FILE"
    fi
}

# 显示帮助
show_help() {
    echo "用法: $0 <命令>"
    echo
    echo "命令:"
    echo "  generate    - 生成 OpenAPI JSON 规范"
    echo "  swagger     - 启动 Swagger UI (需要 Docker)"
    echo "  html        - 生成静态 HTML 文档"
    echo "  validate    - 验证 OpenAPI 规范"
    echo "  tests       - 生成测试客户端代码"
    echo "  help        - 显示此帮助信息"
    echo
    echo "示例:"
    echo "  $0 generate    # 生成 openapi.json"
    echo "  $0 swagger     # 启动 Swagger UI"
    echo "  $0 html        # 生成 HTML 文档"
}

# 主逻辑
case "${1:-help}" in
    generate)
        generate_spec
        ;;
    swagger)
        swagger_ui
        ;;
    html)
        generate_html
        ;;
    validate)
        validate_spec
        ;;
    tests)
        generate_tests
        ;;
    help|*)
        show_help
        ;;
esac

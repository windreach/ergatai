#!/bin/bash
# ACP Adapters 更新管理器

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADAPTERS_DIR="$SCRIPT_DIR"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}ℹ${NC} $1"; }
log_success() { echo -e "${GREEN}✓${NC} $1"; }
log_warning() { echo -e "${YELLOW}⚠${NC} $1"; }
log_error() { echo -e "${RED}✗${NC} $1"; }

# 检查适配器更新
check_updates() {
    local adapter_name=$1
    local adapter_dir="$ADAPTERS_DIR/$adapter_name"

    if [ ! -d "$adapter_dir" ]; then
        log_error "$adapter_name 未安装"
        return 1
    fi

    cd "$adapter_dir"

    # 获取当前版本
    local current_version=$(git describe --tags --abbrev=0 2>/dev/null || echo "unknown")

    # 获取远程更新
    git fetch --tags --quiet 2>/dev/null

    # 获取最新版本
    local latest_version=$(git describe --tags --abbrev=0 origin/HEAD 2>/dev/null || echo "unknown")

    if [ "$current_version" != "$latest_version" ] && [ "$latest_version" != "unknown" ]; then
        log_warning "$adapter_name: $current_version → $latest_version (有更新)"
        return 2
    else
        log_success "$adapter_name: $current_version (已是最新)"
        return 0
    fi
}

# 更新适配器
update_adapter() {
    local adapter_name=$1
    local adapter_dir="$ADAPTERS_DIR/$adapter_name"

    if [ ! -d "$adapter_dir" ]; then
        log_error "$adapter_name 未安装"
        return 1
    fi

    log_info "更新 $adapter_name..."
    cd "$adapter_dir"

    # 拉取最新代码
    git pull --quiet

    # 重新安装依赖
    log_info "安装依赖..."
    npm install --silent

    # 重新构建
    log_info "构建..."
    npm run build --silent

    log_success "$adapter_name 更新完成"
}

# 检查所有适配器
check_all() {
    log_info "检查所有适配器更新..."
    echo ""

    local needs_update=()

    for adapter_dir in "$ADAPTERS_DIR"/*/; do
        if [ -d "$adapter_dir" ] && [ -f "$adapter_dir/package.json" ]; then
            local adapter_name=$(basename "$adapter_dir")
            check_updates "$adapter_name"
            local result=$?
            if [ $result -eq 2 ]; then
                needs_update+=("$adapter_name")
            fi
        fi
    done

    echo ""
    if [ ${#needs_update[@]} -eq 0 ]; then
        log_success "所有适配器都是最新版本"
    else
        log_warning "以下适配器需要更新: ${needs_update[*]}"
        echo "运行: $0 update 来更新所有适配器"
    fi
}

# 更新所有适配器
update_all() {
    log_info "更新所有适配器..."
    echo ""

    for adapter_dir in "$ADAPTERS_DIR"/*/; do
        if [ -d "$adapter_dir" ] && [ -f "$adapter_dir/package.json" ]; then
            local adapter_name=$(basename "$adapter_dir")
            update_adapter "$adapter_name"
            echo ""
        fi
    done

    log_success "所有适配器更新完成"
}

# 显示帮助
show_help() {
    cat << EOF
ACP Adapters 更新管理器

用法: $0 [命令]

命令:
  check      检查所有适配器的更新
  update     更新所有适配器
  status     显示已安装的适配器状态
  help       显示此帮助信息

示例:
  $0 check           # 检查更新
  $0 update          # 更新所有适配器
  $0 status          # 查看状态

EOF
}

# 显示状态
show_status() {
    log_info "已安装的适配器:"
    echo ""

    for adapter_dir in "$ADAPTERS_DIR"/*/; do
        if [ -d "$adapter_dir" ] && [ -f "$adapter_dir/package.json" ]; then
            local adapter_name=$(basename "$adapter_dir")
            local version=$(cd "$adapter_dir" && git describe --tags --abbrev=0 2>/dev/null || echo "unknown")
            local pkg_version=$(cd "$adapter_dir" && node -p "require('./package.json').version" 2>/dev/null || echo "unknown")

            echo "  $adapter_name"
            echo "    版本: $pkg_version (git: $version)"
            echo "    位置: $adapter_dir"

            # 检查构建状态
            if ls "$adapter_dir"/dist/*.js 1> /dev/null 2>&1; then
                echo "    状态: ${GREEN}已构建${NC}"
            else
                echo "    状态: ${RED}未构建${NC}"
            fi
            echo ""
        fi
    done
}

# 主逻辑
case "${1:-check}" in
    check)
        check_all
        ;;
    update)
        update_all
        ;;
    status)
        show_status
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        log_error "未知命令: $1"
        show_help
        exit 1
        ;;
esac

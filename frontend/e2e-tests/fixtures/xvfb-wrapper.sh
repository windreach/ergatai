#!/bin/bash
# xvfb-run 包装器 - 为 Electron 提供虚拟显示环境
# 使用方式: ./xvfb-wrapper.sh [electron 参数...]

# 检查 xvfb-run 是否可用
if ! command -v xvfb-run &> /dev/null; then
    echo "❌ xvfb-run 未安装，请安装: apt-get install -y xvfb"
    exit 1
fi

# 默认配置
DISPLAY_NUM=${DISPLAY_NUM:-99}
SCREEN_RES=${SCREEN_RES:-1280x960x24}

# 使用 xvfb-run 启动
exec xvfb-run \
    --server-args="-screen 0 ${SCREEN_RES} -ac +extension GLX +render -noreset" \
    "$@"

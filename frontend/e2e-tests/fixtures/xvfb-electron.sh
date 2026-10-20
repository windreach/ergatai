#!/bin/bash
# Electron xvfb 包装器
# 用于在 Playwright 测试中启动 Electron（带虚拟显示）
#
# Playwright 会自动添加 --inspect=0 --remote-debugging-port=0 参数
# 这些参数需要传给 electron，而不是 xvfb-run
# 参数顺序可能是：
# 1. xvfb-electron.sh --inspect=0 --remote-debugging-port=0 electron_path app_args...
# 2. xvfb-electron.sh electron_path --inspect=0 --remote-debugging-port=0 app_args...

# 分离 Playwright 参数和应用参数
PLAYWRIGHT_ARGS=()
APP_ARGS=()
ELECTRON_BIN=""

# 查找 electron 可执行文件的位置
for arg in "$@"; do
  if [[ "$arg" == */electron ]] || [[ "$arg" == "electron" ]]; then
    ELECTRON_BIN="$arg"
    break
  fi
done

if [ -z "$ELECTRON_BIN" ]; then
  echo "❌ 未找到 Electron 可执行文件"
  exit 1
fi

# 分离参数
FOUND_ELECTRON=false
for arg in "$@"; do
  if [ "$FOUND_ELECTRON" = false ]; then
    if [[ "$arg" == */electron ]] || [[ "$arg" == "electron" ]]; then
      FOUND_ELECTRON=true
      continue
    fi
    # electron 之前的参数（Playwright 调试参数）
    if [[ "$arg" == --inspect* ]] || [[ "$arg" == --remote-debugging-port* ]]; then
      PLAYWRIGHT_ARGS+=("$arg")
    fi
    # 其他参数忽略（可能是脚本路径等）
  else
    # electron 之后的都是应用参数
    APP_ARGS+=("$arg")
  fi
done

# 启动 xvfb-run + electron
# 参数顺序：xvfb-run [xvfb 参数] electron [playwright 参数] [应用参数]
exec xvfb-run \
  --server-args="-screen 0 1280x960x24 -ac +extension GLX +render -noreset" \
  "$ELECTRON_BIN" \
  "${PLAYWRIGHT_ARGS[@]}" \
  "${APP_ARGS[@]}"

import { RotateCcw, Settings } from "lucide-react";
import { useAutomationConfig, type AutomationStrategy } from "../../../core/workspace/panelAutomation";

const strategies: { value: AutomationStrategy; label: string; description: string }[] = [
  { value: "smart", label: "智能模式", description: "审批自动切换；其他面板创建但不打断当前标签" },
  { value: "auto", label: "全自动模式", description: "所有事件都打开并切换到对应面板" },
  { value: "manual", label: "手动模式", description: "只显示通知，由你点击后打开面板" },
];

const toggles = [
  { key: "enableReviewAutoOpen" as const, label: "审批请求自动打开审查面板" },
  { key: "enableFilesAutoOpen" as const, label: "文件修改自动打开文件面板" },
  { key: "enableTerminalAutoOpen" as const, label: "命令执行自动打开终端面板" },
  { key: "showNotificationOnAutoOpen" as const, label: "自动化操作显示通知" },
];

export function AutomationSettingsPanel() {
  const { config, updateConfig, resetConfig } = useAutomationConfig();

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        <Settings className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-medium text-text">面板自动化</h2>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <section>
          <h3 className="mb-2 text-xs font-medium text-muted">自动化策略</h3>
          <div className="space-y-2">
            {strategies.map((strategy) => (
              <label
                key={strategy.value}
                className={`flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors ${
                  config.strategy === strategy.value
                    ? "border-primary/30 bg-primary/10"
                    : "border-border-subtle bg-bg hover:border-primary/20"
                }`}
              >
                <input
                  type="radio"
                  name="automation-strategy"
                  className="mt-1 accent-[var(--accent)]"
                  checked={config.strategy === strategy.value}
                  onChange={() => updateConfig({ strategy: strategy.value })}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-text">{strategy.label}</span>
                  <span className="block text-xs text-muted">{strategy.description}</span>
                </span>
              </label>
            ))}
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-medium text-muted">自动化开关</h3>
          <div className="rounded-lg border border-border-subtle bg-bg">
            {toggles.map((toggle) => (
              <label key={toggle.key} className="flex items-center justify-between gap-3 border-b border-border-subtle px-3 py-2 last:border-b-0">
                <span className="text-sm text-text">{toggle.label}</span>
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--accent)]"
                  checked={config[toggle.key]}
                  onChange={(event) => updateConfig({ [toggle.key]: event.target.checked })}
                />
              </label>
            ))}
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-medium text-muted">通知持续时间</h3>
          <select
            value={config.notificationDuration}
            onChange={(event) => updateConfig({ notificationDuration: Number(event.target.value) })}
            className="h-9 w-full rounded-md border border-border-subtle bg-bg px-3 text-sm text-text focus:border-primary focus:outline-none"
          >
            {[1000, 3000, 5000, 10000].map((duration) => (
              <option key={duration} value={duration}>{duration / 1000} 秒</option>
            ))}
          </select>
        </section>
      </div>

      <footer className="border-t border-border-subtle p-3">
        <button
          type="button"
          onClick={resetConfig}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-border-subtle px-3 py-2 text-xs font-medium text-text transition-colors hover:bg-bg"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          恢复推荐配置
        </button>
      </footer>
    </div>
  );
}

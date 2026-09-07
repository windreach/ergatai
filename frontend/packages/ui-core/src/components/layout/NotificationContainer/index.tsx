import { X } from "lucide-react";
import { useNotifications } from "../../../core/workspace/panelAutomation";

// 通知容器 - 显示在右上角
export function NotificationContainer() {
  const { notifications, removeNotification, openPanel } = useNotifications();

  if (notifications.length === 0) return null;

  return (
    <div className="fixed right-4 top-4 z-50 flex flex-col gap-2 max-w-sm">
      {notifications.map((notification) => (
        <div
          key={notification.id}
          className="flex items-start gap-2 rounded-lg border border-border-subtle bg-surface px-4 py-3 shadow-lg"
        >
          <div className="flex-1 min-w-0">
            <p className="text-sm text-text">{notification.message}</p>
          </div>
          <div className="flex items-center gap-1">
            {notification.panelType && (
              <button
                onClick={() => {
                  openPanel(notification.panelType!, true);
                  removeNotification(notification.id);
                }}
                className="rounded px-2 py-1 text-xs text-primary hover:bg-primary/10"
              >
                查看
              </button>
            )}
            <button
              onClick={() => removeNotification(notification.id)}
              className="text-muted hover:text-text"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

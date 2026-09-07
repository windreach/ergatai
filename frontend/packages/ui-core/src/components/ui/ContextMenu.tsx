import { useEffect, useRef, useState, type ReactNode } from "react";

export interface ContextMenuItem {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  separator?: boolean;
}

interface ContextMenuProps {
  items: ContextMenuItem[];
  children: ReactNode;
}

export function ContextMenu({ items, children }: ContextMenuProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setPosition({ x: e.clientX, y: e.clientY });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  return (
    <>
      <div onContextMenu={handleContextMenu}>{children}</div>
      {open && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[160px] rounded-md border border-border-subtle bg-surface py-1 shadow-lg"
          style={{ left: position.x, top: position.y }}
        >
          {items.map((item, index) => {
            if (item.separator) {
              return <div key={index} className="my-1 border-t border-border-subtle" />;
            }
            return (
              <button
                key={index}
                onClick={() => {
                  item.onClick();
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-bg ${
                  item.danger ? "text-red-500 hover:text-red-500" : "text-text"
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

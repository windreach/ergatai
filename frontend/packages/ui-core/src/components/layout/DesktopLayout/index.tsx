import { useRef, useState } from "react";
import { LeftPanel } from "../LeftPanel";
import { MainArea } from "../MainArea";
import { RightPanel } from "../RightPanel";
import { NotificationContainer } from "../NotificationContainer";
import { useSidebarResize } from "./useSidebarResize";

export function DesktopLayout() {
  const layoutRef = useRef<HTMLDivElement>(null);
  const [rightPanelOpen, setRightPanelOpen] = useState(() => (
    new URLSearchParams(window.location.search).has("panel")
  ));
  const [leftPanelOpen, setLeftPanelOpen] = useState(() => (
    new URLSearchParams(window.location.search).get("sidebar") !== "collapsed"
  ));
  const [leftWidth, setLeftWidth] = useState(15);
  const [rightWidth, setRightWidth] = useState(35);
  const {
    isResizing,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handleKeyDown,
  } = useSidebarResize({
    layoutRef,
    leftWidth,
    rightWidth,
    onLeftWidthChange: setLeftWidth,
    onRightWidthChange: setRightWidth,
  });

  const toggleRightPanel = () => {
    setRightPanelOpen(!rightPanelOpen);
  };

  return (
    <div ref={layoutRef} className="flex h-full w-full overflow-hidden bg-bg text-text">
      <div
        className={`h-full flex-shrink-0 overflow-hidden ${isResizing ? "" : "transition-[width,min-width] duration-300 ease-in-out"}`}
        style={{ width: leftPanelOpen ? `${leftWidth}%` : 56, minWidth: leftPanelOpen ? 180 : 56 }}
      >
        <LeftPanel isOpen={leftPanelOpen} onToggle={() => setLeftPanelOpen((open) => !open)} />
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整左侧栏宽度"
        tabIndex={0}
        onPointerDown={handlePointerDown("left")}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onKeyDown={handleKeyDown("left")}
        className="h-full w-1 flex-shrink-0 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-primary/25"
      />

      {/* Main Area - Content */}
      <MainArea />

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整右侧栏宽度"
        tabIndex={0}
        onPointerDown={handlePointerDown("right")}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onKeyDown={handleKeyDown("right")}
        className="h-full w-1 flex-shrink-0 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-primary/25"
      />

      <div
        className={`h-full flex-shrink-0 overflow-hidden ${isResizing ? "" : "transition-[width,min-width] duration-300 ease-in-out"}`}
        style={{ width: rightPanelOpen ? `${rightWidth}%` : 56, minWidth: rightPanelOpen ? 320 : 56 }}
      >
        <RightPanel isOpen={rightPanelOpen} onToggle={toggleRightPanel} />
      </div>
      {/* Notifications */}
      <NotificationContainer />
    </div>
  );
}

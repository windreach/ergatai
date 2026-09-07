import { useState } from "react";
import { LeftPanel } from "../LeftPanel";
import { MainArea } from "../MainArea";
import { RightPanel } from "../RightPanel";

export function DesktopLayout() {
  const [rightPanelOpen, setRightPanelOpen] = useState(true);

  const toggleRightPanel = () => {
    setRightPanelOpen(!rightPanelOpen);
  };

  return (
    <div className="flex h-full w-full overflow-hidden bg-bg text-text">
      {/* Left Panel - Navigation */}
      <LeftPanel />

      {/* Main Area - Content */}
      <MainArea />

      {/* Right Panel - Tools */}
      <RightPanel isOpen={rightPanelOpen} onToggle={toggleRightPanel} />
    </div>
  );
}

import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";

type SidebarSide = "left" | "right";

interface UseSidebarResizeOptions {
  layoutRef: RefObject<HTMLDivElement | null>;
  leftWidth: number;
  rightWidth: number;
  onLeftWidthChange: (width: number) => void;
  onRightWidthChange: (width: number) => void;
}

const LEFT_MIN = 10;
const LEFT_MAX = 28;
const RIGHT_MIN = 22;
const RIGHT_MAX = 48;

function clampWidth(width: number, min: number, max: number) {
  return Math.min(max, Math.max(min, width));
}

export function useSidebarResize({
  layoutRef,
  leftWidth,
  rightWidth,
  onLeftWidthChange,
  onRightWidthChange,
}: UseSidebarResizeOptions) {
  const activeSideRef = useRef<SidebarSide | null>(null);
  const [isResizing, setIsResizing] = useState(false);

  const handlePointerDown = (side: SidebarSide) => (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    activeSideRef.current = side;
    setIsResizing(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const activeSide = activeSideRef.current;
    if (!activeSide || event.buttons !== 1) return;

    const rect = layoutRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;

    if (activeSide === "left") {
      const width = ((event.clientX - rect.left) / rect.width) * 100;
      onLeftWidthChange(clampWidth(width, LEFT_MIN, LEFT_MAX));
      return;
    }

    const width = ((rect.right - event.clientX) / rect.width) * 100;
    onRightWidthChange(clampWidth(width, RIGHT_MIN, RIGHT_MAX));
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!activeSideRef.current) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    activeSideRef.current = null;
    setIsResizing(false);
  };

  const handleKeyDown = (side: SidebarSide) => (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;

    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    const delta = side === "left" ? direction : -direction;

    if (side === "left") {
      onLeftWidthChange(clampWidth(leftWidth + delta, LEFT_MIN, LEFT_MAX));
      return;
    }

    onRightWidthChange(clampWidth(rightWidth + delta, RIGHT_MIN, RIGHT_MAX));
  };

  return {
    isResizing,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handleKeyDown,
  };
}

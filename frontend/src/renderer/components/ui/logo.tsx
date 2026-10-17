import * as React from "react"
import { cn } from "../../lib/utils"
import ergataiMarkUrl from "../../assets/ergatai-mark.png"

interface LogoProps extends React.HTMLAttributes<HTMLSpanElement> {
  className?: string
  fill?: string
}

export function Logo({ fill = "currentColor", className, style, ...props }: LogoProps) {
  return (
    <span
      className={cn("w-full h-full", className)}
      role="img"
      aria-label="Ergatai logo"
      {...props}
      style={{
        ...style,
        display: "inline-block",
        backgroundColor: fill,
        maskImage: `url(${ergataiMarkUrl})`,
        WebkitMaskImage: `url(${ergataiMarkUrl})`,
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        maskPosition: "center",
        WebkitMaskPosition: "center",
        maskSize: "contain",
        WebkitMaskSize: "contain",
      }}
    />
  )
}

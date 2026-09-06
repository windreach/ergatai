import { useEffect, useState } from "react";

export function usePrefersLight(): boolean {
  const [prefersLight, setPrefersLight] = useState(
    () => window.matchMedia("(prefers-color-scheme: light)").matches,
  );

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => setPrefersLight(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return prefersLight;
}

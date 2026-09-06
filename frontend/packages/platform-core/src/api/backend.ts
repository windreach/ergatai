import type { BackendMode } from "../config/runtime";

export class BackendNotConfiguredError extends Error {
  constructor(feature: string) {
    super(`The ${feature} real backend has not been configured yet.`);
    this.name = "BackendNotConfiguredError";
  }
}

export function createUnavailableBackend<T extends object>(feature: string): T {
  return new Proxy({}, {
    get() {
      return () => {
        throw new BackendNotConfiguredError(feature);
      };
    },
  }) as T;
}

export function selectBackend<T extends object>(
  feature: string,
  mode: BackendMode,
  mockBackend: T,
  realBackend?: T,
): T {
  if (mode === "real") {
    return realBackend ?? createUnavailableBackend<T>(feature);
  }
  return mockBackend;
}

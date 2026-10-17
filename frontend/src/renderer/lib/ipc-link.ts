import type { AnyTRPCRouter } from "@trpc/server"
import {
  ipcLink as createElectronIpcLink,
  type IPCLinkOptions,
} from "trpc-electron/renderer"

let nextIpcRequestId = 0

export function ipcLink<TRouter extends AnyTRPCRouter>(
  opts?: IPCLinkOptions<TRouter>,
) {
  const link = createElectronIpcLink<TRouter>(opts)

  return (runtime: Parameters<typeof link>[0]) => {
    const operationLink = link(runtime)

    return (operation: Parameters<typeof operationLink>[0]) => {
      return operationLink({
        ...operation,
        op: {
          ...operation.op,
          id: ++nextIpcRequestId,
        },
      })
    }
  }
}

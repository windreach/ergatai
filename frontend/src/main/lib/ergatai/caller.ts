import { ergataiRouter } from "../trpc/routers/ergatai"

const caller = ergataiRouter.createCaller({ getWindow: () => null })

export const ergataiCaller = caller

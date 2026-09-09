import type { Plugin } from "@ergatai/core-plugin-types";
import { App } from "./agent-workspace";

export const dockviewPlugin: Plugin = {
  name: "@ergatai/dockview",
  inject: ["slots"],
  apply(context) {
    context.effect(
      () => context.slots.register(
        { name: "root", id: "ergatai.dockview" },
        App,
      ),
      "dockview: register agent workspace",
    );
  },
};

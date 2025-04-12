import {
    BrowserService,
} from "./services/browser"
import { fetchMANTRAUpdates } from "./actions/get-updates.ts";
export * from "./providers/InformationProvider.ts"


export const browserPlugin = {
  name: "default",
  description: "Default plugin, with basic actions and evaluators",
  services: [new BrowserService() as any],
  actions: [fetchMANTRAUpdates],
};

export default browserPlugin;
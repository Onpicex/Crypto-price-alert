import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk";
import { priceAlertPlugin } from "./src/plugin.js";

const plugin = {
  id: "price-alert",
  name: "Price Alert",
  description: "Crypto price monitoring and alerting system",
  configSchema: {
    type: "object",
    properties: {}
  },
  register(api: OpenClawPluginApi) {
    // Register HTTP routes
    registerPluginHttpRoute(priceAlertPlugin);
  },
};

export default plugin;

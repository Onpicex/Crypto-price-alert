import type { GatewayRequestHandler } from "openclaw/plugin-sdk";
import { handleRequest, initializeAuth } from "./api.js";
import { startMonitor, stopMonitor } from "./monitor-engine.js";

// Plugin initialization
let initialized = false;

export const priceAlertPlugin: GatewayRequestHandler = {
  pluginId: "price-alert",
  
  async onRequest(request) {
    // Initialize on first request
    if (!initialized) {
      initializeAuth();
      startMonitor();
      initialized = true;
    }
    
    const { method, path, body, headers } = request;
    
    // Handle request
    const result = await handleRequest(method, path, body, headers);
    
    return {
      status: result.status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result.data)
    };
  },
  
  async onStart() {
    console.log("[PriceAlert] Plugin started");
  },
  
  async onStop() {
    stopMonitor();
    console.log("[PriceAlert] Plugin stopped");
  }
};

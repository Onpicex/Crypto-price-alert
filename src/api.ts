import { getSetting, setSetting, getSettings, createAlert, updateAlert, deleteAlert, getAlert, getAllAlerts, getAlertEvents, createAlertEvent, Alert } from "./db.js";
import { getSpotPrice, validateSymbol } from "./price-source.js";
import { applyChange, rebuildFromDb, startMonitor, stopMonitor, getEngineStatus } from "./monitor-engine.js";
import { testTelegram, sendTestNotification } from "./notify-worker.js";
import { randomUUID } from "crypto";
import bcrypt from "bcrypt";

const MIN_POLL_SEC = 1;
const MAX_POLL_SEC = 3600;
const DEFAULT_MAX_ALERTS = 100;

// In-memory session (simple token-based)
let sessionToken: string | null = null;

/**
 * Auth middleware
 */
function requireAuth(headers: any): boolean {
  const authHeader = headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
  
  const token = authHeader.substring(7);
  return token === sessionToken;
}

/**
 * Initialize password on first run
 */
export function initializeAuth(): void {
  const passwordHash = getSetting("auth.password_hash");
  if (!passwordHash) {
    sessionToken = null;
  }
  console.log("[PriceAlert] Auth initialized");
}

/**
 * Set password (first time or change)
 */
export async function setPassword(password: string): Promise<void> {
  const hash = await bcrypt.hash(password, 10);
  setSetting("auth.password_hash", hash);
  
  // Generate session token
  sessionToken = randomUUID();
  setSetting("auth.session_token", sessionToken);
}

/**
 * Validate password and login
 */
export async function login(password: string): Promise<{ success: boolean; token?: string; error?: string }> {
  const passwordHash = getSetting("auth.password_hash");
  
  if (!passwordHash) {
    return { success: false, error: "Password not set. Please initialize password first." };
  }
  
  const valid = await bcrypt.compare(password, passwordHash);
  if (!valid) {
    return { success: false, error: "Invalid password" };
  }
  
  // Generate new session token
  sessionToken = randomUUID();
  setSetting("auth.session_token", sessionToken);
  
  return { success: true, token: sessionToken };
}

/**
 * Check if initialized
 */
export function isInitialized(): boolean {
  return !!getSetting("auth.password_hash");
}

/**
 * Get settings (filtered)
 */
function getPublicSettings(): Record<string, any> {
  const settings = getSettings();
  const publicSettings: Record<string, any> = {};
  
  // Return only non-sensitive settings
  if (settings["telegram.bot_token"]) publicSettings["telegram.configured"] = true;
  if (settings["telegram.chat_id"]) publicSettings["telegram.chat_id"] = settings["telegram.chat_id"];
  publicSettings["limits.min_poll_sec"] = MIN_POLL_SEC;
  publicSettings["limits.max_poll_sec"] = MAX_POLL_SEC;
  publicSettings["limits.max_alerts"] = DEFAULT_MAX_ALERTS;
  publicSettings["engine"] = getEngineStatus();
  
  return publicSettings;
}

/**
 * Parse and validate alert input
 */
function parseAlertInput(body: any): { valid: boolean; alert?: Partial<Alert>; error?: string } {
  const { symbol, condition_type, threshold, poll_interval_sec, cooldown_sec, is_enabled } = body;
  
  // Validate symbol
  if (!symbol || typeof symbol !== "string") {
    return { valid: false, error: "symbol is required" };
  }
  const normalizedSymbol = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalizedSymbol.length < 4 || normalizedSymbol.length > 10) {
    return { valid: false, error: "invalid symbol format" };
  }
  
  // Validate condition_type
  const validConditions = ["cross_up", "cross_down", "price_gte", "price_lte", "pct_change_up", "pct_change_down"];
  if (!condition_type || !validConditions.includes(condition_type)) {
    return { valid: false, error: `condition_type must be one of: ${validConditions.join(", ")}` };
  }
  
  // Validate threshold
  if (typeof threshold !== "number" || threshold <= 0) {
    return { valid: false, error: "threshold must be a positive number" };
  }
  
  // Validate poll_interval_sec
  if (typeof poll_interval_sec !== "number" || poll_interval_sec < MIN_POLL_SEC) {
    return { valid: false, error: `poll_interval_sec must be >= ${MIN_POLL_SEC}` };
  }
  if (poll_interval_sec > MAX_POLL_SEC) {
    return { valid: false, error: `poll_interval_sec must be <= ${MAX_POLL_SEC}` };
  }
  
  // Validate cooldown_sec
  const cooldown = typeof cooldown_sec === "number" ? cooldown_sec : 300;
  if (cooldown < 0) {
    return { valid: false, error: "cooldown_sec must be >= 0" };
  }
  
  // For pct_change types, require window_sec in last_state (handled client-side)
  
  return {
    valid: true,
    alert: {
      id: randomUUID(),
      symbol: normalizedSymbol,
      condition_type,
      threshold,
      poll_interval_sec: Math.floor(poll_interval_sec),
      cooldown_sec: Math.floor(cooldown),
      is_enabled: is_enabled !== false,
      last_triggered_at: null,
      last_state: null
    }
  };
}

/**
 * Handle API request
 */
export async function handleRequest(
  method: string,
  path: string,
  body: any,
  headers: any
): Promise<{ status: number; data: any }> {
  try {
    // Health check - no auth required
    if (path === "/health") {
      return { status: 200, data: { status: "ok", engine: getEngineStatus() } };
    }
    
    // Login - no auth required
    if (method === "POST" && path === "/api/login") {
      if (isInitialized()) {
        const result = await login(body.password);
        if (result.success) {
          return { status: 200, data: { success: true, token: result.token } };
        }
        return { status: 401, data: { success: false, error: result.error } };
      } else {
        // First time - set password
        if (!body.password || body.password.length < 6) {
          return { status: 400, data: { success: false, error: "Password must be at least 6 characters" } };
        }
        await setPassword(body.password);
        return { status: 200, data: { success: true, message: "Password set successfully" } };
      }
    }
    
    // All other routes require auth
    if (!requireAuth(headers)) {
      return { status: 401, data: { error: "Unauthorized" } };
    }
    
    // Settings
    if (method === "GET" && path === "/api/settings") {
      return { status: 200, data: getPublicSettings() };
    }
    
    if (method === "PUT" && path === "/api/settings") {
      const { telegram } = body;
      if (telegram) {
        if (telegram.bot_token) setSetting("telegram.bot_token", telegram.bot_token);
        if (telegram.chat_id) setSetting("telegram.chat_id", telegram.chat_id);
      }
      return { status: 200, data: { success: true } };
    }
    
    if (method === "POST" && path === "/api/settings/telegram/test") {
      const { bot_token, chat_id } = body;
      if (!bot_token || !chat_id) {
        return { status: 400, data: { success: false, error: "bot_token and chat_id are required" } };
      }
      const result = await testTelegram(bot_token, chat_id);
      
      // Log test event
      const now = Math.floor(Date.now() / 1000);
      createAlertEvent({
        alert_id: "system",
        event_type: "test",
        reason: result.success ? "test_success" : result.error,
        notify_status: result.success ? "success" : "failed",
        triggered_at: now
      });
      
      return { status: result.success ? 200 : 400, data: result };
    }
    
    // Alerts CRUD
    if (method === "GET" && path === "/api/alerts") {
      const alerts = getAllAlerts();
      return { status: 200, data: alerts };
    }
    
    if (method === "POST" && path === "/api/alerts") {
      const parsed = parseAlertInput(body);
      if (!parsed.valid) {
        return { status: 400, data: { error: parsed.error } };
      }
      
      const alert = createAlert(parsed.alert as Omit<Alert, "created_at" | "updated_at">);
      applyChange("upsert", alert);
      
      return { status: 201, data: alert };
    }
    
    if (method === "GET" && path.startsWith("/api/alerts/")) {
      const id = path.substring("/api/alerts/".length);
      const alert = getAlert(id);
      if (!alert) {
        return { status: 404, data: { error: "Alert not found" } };
      }
      return { status: 200, data: alert };
    }
    
    if (method === "PUT" && path.startsWith("/api/alerts/")) {
      const id = path.substring("/api/alerts/".length);
      const existing = getAlert(id);
      if (!existing) {
        return { status: 404, data: { error: "Alert not found" } };
      }
      
      // Parse updates (allow partial update)
      const updates: Partial<Alert> = {};
      if (body.symbol !== undefined) updates.symbol = body.symbol.toUpperCase();
      if (body.condition_type !== undefined) updates.condition_type = body.condition_type;
      if (body.threshold !== undefined) updates.threshold = body.threshold;
      if (body.poll_interval_sec !== undefined) updates.poll_interval_sec = body.poll_interval_sec;
      if (body.cooldown_sec !== undefined) updates.cooldown_sec = body.cooldown_sec;
      if (body.is_enabled !== undefined) updates.is_enabled = body.is_enabled;
      
      // Validate
      if (updates.symbol || updates.condition_type || updates.threshold || updates.poll_interval_sec) {
        // Re-validate the full alert
        const fullAlert = { ...existing, ...updates };
        const parsed = parseAlertInput(fullAlert);
        if (!parsed.valid) {
          return { status: 400, data: { error: parsed.error } };
        }
      }
      
      updateAlert(id, updates);
      
      // Reload from DB and apply change
      const updated = getAlert(id);
      if (updated) {
        applyChange("update", updated);
      }
      
      return { status: 200, data: updated };
    }
    
    if (method === "PATCH" && path.startsWith("/api/alerts/")) {
      const id = path.substring("/api/alerts/".length);
      const existing = getAlert(id);
      if (!existing) {
        return { status: 404, data: { error: "Alert not found" } };
      }
      
      const updates: Partial<Alert> = {};
      if (body.is_enabled !== undefined) updates.is_enabled = body.is_enabled;
      
      updateAlert(id, updates);
      
      const updated = getAlert(id);
      if (updated) {
        applyChange("update", updated);
      }
      
      return { status: 200, data: updated };
    }
    
    if (method === "DELETE" && path.startsWith("/api/alerts/")) {
      const id = path.substring("/api/alerts/".length);
      const existing = getAlert(id);
      if (!existing) {
        return { status: 404, data: { error: "Alert not found" } };
      }
      
      deleteAlert(id);
      applyChange("delete", existing);
      
      return { status: 200, data: { success: true } };
    }
    
    // Test alert notification
    if (method === "POST" && path.startsWith("/api/alerts/") && path.endsWith("/test")) {
      const id = path.substring("/api/alerts/".length, path.lastIndexOf("/"));
      const alert = getAlert(id);
      if (!alert) {
        return { status: 404, data: { error: "Alert not found" } };
      }
      
      const result = await sendTestNotification(id, alert.symbol, body.message);
      
      // Log test event (without updating alert state)
      const now = Math.floor(Date.now() / 1000);
      createAlertEvent({
        alert_id: id,
        event_type: "test",
        reason: body.message || "manual_test",
        price: alert.threshold,
        threshold: alert.threshold,
        notify_status: result.success ? "success" : "failed",
        error_message: result.error,
        triggered_at: now
      });
      
      return { status: result.success ? 200 : 400, data: result };
    }
    
    // Events / Logs
    if (method === "GET" && path === "/api/events") {
      const limit = parseInt(headers["x-limit"] || "200");
      const symbol = headers["x-symbol"];
      const events = getAlertEvents(Math.min(limit, 500), symbol);
      return { status: 200, data: events };
    }
    
    // Price endpoint (for testing)
    if (method === "GET" && path.startsWith("/api/price/")) {
      const symbol = path.substring("/api/price/".length);
      try {
        const price = await getSpotPrice(symbol);
        return { status: 200, data: price };
      } catch (error: any) {
        return { status: 400, data: { error: error.message } };
      }
    }
    
    // Engine control
    if (method === "POST" && path === "/api/engine/rebuild") {
      rebuildFromDb();
      return { status: 200, data: { success: true, ...getEngineStatus() } };
    }
    
    // 404
    return { status: 404, data: { error: "Not found" } };
    
  } catch (error: any) {
    console.error("[PriceAlert] API Error:", error);
    return { status: 500, data: { error: error.message || "Internal error" } };
  }
}

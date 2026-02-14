import { getEnabledAlerts, updateAlert, createAlertEvent, Alert, AlertEvent } from "./db.js";
import { getSpotPrice, PriceResult } from "./price-source.js";
import { pushToNotifyQueue } from "./notify-worker.js";

interface GroupKey {
  symbol: string;
  interval: number;
}

interface AlertGroup {
  symbol: string;
  interval: number;
  alertIds: Set<string>;
  nextRunAt: number;
}

interface AlertWithState extends Alert {
  _lastState: Record<string, any>;
}

// In-memory indexes
let alertsById: Map<string, AlertWithState> = new Map();
let enabledAlertsBySymbol: Map<string, Set<string>> = new Map();
let groups: Map<string, AlertGroup> = new Map();

let isRunning = false;
let monitorInterval: NodeJS.Timeout | null = null;

function makeGroupKey(symbol: string, interval: number): string {
  return `${symbol}:${interval}`;
}

/**
 * Rebuild all in-memory structures from database
 */
export function rebuildFromDb(): void {
  alertsById.clear();
  enabledAlertsBySymbol.clear();
  groups.clear();
  
  const alerts = getEnabledAlerts();
  const now = Math.floor(Date.now() / 1000);
  
  for (const alert of alerts) {
    const alertWithState: AlertWithState = {
      ...alert,
      _lastState: alert.last_state || {}
    };
    
    // Index by ID
    alertsById.set(alert.id, alertWithState);
    
    // Index by symbol
    if (!enabledAlertsBySymbol.has(alert.symbol)) {
      enabledAlertsBySymbol.set(alert.symbol, new Set());
    }
    enabledAlertsBySymbol.get(alert.symbol)!.add(alert.id);
    
    // Group by (symbol, interval)
    const groupKey = makeGroupKey(alert.symbol, alert.poll_interval_sec);
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        symbol: alert.symbol,
        interval: alert.poll_interval_sec,
        alertIds: new Set(),
        nextRunAt: now + alert.poll_interval_sec
      });
    }
    groups.get(groupKey)!.alertIds.add(alert.id);
  }
  
  console.log(`[PriceAlert] Built ${alertsById.size} alerts, ${groups.size} groups`);
}

/**
 * Apply a single alert change (upsert/update/delete)
 */
export function applyChange(action: "upsert" | "update" | "delete", alert: Alert): void {
  const now = Math.floor(Date.now() / 1000);
  
  if (action === "delete") {
    // Remove from all indexes
    const oldAlert = alertsById.get(alert.id);
    if (oldAlert) {
      // Remove from symbol index
      const symbolAlerts = enabledAlertsBySymbol.get(oldAlert.symbol);
      if (symbolAlerts) {
        symbolAlerts.delete(alert.id);
        if (symbolAlerts.size === 0) {
          enabledAlertsBySymbol.delete(oldAlert.symbol);
        }
      }
      
      // Remove from group
      const groupKey = makeGroupKey(oldAlert.symbol, oldAlert.poll_interval_sec);
      const group = groups.get(groupKey);
      if (group) {
        group.alertIds.delete(alert.id);
        if (group.alertIds.size === 0) {
          groups.delete(groupKey);
        }
      }
    }
    alertsById.delete(alert.id);
    return;
  }
  
  // Upsert or update
  const alertWithState: AlertWithState = {
    ...alert,
    _lastState: alert.last_state || {}
  };
  
  const oldAlert = alertsById.get(alert.id);
  
  if (alert.is_enabled) {
    // Add to indexes
    alertsById.set(alert.id, alertWithState);
    
    // Symbol index
    if (!enabledAlertsBySymbol.has(alert.symbol)) {
      enabledAlertsBySymbol.set(alert.symbol, new Set());
    }
    enabledAlertsBySymbol.get(alert.symbol)!.add(alert.id);
    
    // Handle interval change
    const oldInterval = oldAlert?.poll_interval_sec;
    const newInterval = alert.poll_interval_sec;
    const oldSymbol = oldAlert?.symbol;
    const newSymbol = alert.symbol;
    
    if (oldAlert && (oldInterval !== newInterval || oldSymbol !== newSymbol)) {
      // Remove from old group
      const oldGroupKey = makeGroupKey(oldSymbol!, oldInterval!);
      const oldGroup = groups.get(oldGroupKey);
      if (oldGroup) {
        oldGroup.alertIds.delete(alert.id);
        if (oldGroup.alertIds.size === 0) {
          groups.delete(oldGroupKey);
        }
      }
    }
    
    // Add to new group
    const groupKey = makeGroupKey(newSymbol, newInterval);
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        symbol: newSymbol,
        interval: newInterval,
        alertIds: new Set(),
        nextRunAt: now + newInterval
      });
    }
    groups.get(groupKey)!.alertIds.add(alert.id);
  } else {
    // Disabled - remove from enabled indexes
    alertsById.delete(alert.id);
    
    if (oldAlert) {
      const symbolAlerts = enabledAlertsBySymbol.get(oldAlert.symbol);
      if (symbolAlerts) {
        symbolAlerts.delete(alert.id);
        if (symbolAlerts.size === 0) {
          enabledAlertsBySymbol.delete(oldAlert.symbol);
        }
      }
      
      const groupKey = makeGroupKey(oldAlert.symbol, oldAlert.poll_interval_sec);
      const group = groups.get(groupKey);
      if (group) {
        group.alertIds.delete(alert.id);
        if (group.alertIds.size === 0) {
          groups.delete(groupKey);
        }
      }
    }
  }
}

/**
 * Check if alert should trigger
 */
function shouldTrigger(alert: AlertWithState, now: number, price: number): { triggered: boolean; reason: string } {
  // Check cooldown
  if (alert.last_triggered_at && now - alert.last_triggered_at < alert.cooldown_sec) {
    return { triggered: false, reason: "cooldown" };
  }
  
  const state = alert._lastState;
  const threshold = alert.threshold;
  
  switch (alert.condition_type) {
    case "cross_up": {
      const wasAbove = state.wasAbove ?? (price >= threshold);
      const isAbove = price >= threshold;
      if (!wasAbove && isAbove) {
        return { triggered: true, reason: `cross_up: ${state.wasAbove ? 'false' : 'undefined'} -> true` };
      }
      state.wasAbove = isAbove;
      break;
    }
    
    case "cross_down": {
      const wasBelow = state.wasBelow ?? (price <= threshold);
      const isBelow = price <= threshold;
      if (!wasBelow && isBelow) {
        return { triggered: true, reason: `cross_down: ${state.wasBelow ? 'false' : 'undefined'} -> true` };
      }
      state.wasBelow = isBelow;
      break;
    }
    
    case "price_gte": {
      if (price >= threshold) {
        return { triggered: true, reason: `price_gte: ${price} >= ${threshold}` };
      }
      break;
    }
    
    case "price_lte": {
      if (price <= threshold) {
        return { triggered: true, reason: `price_lte: ${price} <= ${threshold}` };
      }
      break;
    }
    
    case "pct_change_up": {
      const windowSec = state.windowSec || 0;
      if (windowSec > 0 && state.basePrice) {
        const change = ((price - state.basePrice) / state.basePrice) * 100;
        if (change >= threshold) {
          return { triggered: true, reason: `pct_change_up: ${change.toFixed(2)}% >= ${threshold}%` };
        }
      }
      // Update base price for next check
      state.basePrice = price;
      state.windowSec = windowSec || 60; // Default 60s window
      break;
    }
    
    case "pct_change_down": {
      const windowSec = state.windowSec || 0;
      if (windowSec > 0 && state.basePrice) {
        const change = ((price - state.basePrice) / state.basePrice) * 100;
        if (change <= -threshold) {
          return { triggered: true, reason: `pct_change_down: ${change.toFixed(2)}% <= -${threshold}%` };
        }
      }
      state.basePrice = price;
      state.windowSec = windowSec || 60;
      break;
    }
  }
  
  return { triggered: false, reason: "no condition met" };
}

/**
 * Execute a group tick
 */
async function executeGroupTick(group: AlertGroup): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  
  // Fetch price once per group
  let priceResult: PriceResult;
  try {
    priceResult = await getSpotPrice(group.symbol);
  } catch (error: any) {
    // Log error event but don't trigger
    console.error(`[PriceAlert] Failed to fetch price for ${group.symbol}:`, error.message);
    return;
  }
  
  const { price, price_ts } = priceResult;
  
  // Check each alert in the group
  for (const alertId of group.alertIds) {
    const alert = alertsById.get(alertId);
    if (!alert || !alert.is_enabled) continue;
    
    const { triggered, reason } = shouldTrigger(alert, now, price);
    
    if (triggered) {
      // Update alert state
      alert.last_triggered_at = now;
      alert._lastState = { ...alert._lastState };
      
      // Persist to DB
      updateAlert(alert.id, {
        last_triggered_at: now,
        last_state: alert._lastState
      });
      
      // Create event record
      const eventId = createAlertEvent({
        alert_id: alert.id,
        event_type: "trigger",
        reason,
        price,
        threshold: alert.threshold,
        notify_status: "queued",
        triggered_at: now
      });
      
      // Queue notification
      pushToNotifyQueue({
        eventId,
        alertId: alert.id,
        symbol: alert.symbol,
        conditionType: alert.condition_type,
        threshold: alert.threshold,
        price,
        reason,
        triggeredAt: now
      });
      
      console.log(`[PriceAlert] Alert triggered: ${alert.id} ${alert.symbol} ${reason} @ ${price}`);
    } else {
      // Save state for cross-type alerts even when not triggered
      updateAlert(alert.id, { last_state: alert._lastState });
    }
  }
  
  // Schedule next run
  group.nextRunAt = now + group.interval;
}

/**
 * Main monitoring loop
 */
function monitorLoop(): void {
  if (!isRunning) return;
  
  const now = Math.floor(Date.now() / 1000);
  
  // Find groups that need to run
  for (const [key, group] of groups) {
    if (now >= group.nextRunAt) {
      executeGroupTick(group).catch(err => {
        console.error(`[PriceAlert] Group tick error:`, err);
      });
    }
  }
  
  // Schedule next tick
  monitorInterval = setTimeout(monitorLoop, 200); // 200ms tick
}

/**
 * Start the monitor engine
 */
export function startMonitor(): void {
  if (isRunning) return;
  
  rebuildFromDb();
  isRunning = true;
  
  // Start loop
  monitorLoop();
  
  console.log("[PriceAlert] Monitor engine started");
}

/**
 * Stop the monitor engine
 */
export function stopMonitor(): void {
  isRunning = false;
  if (monitorInterval) {
    clearTimeout(monitorInterval);
    monitorInterval = null;
  }
  console.log("[PriceAlert] Monitor engine stopped");
}

/**
 * Get engine status
 */
export function getEngineStatus(): { alertsCount: number; groupsCount: number; isRunning: boolean } {
  return {
    alertsCount: alertsById.size,
    groupsCount: groups.size,
    isRunning
  };
}

const { getEnabledAlertsByUser, updateAlert, createAlertEvent, getUserById } = require("./db.cjs");
const { getSpotPrice } = require("./price-source.cjs");

const alertsById = new Map();
const enabledAlertsBySymbol = new Map();
const groups = new Map();

let isRunning = false;
let monitorInterval = null;

function makeGroupKey(symbol, interval) {
  return `${symbol}:${interval}`;
}

function rebuildFromDb() {
  alertsById.clear();
  enabledAlertsBySymbol.clear();
  groups.clear();
  
  // 获取所有用户的启用警报
  const { getAllUsers } = require("./db.cjs");
  const users = getAllUsers();
  
  let totalAlerts = 0;
  const now = Math.floor(Date.now() / 1000);
  
  for (const user of users) {
    const alerts = getEnabledAlertsByUser(user.id);
    const userTelegram = user.telegram || {};
    
    for (const alert of alerts) {
      const alertWithState = {
        ...alert,
        _lastState: alert.last_state || {},
        _telegram: userTelegram  // 绑定用户的 Telegram 配置
      };
      
      alertsById.set(alert.id, alertWithState);
      
      if (!enabledAlertsBySymbol.has(alert.symbol)) {
        enabledAlertsBySymbol.set(alert.symbol, new Set());
      }
      enabledAlertsBySymbol.get(alert.symbol).add(alert.id);
      
      const groupKey = makeGroupKey(alert.symbol, alert.poll_interval_sec);
      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          symbol: alert.symbol,
          interval: alert.poll_interval_sec,
          alertIds: new Set(),
          nextRunAt: now + alert.poll_interval_sec
        });
      }
      groups.get(groupKey).alertIds.add(alert.id);
      totalAlerts++;
    }
  }
  
  console.log(`[PriceAlert] Built ${totalAlerts} alerts, ${groups.size} groups`);
}

function applyChange(action, alert) {
  const now = Math.floor(Date.now() / 1000);
  
  if (action === "delete") {
    const oldAlert = alertsById.get(alert.id);
    if (oldAlert) {
      const symbolAlerts = enabledAlertsBySymbol.get(oldAlert.symbol);
      if (symbolAlerts) {
        symbolAlerts.delete(alert.id);
        if (symbolAlerts.size === 0) enabledAlertsBySymbol.delete(oldAlert.symbol);
      }
      
      const groupKey = makeGroupKey(oldAlert.symbol, oldAlert.poll_interval_sec);
      const group = groups.get(groupKey);
      if (group) {
        group.alertIds.delete(alert.id);
        if (group.alertIds.size === 0) groups.delete(groupKey);
      }
    }
    alertsById.delete(alert.id);
    return;
  }
  
  // 获取用户的 Telegram 配置
  const { getUserById } = require("./db.cjs");
  const user = alert.user_id ? getUserById(alert.user_id) : null;
  const userTelegram = user?.telegram || {};
  
  const alertWithState = {
    ...alert,
    _lastState: alert.last_state || {},
    _telegram: userTelegram
  };
  
  const oldAlert = alertsById.get(alert.id);
  
  if (alert.is_enabled) {
    alertsById.set(alert.id, alertWithState);
    
    if (!enabledAlertsBySymbol.has(alert.symbol)) {
      enabledAlertsBySymbol.set(alert.symbol, new Set());
    }
    enabledAlertsBySymbol.get(alert.symbol).add(alert.id);
    
    const oldInterval = oldAlert?.poll_interval_sec;
    const newInterval = alert.poll_interval_sec;
    const oldSymbol = oldAlert?.symbol;
    const newSymbol = alert.symbol;
    
    if (oldAlert && (oldInterval !== newInterval || oldSymbol !== newSymbol)) {
      const oldGroupKey = makeGroupKey(oldSymbol, oldInterval);
      const oldGroup = groups.get(oldGroupKey);
      if (oldGroup) {
        oldGroup.alertIds.delete(alert.id);
        if (oldGroup.alertIds.size === 0) groups.delete(oldGroupKey);
      }
    }
    
    const groupKey = makeGroupKey(newSymbol, newInterval);
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        symbol: newSymbol,
        interval: newInterval,
        alertIds: new Set(),
        nextRunAt: now + newInterval
      });
    }
    groups.get(groupKey).alertIds.add(alert.id);
  } else {
    alertsById.delete(alert.id);
    
    if (oldAlert) {
      const symbolAlerts = enabledAlertsBySymbol.get(oldAlert.symbol);
      if (symbolAlerts) {
        symbolAlerts.delete(alert.id);
        if (symbolAlerts.size === 0) enabledAlertsBySymbol.delete(oldAlert.symbol);
      }
      
      const groupKey = makeGroupKey(oldAlert.symbol, oldAlert.poll_interval_sec);
      const group = groups.get(groupKey);
      if (group) {
        group.alertIds.delete(alert.id);
        if (group.alertIds.size === 0) groups.delete(groupKey);
      }
    }
  }
}

function shouldTrigger(alert, now, price) {
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
        return { triggered: true, reason: `cross_up: ${wasAbove} -> true` };
      }
      state.wasAbove = isAbove;
      break;
    }
    
    case "cross_down": {
      const wasBelow = state.wasBelow ?? (price <= threshold);
      const isBelow = price <= threshold;
      if (!wasBelow && isBelow) {
        return { triggered: true, reason: `cross_down: ${wasBelow} -> true` };
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
      if (state.basePrice) {
        const change = ((price - state.basePrice) / state.basePrice) * 100;
        if (change >= threshold) {
          return { triggered: true, reason: `pct_change_up: ${change.toFixed(2)}% >= ${threshold}%` };
        }
      }
      state.basePrice = price;
      break;
    }
    
    case "pct_change_down": {
      if (state.basePrice) {
        const change = ((price - state.basePrice) / state.basePrice) * 100;
        if (change <= -threshold) {
          return { triggered: true, reason: `pct_change_down: ${change.toFixed(2)}% <= -${threshold}%` };
        }
      }
      state.basePrice = price;
      break;
    }
  }
  
  return { triggered: false, reason: "no condition met" };
}

async function executeGroupTick(group) {
  const now = Math.floor(Date.now() / 1000);
  
  let priceResult;
  try {
    priceResult = await getSpotPrice(group.symbol);
  } catch (error) {
    console.error(`[PriceAlert] Failed to fetch price for ${group.symbol}:`, error.message);
    return;
  }
  
  const { price } = priceResult;
  
  for (const alertId of group.alertIds) {
    const alert = alertsById.get(alertId);
    if (!alert || !alert.is_enabled) continue;
    
    const { triggered, reason } = shouldTrigger(alert, now, price);
    
    if (triggered) {
      alert.last_triggered_at = now;
      alert._lastState = { ...alert._lastState };
      
      updateAlert(alert.id, {
        last_triggered_at: now,
        last_state: alert._lastState
      });
      
      const { pushToNotifyQueue } = require("./notify-worker.cjs");
      
      // 获取提醒次数，默认 1 次
      const notifyTimes = alert.notify_times || 1;
      
      // 获取用户的 Telegram 配置
      const userTelegram = alert._telegram || {};
      
      // 创建事件（用于记录）
      const eventId = createAlertEvent({
        user_id: alert.user_id,
        alert_id: alert.id,
        event_type: "trigger",
        reason: `${reason} (x${notifyTimes})`,
        price,
        threshold: alert.threshold,
        notify_status: "queued",
        triggered_at: now
      });
      
      // 根据 notify_times 多次推送通知
      for (let i = 0; i < notifyTimes; i++) {
        const delay = i * 3000; // 每次间隔 3 秒
        const notifyTask = {
          eventId,
          alertId: alert.id,
          symbol: alert.symbol,
          conditionType: alert.condition_type,
          threshold: alert.threshold,
          price,
          reason: `${reason} (${i+1}/${notifyTimes})`,
          triggeredAt: now,
          telegram: userTelegram  // 传递用户的 Telegram 配置
        };
        
        if (delay === 0) {
          pushToNotifyQueue(notifyTask);
        } else {
          setTimeout(() => {
            pushToNotifyQueue(notifyTask);
          }, delay);
        }
      }
      
      console.log(`[PriceAlert] Alert triggered: ${alert.id} ${alert.symbol} ${reason} @ ${price} (x${notifyTimes})`);
    } else {
      updateAlert(alert.id, { last_state: alert._lastState });
    }
  }
  
  group.nextRunAt = now + group.interval;
}

function monitorLoop() {
  if (!isRunning) return;
  
  const now = Math.floor(Date.now() / 1000);
  
  for (const [key, group] of groups) {
    if (now >= group.nextRunAt) {
      executeGroupTick(group).catch(err => {
        console.error(`[PriceAlert] Group tick error:`, err);
      });
    }
  }
  
  monitorInterval = setTimeout(monitorLoop, 200);
}

function startMonitor() {
  if (isRunning) return;
  
  rebuildFromDb();
  isRunning = true;
  monitorLoop();
  
  console.log("[PriceAlert] Monitor engine started");
}

function stopMonitor() {
  isRunning = false;
  if (monitorInterval) {
    clearTimeout(monitorInterval);
    monitorInterval = null;
  }
  console.log("[PriceAlert] Monitor engine stopped");
}

function getEngineStatus() {
  return {
    alertsCount: alertsById.size,
    groupsCount: groups.size,
    isRunning
  };
}

module.exports = {
  applyChange, rebuildFromDb,
  startMonitor, stopMonitor, getEngineStatus
};

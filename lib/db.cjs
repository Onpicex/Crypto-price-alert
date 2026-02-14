const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "state");
const DB_PATH = path.join(DATA_DIR, "price-alert.json");

let data = {
  users: [],      // 用户列表
  alerts: [],    // 警报（带 user_id）
  events: []     // 事件（带 user_id）
};

function loadData() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (fs.existsSync(DB_PATH)) {
    try {
      data = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    } catch (e) {
      data = { users: [], alerts: [], events: [] };
    }
  }
  // 确保数据结构完整
  data.users = data.users || [];
  data.alerts = data.alerts || [];
  data.events = data.events || [];
}

function reloadData() {
  if (fs.existsSync(DB_PATH)) {
    try {
      const newData = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
      data.users = newData.users || [];
      data.alerts = newData.alerts || [];
      data.events = newData.events || [];
    } catch (e) {
      // ignore
    }
  }
}

function saveData() {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

loadData();

// ============ 用户管理 ============

function getAllUsers() {
  reloadData();
  return data.users.map(u => ({
    id: u.id,
    username: u.username,
    role: u.role,
    created_at: u.created_at
  }));
}

function getUserById(id) {
  reloadData();
  return data.users.find(u => u.id === id) || null;
}

function getUserByUsername(username) {
  reloadData();
  return data.users.find(u => u.username === username) || null;
}

function createUser(user) {
  reloadData();
  const now = Math.floor(Date.now() / 1000);
  const newUser = {
    ...user,
    id: user.id || require("crypto").randomUUID(),
    created_at: now,
    telegram: user.telegram || {}  // 每个用户独立的 Telegram 配置
  };
  data.users.push(newUser);
  saveData();
  return newUser;
}

function updateUser(id, updates) {
  reloadData();
  const index = data.users.findIndex(u => u.id === id);
  if (index === -1) return null;
  
  data.users[index] = { ...data.users[index], ...updates };
  saveData();
  return data.users[index];
}

function deleteUser(id) {
  reloadData();
  const user = data.users.find(u => u.id === id);
  if (!user || user.role === 'admin') return false;
  
  // 删除用户的所有数据和事件
  data.alerts = data.alerts.filter(a => a.user_id !== id);
  data.events = data.events.filter(e => e.user_id !== id);
  data.users = data.users.filter(u => u.id !== id);
  saveData();
  return true;
}

// ============ 警报管理（按用户隔离） ============

function createAlert(alert) {
  reloadData();
  const now = Math.floor(Date.now() / 1000);
  const newAlert = {
    ...alert,
    id: require("crypto").randomUUID(),
    created_at: now,
    updated_at: now
  };
  data.alerts.push(newAlert);
  saveData();
  return newAlert;
}

function updateAlert(id, updates) {
  reloadData();
  const index = data.alerts.findIndex(a => a.id === id);
  if (index === -1) return;
  
  data.alerts[index] = {
    ...data.alerts[index],
    ...updates,
    updated_at: Math.floor(Date.now() / 1000)
  };
  saveData();
}

function deleteAlert(id) {
  reloadData();
  data.alerts = data.alerts.filter(a => a.id !== id);
  saveData();
}

function getAlert(id) {
  reloadData();
  return data.alerts.find(a => a.id === id) || null;
}

function getAlertsByUser(userId) {
  reloadData();
  return data.alerts
    .filter(a => a.user_id === userId)
    .sort((a, b) => b.created_at - a.created_at);
}

function getEnabledAlertsByUser(userId) {
  reloadData();
  return data.alerts.filter(a => a.user_id === userId && a.is_enabled);
}

// ============ 事件管理（按用户隔离） ============

function createAlertEvent(event) {
  reloadData();
  const newEvent = {
    ...event,
    id: Date.now() + Math.floor(Math.random() * 1000),
    triggered_at: event.triggered_at || Math.floor(Date.now() / 1000)
  };
  data.events.push(newEvent);
  
  if (data.events.length > 2000) {
    data.events = data.events.slice(-2000);
  }
  
  saveData();
  return newEvent.id;
}

function getEventsByUser(userId, limit = 200, symbol) {
  reloadData();
  let events = data.events.filter(e => e.user_id === userId);
  
  if (symbol) {
    const symbolAlerts = data.alerts.filter(a => a.user_id === userId && a.symbol === symbol.toUpperCase());
    const alertIds = new Set(symbolAlerts.map(a => a.id));
    events = events.filter(e => alertIds.has(e.alert_id) || e.alert_id === "system");
  }
  
  return events
    .sort((a, b) => b.triggered_at - a.triggered_at)
    .slice(0, limit);
}

function updateAlertEventStatus(id, status, errorMessage) {
  reloadData();
  const event = data.events.find(e => e.id === id);
  if (event) {
    event.notify_status = status;
    if (errorMessage) event.error_message = errorMessage;
    saveData();
  }
}

// ============ 便捷方法 ============

function getSetting(key) {
  reloadData();
  return data.settings?.[key] ?? null;
}

function setSetting(key, value) {
  reloadData();
  if (!data.settings) data.settings = {};
  data.settings[key] = value;
  saveData();
}

function getSettings() {
  reloadData();
  return { ...(data.settings || {}) };
}

function closeDb() {}

module.exports = {
  // 用户
  getAllUsers, getUserById, getUserByUsername, createUser, updateUser, deleteUser,
  // 警报
  createAlert, updateAlert, deleteAlert, getAlert, getAlertsByUser, getEnabledAlertsByUser,
  // 事件
  createAlertEvent, getEventsByUser, updateAlertEventStatus,
  // 设置
  getSetting, setSetting, getSettings,
  closeDb
};

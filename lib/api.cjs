const crypto = require("crypto");
const { 
  getAllUsers, getUserById, getUserByUsername, createUser, updateUser, deleteUser,
  createAlert, updateAlert, deleteAlert, getAlert, getAlertsByUser, getEnabledAlertsByUser,
  createAlertEvent, getEventsByUser, updateAlertEventStatus,
  getSetting, setSetting, getSettings
} = require("./db.cjs");
const { getSpotPrice } = require("./price-source.cjs");
const { applyChange, rebuildFromDb, startMonitor, stopMonitor, getEngineStatus } = require("./monitor-engine.cjs");
const { testTelegram, sendTestNotification } = require("./notify-worker.cjs");
const { hashPassword, verifyPassword } = require("./password.cjs");

const MIN_POLL_SEC = 1;
const MAX_POLL_SEC = 3600;

// session 存储: token -> { userId, role }
const sessions = {};

function generateToken() {
  return crypto.randomUUID();
}

// 从 header 获取当前用户
function getCurrentUser(headers) {
  const authHeader = headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  
  const token = authHeader.substring(7);
  return sessions[token] || null;
}

function requireAuth(headers) {
  return getCurrentUser(headers) !== null;
}

function requireAdmin(headers) {
  const user = getCurrentUser(headers);
  return user && user.role === 'admin';
}

// 初始化 admin 用户
function initializeAuth() {
  const users = getAllUsers();
  if (users.length === 0) {
    // 创建默认 admin 用户
    const adminPassword = "admin123";  // 默认 admin 密码
    const hash = hashPasswordSync(adminPassword);
    createUser({
      id: "admin",
      username: "admin",
      password_hash: hash,
      role: "admin",
      telegram: {}
    });
    console.log("[PriceAlert] Created default admin user (password: admin123)");
  }
  
  // 恢复 sessions（从持久化存储或重建）
  // 简化处理：每次启动清空 sessions，用户需要重新登录
  console.log("[PriceAlert] Auth initialized");
}

// 同步版本的 hashPassword（简化）
function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha256");
  return `${salt}:${key.toString("hex")}`;
}

async function setPassword(password) {
  // 首次设置密码逻辑已改为注册时处理
  throw new Error("Use register or admin create user instead");
}

async function login(username, password) {
  const user = getUserByUsername(username);
  if (!user) {
    return { success: false, error: "用户不存在" };
  }
  
  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return { success: false, error: "密码错误" };
  }
  
  const token = generateToken();
  sessions[token] = { userId: user.id, username: user.username, role: user.role };
  
  return { 
    success: true, 
    token, 
    user: { id: user.id, username: user.username, role: user.role },
    telegram: user.telegram || {}
  };
}

function logout(headers) {
  const authHeader = headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    delete sessions[token];
  }
}

function isInitialized() {
  return getAllUsers().length > 0;
}

function getPublicSettings(user) {
  const publicSettings = {
    limits: {
      min_poll_sec: MIN_POLL_SEC,
      max_poll_sec: MAX_POLL_SEC
    },
    engine: getEngineStatus()
  };
  
  if (user) {
    publicSettings.telegram = {
      configured: !!(user.telegram && user.telegram.bot_token && user.telegram.chat_id),
      bot_token: user.telegram?.bot_token || null,
      chat_id: user.telegram?.chat_id || null
    };
  }
  
  return publicSettings;
}

function parseAlertInput(body, userId) {
  const { symbol, condition_type, threshold, poll_interval_sec, cooldown_sec, is_enabled, notify_times } = body;
  
  if (!symbol || typeof symbol !== "string") {
    return { valid: false, error: "symbol is required" };
  }
  const normalizedSymbol = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalizedSymbol.length < 4 || normalizedSymbol.length > 10) {
    return { valid: false, error: "invalid symbol format" };
  }
  
  const validConditions = ["cross_up", "cross_down", "price_gte", "price_lte", "pct_change_up", "pct_change_down"];
  if (!condition_type || !validConditions.includes(condition_type)) {
    return { valid: false, error: `condition_type must be one of: ${validConditions.join(", ")}` };
  }
  
  if (typeof threshold !== "number" || threshold <= 0) {
    return { valid: false, error: "threshold must be a positive number" };
  }
  
  if (typeof poll_interval_sec !== "number" || poll_interval_sec < MIN_POLL_SEC) {
    return { valid: false, error: `poll_interval_sec must be >= ${MIN_POLL_SEC}` };
  }
  if (poll_interval_sec > MAX_POLL_SEC) {
    return { valid: false, error: `poll_interval_sec must be <= ${MAX_POLL_SEC}` };
  }
  
  const cooldown = typeof cooldown_sec === "number" ? cooldown_sec : 300;
  if (cooldown < 0) {
    return { valid: false, error: "cooldown_sec must be >= 0" };
  }
  
  const times = typeof notify_times === "number" ? Math.max(1, Math.min(notify_times, 10)) : 1;
  
  return {
    valid: true,
    alert: {
      user_id: userId,
      symbol: normalizedSymbol,
      condition_type,
      threshold,
      poll_interval_sec: Math.floor(poll_interval_sec),
      cooldown_sec: Math.floor(cooldown),
      is_enabled: is_enabled !== false,
      notify_times: times,
      last_triggered_at: null,
      last_state: null
    }
  };
}

async function handleRequest(method, path, body, headers) {
  try {
    // 健康检查
    if (path === "/health") {
      return { status: 200, data: { status: "ok", engine: getEngineStatus() } };
    }
    
    // 登录
    if (method === "POST" && path === "/api/login") {
      const { username, password } = body || {};
      if (!username || !password) {
        return { status: 400, data: { success: false, error: "用户名和密码必填" } };
      }
      const result = await login(username, password);
      if (result.success) {
        return { status: 200, data: result };
      }
      return { status: 401, data: result };
    }
    
    // 登出
    if (method === "POST" && path === "/api/logout") {
      logout(headers);
      return { status: 200, data: { success: true } };
    }
    
    // 注册已禁用，请联系管理员创建用户
    if (method === "POST" && path === "/api/register") {
      return { status: 403, data: { success: false, error: "注册已禁用，请联系管理员创建用户" } };
    }
    
    // 以下需要登录
    const currentUser = getCurrentUser(headers);
    if (!currentUser) {
      return { status: 401, data: { error: "请先登录" } };
    }
    
    // 获取当前用户信息
    if (method === "GET" && path === "/api/me") {
      const user = getUserById(currentUser.userId);
      return { status: 200, data: { 
        id: user.id, 
        username: user.username, 
        role: user.role,
        telegram: user.telegram || {}
      }};
    }
    
    // ============ 管理员功能 ============
    if (method === "GET" && path === "/api/admin/users") {
      if (currentUser.role !== "admin") {
        return { status: 403, data: { error: "需要管理员权限" } };
      }
      const users = getAllUsers();
      return { status: 200, data: users };
    }
    
    // 管理员创建用户
    if (method === "POST" && path === "/api/admin/users") {
      if (currentUser.role !== "admin") {
        return { status: 403, data: { error: "需要管理员权限" } };
      }
      const { username, password, role } = body || {};
      if (!username || !password) {
        return { status: 400, data: { error: "用户名和密码必填" } };
      }
      
      if (getUserByUsername(username)) {
        return { status: 400, data: { error: "用户名已存在" } };
      }
      
      const hash = await hashPassword(password);
      const user = createUser({
        username,
        password_hash: hash,
        role: role || "user",
        telegram: {}
      });
      
      return { status: 201, data: { id: user.id, username: user.username, role: user.role } };
    }
    
    // 管理员删除用户
    if (method === "DELETE" && path.startsWith("/api/admin/users/")) {
      if (currentUser.role !== "admin") {
        return { status: 403, data: { error: "需要管理员权限" } };
      }
      const userId = path.substring("/api/admin/users/".length);
      if (userId === "admin" || userId === "admin") {
        return { status: 400, data: { error: "不能删除管理员" } };
      }
      
      const success = deleteUser(userId);
      if (!success) {
        return { status: 404, data: { error: "用户不存在" } };
      }
      
      return { status: 200, data: { success: true } };
    }
    
    // ============ 用户设置 ============
    if (method === "GET" && path === "/api/settings") {
      const user = getUserById(currentUser.userId);
      return { status: 200, data: getPublicSettings(user) };
    }
    
    if (method === "PUT" && path === "/api/settings") {
      const { telegram } = body;
      if (telegram) {
        const user = getUserById(currentUser.userId);
        updateUser(currentUser.userId, {
          telegram: { ...user.telegram, ...telegram }
        });
      }
      return { status: 200, data: { success: true } };
    }
    
    // 修改密码
    if (method === "POST" && path === "/api/settings/password") {
      const { old_password, new_password } = body;
      if (!old_password || !new_password) {
        return { status: 400, data: { success: false, error: "旧密码和新密码必填" } };
      }
      if (new_password.length < 6) {
        return { status: 400, data: { success: false, error: "新密码至少6位" } };
      }
      
      const user = getUserById(currentUser.userId);
      const valid = await verifyPassword(old_password, user.password_hash);
      if (!valid) {
        return { status: 400, data: { success: false, error: "旧密码错误" } };
      }
      
      const hash = await hashPassword(new_password);
      updateUser(currentUser.userId, { password_hash: hash });
      
      return { status: 200, data: { success: true, message: "密码修改成功" } };
    }
    
    if (method === "POST" && path === "/api/settings/telegram/test") {
      const { bot_token, chat_id } = body;
      if (!bot_token || !chat_id) {
        return { status: 400, data: { success: false, error: "bot_token and chat_id are required" } };
      }
      const result = await testTelegram(bot_token, chat_id);
      
      const now = Math.floor(Date.now() / 1000);
      createAlertEvent({
        user_id: currentUser.userId,
        alert_id: "system",
        event_type: "test",
        reason: result.success ? "test_success" : result.error,
        notify_status: result.success ? "success" : "failed",
        triggered_at: now
      });
      
      return { status: result.success ? 200 : 400, data: result };
    }
    
    // 删除 Telegram 配置
    if (method === "DELETE" && path === "/api/settings/telegram") {
      updateUser(currentUser.userId, { telegram: {} });
      return { status: 200, data: { success: true } };
    }
    
    // ============ 警报 CRUD ============
    if (method === "GET" && path === "/api/alerts") {
      const alerts = getAlertsByUser(currentUser.userId);
      return { status: 200, data: alerts };
    }
    
    if (method === "POST" && path === "/api/alerts") {
      const parsed = parseAlertInput(body, currentUser.userId);
      if (!parsed.valid) {
        return { status: 400, data: { error: parsed.error } };
      }
      
      const alert = createAlert(parsed.alert);
      applyChange("upsert", alert);
      
      return { status: 201, data: alert };
    }
    
    if (method === "GET" && path.startsWith("/api/alerts/")) {
      const id = path.substring("/api/alerts/".length);
      const alert = getAlert(id);
      if (!alert || alert.user_id !== currentUser.userId) {
        return { status: 404, data: { error: "Alert not found" } };
      }
      return { status: 200, data: alert };
    }
    
    if (method === "PUT" && path.startsWith("/api/alerts/")) {
      const id = path.substring("/api/alerts/".length);
      const existing = getAlert(id);
      if (!existing || existing.user_id !== currentUser.userId) {
        return { status: 404, data: { error: "Alert not found" } };
      }
      
      const updates = {};
      if (body.symbol !== undefined) updates.symbol = body.symbol.toUpperCase();
      if (body.condition_type !== undefined) updates.condition_type = body.condition_type;
      if (body.threshold !== undefined) updates.threshold = body.threshold;
      if (body.poll_interval_sec !== undefined) updates.poll_interval_sec = body.poll_interval_sec;
      if (body.cooldown_sec !== undefined) updates.cooldown_sec = body.cooldown_sec;
      if (body.is_enabled !== undefined) updates.is_enabled = body.is_enabled;
      if (body.notify_times !== undefined) updates.notify_times = body.notify_times;
      
      updateAlert(id, updates);
      
      const updated = getAlert(id);
      if (updated) {
        applyChange("update", updated);
      }
      
      return { status: 200, data: updated };
    }
    
    if (method === "PATCH" && path.startsWith("/api/alerts/")) {
      const id = path.substring("/api/alerts/".length);
      const existing = getAlert(id);
      if (!existing || existing.user_id !== currentUser.userId) {
        return { status: 404, data: { error: "Alert not found" } };
      }
      
      const updates = {};
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
      if (!existing || existing.user_id !== currentUser.userId) {
        return { status: 404, data: { error: "Alert not found" } };
      }
      
      deleteAlert(id);
      applyChange("delete", existing);
      
      return { status: 200, data: { success: true } };
    }
    
    // 测试警报通知
    if (method === "POST" && path.match(/\/api\/alerts\/[^/]+\/test/)) {
      const match = path.match(/\/api\/alerts\/([^/]+)\/test/);
      if (!match) {
        return { status: 404, data: { error: "Invalid path" } };
      }
      const id = match[1];
      const alert = getAlert(id);
      if (!alert || alert.user_id !== currentUser.userId) {
        return { status: 404, data: { error: "Alert not found" } };
      }
      
      // 使用用户的 Telegram 配置发送测试
      const user = getUserById(currentUser.userId);
      const result = await sendTestNotification(id, alert.symbol, body.message, user.telegram);
      
      const now = Math.floor(Date.now() / 1000);
      createAlertEvent({
        user_id: currentUser.userId,
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
    
    // ============ 事件日志 ============
    if (method === "GET" && path === "/api/events") {
      const limit = parseInt(headers["x-limit"] || "200");
      const symbol = headers["x-symbol"];
      const events = getEventsByUser(currentUser.userId, Math.min(limit, 500), symbol);
      return { status: 200, data: events };
    }
    
    // 价格查询
    if (method === "GET" && path.startsWith("/api/price/")) {
      const symbol = path.substring("/api/price/".length);
      try {
        const price = await getSpotPrice(symbol);
        return { status: 200, data: price };
      } catch (error) {
        return { status: 400, data: { error: error.message } };
      }
    }
    
    // 引擎控制
    if (method === "POST" && path === "/api/engine/rebuild") {
      rebuildFromDb();
      return { status: 200, data: { success: true, ...getEngineStatus() } };
    }
    
    return { status: 404, data: { error: "Not found" } };
    
  } catch (error) {
    console.error("[PriceAlert] API Error:", error);
    return { status: 500, data: { error: error.message || "Internal error" } };
  }
}

module.exports = {
  initializeAuth,
  isInitialized,
  handleRequest
};

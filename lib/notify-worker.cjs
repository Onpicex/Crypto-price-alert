const axios = require("axios");
const { updateAlertEventStatus } = require("./db.cjs");

const notifyQueue = { tasks: [], isProcessing: false };
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 3000, 10000];
const RATE_LIMIT_DELAY = 500;

let lastSendTime = 0;

function pushToNotifyQueue(task) {
  notifyQueue.tasks.push(task);
  processQueue();
}

async function processQueue() {
  if (notifyQueue.isProcessing || notifyQueue.tasks.length === 0) return;
  
  notifyQueue.isProcessing = true;
  
  while (notifyQueue.tasks.length > 0) {
    const task = notifyQueue.tasks.shift();
    await processTask(task);
  }
  
  notifyQueue.isProcessing = false;
}

async function processTask(task) {
  const now = Date.now();
  const timeSinceLastSend = now - lastSendTime;
  if (timeSinceLastSend < RATE_LIMIT_DELAY) {
    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY - timeSinceLastSend));
  }
  lastSendTime = Date.now();
  
  let attempts = 0;
  let lastError;
  
  while (attempts < MAX_RETRIES) {
    attempts++;
    
    try {
      await sendTelegramNotification(task);
      updateAlertEventStatus(task.eventId, "success");
      console.log(`[PriceAlert] Notification sent: event=${task.eventId}, alert=${task.alertId}`);
      return;
    } catch (error) {
      lastError = error.message || String(error);
      console.error(`[PriceAlert] Notification attempt ${attempts} failed:`, lastError);
      
      if (attempts < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[attempts - 1] || RETRY_DELAYS[RETRY_DELAYS.length - 1]));
      }
    }
  }
  
  updateAlertEventStatus(task.eventId, "failed", lastError);
  console.error(`[PriceAlert] Notification failed after ${MAX_RETRIES} attempts: event=${task.eventId}, error=${lastError}`);
}

async function sendTelegramNotification(task) {
  // task 包含 telegram 配置（用户个人的）
  const botToken = task.telegram?.bot_token;
  const chatId = task.telegram?.chat_id;
  
  if (!botToken || !chatId) {
    throw new Error("Telegram not configured");
  }
  
  const message = buildAlertMessage(task);
  
  const response = await axios.post(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    { chat_id: chatId, text: message, parse_mode: "HTML" },
    { timeout: 10000 }
  );
  
  if (!response.data.ok) {
    throw new Error(`Telegram API error: ${response.data.description}`);
  }
}

function buildAlertMessage(task) {
  const time = new Date(task.triggeredAt * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  
  let emoji = "🔔";
  if (task.conditionType && task.conditionType.includes("down")) emoji = "📉";
  else if (task.conditionType && task.conditionType.includes("pct_change")) emoji = "📊";
  
  return `${emoji} <b>价格警报</b>

<b>交易对:</b> ${task.symbol}
<b>条件:</b> ${task.conditionType}
<b>阈值:</b> ${task.threshold}
<b>当前价格:</b> ${task.price ? task.price.toLocaleString() : 'N/A'}
<b>触发原因:</b> ${task.reason}
<b>时间:</b> ${time}`;
}

async function testTelegram(botToken, testChatId) {
  try {
    const response = await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      { chat_id: testChatId, text: "🧪 <b>测试消息</b>\n\nOpenClaw Price Alert 配置成功！", parse_mode: "HTML" },
      { timeout: 10000 }
    );
    
    if (!response.data.ok) {
      return { success: false, error: response.data.description };
    }
    
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
}

async function sendTestNotification(alertId, symbol, customMessage, telegramConfig) {
  const botToken = telegramConfig?.bot_token;
  const chatId = telegramConfig?.chat_id;
  
  if (!botToken || !chatId) {
    return { success: false, error: "Telegram not configured" };
  }
  
  try {
    const message = customMessage || `🧪 <b>测试警报</b>\n\n这是来自 OpenClaw Price Alert 的测试消息。\n交易对: ${symbol}`;
    
    const response = await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      { chat_id: chatId, text: message, parse_mode: "HTML" },
      { timeout: 10000 }
    );
    
    if (!response.data.ok) {
      return { success: false, error: response.data.description };
    }
    
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message || String(error) };
  }
}

module.exports = {
  pushToNotifyQueue,
  testTelegram,
  sendTestNotification
};

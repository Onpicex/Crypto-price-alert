import axios from "axios";
import { updateAlertEventStatus, getSetting } from "./db.js";

interface NotifyTask {
  eventId: number;
  alertId: string;
  symbol: string;
  conditionType: string;
  threshold: number;
  price: number;
  reason: string;
  triggeredAt: number;
}

interface NotifyQueue {
  tasks: NotifyTask[];
  isProcessing: boolean;
}

const notifyQueue: NotifyQueue = {
  tasks: [],
  isProcessing: false
};

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 3000, 10000]; // 1s, 3s, 10s
const RATE_LIMIT_DELAY = 500; // 500ms between messages

let lastSendTime = 0;

/**
 * Push a notification task to the queue
 */
export function pushToNotifyQueue(task: NotifyTask): void {
  notifyQueue.tasks.push(task);
  processQueue();
}

/**
 * Process the notification queue
 */
async function processQueue(): Promise<void> {
  if (notifyQueue.isProcessing || notifyQueue.tasks.length === 0) return;
  
  notifyQueue.isProcessing = true;
  
  while (notifyQueue.tasks.length > 0) {
    const task = notifyQueue.tasks.shift()!;
    await processTask(task);
  }
  
  notifyQueue.isProcessing = false;
}

/**
 * Process a single notification task
 */
async function processTask(task: NotifyTask): Promise<void> {
  // Rate limiting
  const now = Date.now();
  const timeSinceLastSend = now - lastSendTime;
  if (timeSinceLastSend < RATE_LIMIT_DELAY) {
    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY - timeSinceLastSend));
  }
  lastSendTime = Date.now();
  
  let attempts = 0;
  let lastError: string | undefined;
  
  while (attempts < MAX_RETRIES) {
    attempts++;
    
    try {
      await sendTelegramNotification(task);
      
      // Success
      updateAlertEventStatus(task.eventId, "success");
      console.log(`[PriceAlert] Notification sent: event=${task.eventId}, alert=${task.alertId}`);
      return;
    } catch (error: any) {
      lastError = error.message || String(error);
      console.error(`[PriceAlert] Notification attempt ${attempts} failed:`, lastError);
      
      if (attempts < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[attempts - 1] || RETRY_DELAYS[RETRY_DELAYS.length - 1]));
      }
    }
  }
  
  // All retries failed
  updateAlertEventStatus(task.eventId, "failed", lastError);
  console.error(`[PriceAlert] Notification failed after ${MAX_RETRIES} attempts: event=${task.eventId}, error=${lastError}`);
}

/**
 * Send notification via Telegram
 */
async function sendTelegramNotification(task: NotifyTask): Promise<void> {
  const botToken = getSetting("telegram.bot_token");
  const chatId = getSetting("telegram.chat_id");
  
  if (!botToken || !chatId) {
    throw new Error("Telegram not configured: missing bot_token or chat_id");
  }
  
  const message = buildAlertMessage(task);
  
  const response = await axios.post(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      chat_id: chatId,
      text: message,
      parse_mode: "HTML"
    },
    {
      timeout: 10000
    }
  );
  
  if (!response.data.ok) {
    throw new Error(`Telegram API error: ${response.data.description}`);
  }
}

/**
 * Build the alert message
 */
function buildAlertMessage(task: NotifyTask): string {
  const time = new Date(task.triggeredAt * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  
  let emoji = "🔔";
  if (task.conditionType.includes("down")) emoji = "📉";
  else if (task.conditionType.includes("pct_change")) emoji = "📊";
  
  return `${emoji} <b>价格警报</b>

<b>交易对:</b> ${task.symbol}
<b>条件:</b> ${task.conditionType}
<b>阈值:</b> ${task.threshold}
<b>当前价格:</b> ${task.price.toLocaleString()}
<b>触发原因:</b> ${task.reason}
<b>时间:</b> ${time}`;
}

/**
 * Test Telegram configuration
 */
export async function testTelegram(botToken: string, testChatId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        chat_id: testChatId,
        text: "🧪 <b>测试消息</b>\n\nOpenClaw Price Alert 配置成功！",
        parse_mode: "HTML"
      },
      {
        timeout: 10000
      }
    );
    
    if (!response.data.ok) {
      return { success: false, error: response.data.description };
    }
    
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message || String(error) };
  }
}

/**
 * Send a test notification for a specific alert
 */
export async function sendTestNotification(alertId: string, symbol: string, customMessage?: string): Promise<{ success: boolean; error?: string }> {
  const botToken = getSetting("telegram.bot_token");
  const chatId = getSetting("telegram.chat_id");
  
  if (!botToken || !chatId) {
    return { success: false, error: "Telegram not configured" };
  }
  
  try {
    const message = customMessage || `🧪 <b>测试警报</b>\n\n这是来自 OpenClaw Price Alert 的测试消息。\n交易对: ${symbol}`;
    
    const response = await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        chat_id: chatId,
        text: message,
        parse_mode: "HTML"
      },
      {
        timeout: 10000
      }
    );
    
    if (!response.data.ok) {
      return { success: false, error: response.data.description };
    }
    
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message || String(error) };
  }
}

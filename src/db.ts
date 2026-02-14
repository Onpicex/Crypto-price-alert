import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DB_PATH = path.join(process.env.OPENCLAW_STATE_DIR || ".", "price-alert.db");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    // Ensure directory exists
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    initTables();
  }
  return db;
}

function initTables() {
  if (!db) return;
  
  // Settings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);
  
  // Alerts table
  db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      condition_type TEXT NOT NULL,
      threshold REAL NOT NULL,
      poll_interval_sec INTEGER NOT NULL,
      cooldown_sec INTEGER NOT NULL DEFAULT 300,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      last_triggered_at INTEGER,
      last_state TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);
  
  // Alert events table
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      reason TEXT,
      price REAL,
      threshold REAL,
      notify_status TEXT DEFAULT 'pending',
      error_message TEXT,
      triggered_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (alert_id) REFERENCES alerts(id)
    )
  `);
  
  // Create indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_alerts_symbol ON alerts(symbol);
    CREATE INDEX IF NOT EXISTS idx_alerts_enabled ON alerts(is_enabled);
    CREATE INDEX IF NOT EXISTS idx_events_alert_id ON alert_events(alert_id);
    CREATE INDEX IF NOT EXISTS idx_events_triggered_at ON alert_events(triggered_at);
  `);
}

// Settings operations
export function getSetting(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb().prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%s', 'now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value);
}

export function getSettings(): Record<string, string> {
  const rows = getDb().prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const settings: Record<string, string> = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  return settings;
}

// Alert operations
export interface Alert {
  id: string;
  symbol: string;
  condition_type: string;
  threshold: number;
  poll_interval_sec: number;
  cooldown_sec: number;
  is_enabled: boolean;
  last_triggered_at: number | null;
  last_state: Record<string, any> | null;
  created_at: number;
  updated_at: number;
}

export function createAlert(alert: Omit<Alert, "created_at" | "updated_at">): Alert {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(`
    INSERT INTO alerts (id, symbol, condition_type, threshold, poll_interval_sec, cooldown_sec, is_enabled, last_triggered_at, last_state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    alert.id,
    alert.symbol,
    alert.condition_type,
    alert.threshold,
    alert.poll_interval_sec,
    alert.cooldown_sec,
    alert.is_enabled ? 1 : 0,
    alert.last_triggered_at,
    alert.last_state ? JSON.stringify(alert.last_state) : null,
    now,
    now
  );
  return { ...alert, created_at: now, updated_at: now };
}

export function updateAlert(id: string, updates: Partial<Alert>): void {
  const now = Math.floor(Date.now() / 1000);
  const fields: string[] = [];
  const values: any[] = [];
  
  if (updates.symbol !== undefined) { fields.push("symbol = ?"); values.push(updates.symbol); }
  if (updates.condition_type !== undefined) { fields.push("condition_type = ?"); values.push(updates.condition_type); }
  if (updates.threshold !== undefined) { fields.push("threshold = ?"); values.push(updates.threshold); }
  if (updates.poll_interval_sec !== undefined) { fields.push("poll_interval_sec = ?"); values.push(updates.poll_interval_sec); }
  if (updates.cooldown_sec !== undefined) { fields.push("cooldown_sec = ?"); values.push(updates.cooldown_sec); }
  if (updates.is_enabled !== undefined) { fields.push("is_enabled = ?"); values.push(updates.is_enabled ? 1 : 0); }
  if (updates.last_triggered_at !== undefined) { fields.push("last_triggered_at = ?"); values.push(updates.last_triggered_at); }
  if (updates.last_state !== undefined) { fields.push("last_state = ?"); values.push(updates.last_state ? JSON.stringify(updates.last_state) : null); }
  
  if (fields.length === 0) return;
  
  fields.push("updated_at = ?");
  values.push(now);
  values.push(id);
  
  getDb().prepare(`UPDATE alerts SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteAlert(id: string): void {
  getDb().prepare("DELETE FROM alerts WHERE id = ?").run(id);
}

export function getAlert(id: string): Alert | null {
  const row = getDb().prepare("SELECT * FROM alerts WHERE id = ?").get(id) as any;
  if (!row) return null;
  return {
    ...row,
    is_enabled: row.is_enabled === 1,
    last_state: row.last_state ? JSON.parse(row.last_state) : null
  };
}

export function getAllAlerts(): Alert[] {
  const rows = getDb().prepare("SELECT * FROM alerts ORDER BY created_at DESC").all() as any[];
  return rows.map(row => ({
    ...row,
    is_enabled: row.is_enabled === 1,
    last_state: row.last_state ? JSON.parse(row.last_state) : null
  }));
}

export function getEnabledAlerts(): Alert[] {
  const rows = getDb().prepare("SELECT * FROM alerts WHERE is_enabled = 1").all() as any[];
  return rows.map(row => ({
    ...row,
    is_enabled: row.is_enabled === 1,
    last_state: row.last_state ? JSON.parse(row.last_state) : null
  }));
}

// Alert events operations
export interface AlertEvent {
  id?: number;
  alert_id: string;
  event_type: string;
  reason?: string;
  price?: number;
  threshold?: number;
  notify_status: string;
  error_message?: string;
  triggered_at: number;
}

export function createAlertEvent(event: Omit<AlertEvent, "id">): number {
  const result = getDb().prepare(`
    INSERT INTO alert_events (alert_id, event_type, reason, price, threshold, notify_status, error_message, triggered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.alert_id,
    event.event_type,
    event.reason ?? null,
    event.price ?? null,
    event.threshold ?? null,
    event.notify_status,
    event.error_message ?? null,
    event.triggered_at
  );
  return result.lastInsertRowid as number;
}

export function getAlertEvents(limit: number = 200, symbol?: string): AlertEvent[] {
  let sql = "SELECT * FROM alert_events";
  const params: any[] = [];
  
  if (symbol) {
    sql += " WHERE alert_id IN (SELECT id FROM alerts WHERE symbol = ?)";
    params.push(symbol.toUpperCase());
  }
  
  sql += " ORDER BY triggered_at DESC LIMIT ?";
  params.push(limit);
  
  return getDb().prepare(sql).all(...params) as AlertEvent[];
}

export function updateAlertEventStatus(id: number, status: string, errorMessage?: string): void {
  getDb().prepare(`
    UPDATE alert_events SET notify_status = ?, error_message = ? WHERE id = ?
  `).run(status, errorMessage ?? null, id);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

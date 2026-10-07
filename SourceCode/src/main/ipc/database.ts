// 数据库模块 (使用 sql.js - 纯 JavaScript 实现)

import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { DB_TABLES } from '../../shared/constants';

// 表名常量
const TABLE_LOG = DB_TABLES.LOG;
const TABLE_SETTING = DB_TABLES.SETTING;
const TABLE_PROD_RECORD = DB_TABLES.PROD_RECORD;
const TABLE_EDITOR_STATE = DB_TABLES.EDITOR_STATE;

// 数据库路径
function getDbPath(): string {
  const dataDir = app.getPath('userData');
  return path.join(dataDir, 'ZoomlaXizhi.db');
}

// 数据库实例
let db: any = null;
let SQL: any = null;

// 初始化数据库
export async function initDatabase(): Promise<void> {
  const dbPath = getDbPath();

  // 加载 sql.js
  SQL = await initSqlJs({
    locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm'),
  });

  // 尝试加载现有数据库
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // 创建表
  db.exec(`
    -- 日志表
    CREATE TABLE IF NOT EXISTS ${TABLE_LOG} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created DATETIME DEFAULT CURRENT_TIMESTAMP,
      message TEXT
    );

    -- 设置表
    CREATE TABLE IF NOT EXISTS ${TABLE_SETTING} (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- 生产记录表
    CREATE TABLE IF NOT EXISTS ${TABLE_PROD_RECORD} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT,
      base_font TEXT,
      output_file TEXT,
      glyph_count INTEGER
    );

    CREATE TABLE IF NOT EXISTS ${TABLE_EDITOR_STATE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 保存到文件
  saveDb();

  console.log(`数据库已初始化：${dbPath}`);
}

// 保存数据库
function saveDb(): void {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(getDbPath(), buffer);
}

// 获取数据库实例
export function getDb(): any {
  if (!db) {
    throw new Error('数据库未初始化');
  }
  return db;
}

// 添加日志
export function addLog(message: string): number {
  db.run(`INSERT INTO ${TABLE_LOG} (message) VALUES (?)`, [message]);
  const result = db.exec('SELECT last_insert_rowid() AS id');
  saveDb();
  return Number(result[0]?.values[0]?.[0] ?? 0);
}

// 获取日志列表
export function getLogs(limit: number = 500): Array<{ id: number; created: Date; message: string }> {
  const stmt = db.prepare(`
    SELECT id, created, message
    FROM ${TABLE_LOG}
    ORDER BY id DESC
    LIMIT ?
  `);
  stmt.bind([limit]);
  const rows: any[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows.map((row: any) => ({
    id: row.id,
    created: new Date(row.created),
    message: row.message,
  }));
}

// 清空日志
export function clearLogs(): void {
  db.run(`DELETE FROM ${TABLE_LOG}`);
  saveDb();
}

// 按ID批量删除日志
export function deleteLogsByIds(ids: number[]): number {
  if (!ids || ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');
  db.run(`DELETE FROM ${TABLE_LOG} WHERE id IN (${placeholders})`, ids);
  saveDb();
  const result = db.exec('SELECT changes() AS n');
  return Number(result[0]?.values[0]?.[0] ?? 0);
}

// 按时间段查询日志
export function getLogsByDateRange(startDate: string, endDate: string, limit: number = 500): Array<{ id: number; created: Date; message: string }> {
  const stmt = db.prepare(`
    SELECT id, created, message
    FROM ${TABLE_LOG}
    WHERE date(created) >= date(?) AND date(created) <= date(?)
    ORDER BY id DESC
    LIMIT ?
  `);
  stmt.bind([startDate, endDate, limit]);
  const rows: any[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows.map((row: any) => ({
    id: row.id,
    created: new Date(row.created),
    message: row.message,
  }));
}

// 按天删除日志（删除指定日期及之前的所有日志）
export function deleteLogsByDate(beforeOrEqual: string): number {
  db.run(`DELETE FROM ${TABLE_LOG} WHERE date(created) <= date(?)`, [beforeOrEqual]);
  saveDb();
  const result = db.exec('SELECT changes() AS n');
  return Number(result[0]?.values[0]?.[0] ?? 0);
}

// 获取设置
export function getSetting(key: string, defaultValue: string = ''): string {
  const stmt = db.prepare(`SELECT value FROM ${TABLE_SETTING} WHERE key = ?`);
  stmt.bind([key]);
  const row: any = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row?.value || defaultValue;
}

// 设置设置
export function setSetting(key: string, value: string): void {
  db.run(`INSERT OR REPLACE INTO ${TABLE_SETTING} (key, value) VALUES (?, ?)`, [key, value]);
  saveDb();
}

export function getEditorState(key: string, defaultValue: string = ''): string {
  const stmt = db.prepare(`SELECT value FROM ${TABLE_EDITOR_STATE} WHERE key = ?`);
  stmt.bind([key]);
  const row: any = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row?.value || defaultValue;
}

export function setEditorState(key: string, value: string): void {
  db.run(
    `INSERT OR REPLACE INTO ${TABLE_EDITOR_STATE} (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
    [key, value],
  );
  saveDb();
}

// 添加生产记录
export function addProdRecord(baseFont: string, outputFile: string, glyphCount: number): number {
  const timestamp = new Date().toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  db.run(`
    INSERT INTO ${TABLE_PROD_RECORD} (timestamp, base_font, output_file, glyph_count)
    VALUES (?, ?, ?, ?)
  `, [timestamp, baseFont, outputFile, glyphCount]);
  const result = db.exec('SELECT last_insert_rowid() AS id');
  saveDb();
  return Number(result[0]?.values[0]?.[0] ?? 0);
}

// 获取生产记录
export function getProdRecords(): Array<{
  id: number;
  timestamp: string;
  base_font: string;
  output_file: string;
  glyph_count: number;
}> {
  const stmt = db.prepare(`
    SELECT id, timestamp, base_font, output_file, glyph_count
    FROM ${TABLE_PROD_RECORD}
    ORDER BY id DESC
  `);
  const rows: any[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows.map((row: any) => ({
    id: row.id,
    timestamp: row.timestamp,
    base_font: row.base_font,
    output_file: row.output_file,
    glyph_count: row.glyph_count,
  }));
}

// 删除生产记录
export function deleteProdRecord(id: number): void {
  db.run(`DELETE FROM ${TABLE_PROD_RECORD} WHERE id = ?`, [id]);
  saveDb();
}

// 添加生产记录（带裁剪逻辑）
export function addProdRecordWithTrim(baseFont: string, outputFile: string, glyphCount: number): number {
  const id = addProdRecord(baseFont, outputFile, glyphCount);
  db.run(`
    DELETE FROM ${TABLE_PROD_RECORD}
    WHERE id NOT IN (
      SELECT id FROM ${TABLE_PROD_RECORD} ORDER BY id DESC LIMIT 200
    )
  `);
  saveDb();
  return id;
}

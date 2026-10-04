import initSqlJs from 'sql.js';

// 扩展 sql.js 的类型定义
declare module 'sql.js' {
  interface Database {
    export(): Uint8Array;
  }

  interface Statement {
    all(params?: any[]): any[];
    get(params?: any): any;
    run(params?: any[]): { changes: number; lastInsertRowid: number };
  }

  interface SqlValue {
    [key: string]: any;
  }
}

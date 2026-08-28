// v0.14 本地日志系统：监控整个游戏的运行状况，落盘到 mad-god/logs/game.log。
// 链路：Logger（环形缓冲 + 节流）→ HttpSink 批量 POST /log → vite 中间件追加写文件。
// 约定：日志只用于诊断，任何日志失败都必须静默，绝不影响游戏本身。

export enum LogLevel {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
}

export interface LogEntry {
  /** 游戏内累计时间（秒） */
  t: number;
  /** 墙钟时间戳（毫秒） */
  wall: number;
  level: LogLevel;
  /** 类别：session / sim / produce / js ... */
  cat: string;
  msg: string;
  data?: Record<string, unknown>;
}

export interface LogSink {
  write(entries: LogEntry[]): void;
}

/** 浏览器侧：批量 POST 到同源 /log（vite 插件接收）。失败静默丢弃。 */
export class HttpSink implements LogSink {
  dropped = 0;

  write(entries: LogEntry[]): void {
    if (!entries.length) return;
    try {
      fetch("/log", {
        method: "POST",
        body: JSON.stringify(entries),
        headers: { "content-type": "application/json" },
        keepalive: true,
      }).catch(() => {
        this.dropped++;
      });
    } catch {
      this.dropped++;
    }
  }
}

/** 测试侧：内存收集，便于断言。 */
export class MemorySink implements LogSink {
  entries: LogEntry[] = [];

  write(entries: LogEntry[]): void {
    this.entries.push(...entries);
  }
}

interface ThrottleState {
  until: number;
  count: number;
  level: LogLevel;
  cat: string;
  msg: string;
}

export class Logger {
  private buf: LogEntry[] = [];
  private throttles = new Map<string, ThrottleState>();
  private periods = new Map<string, number>();
  private acc = 0;
  private sink: LogSink;
  /** 游戏内时间（秒），由 tick 推进 */
  time = 0;
  minLevel = LogLevel.Debug;

  constructor(
    sink: LogSink,
    private ringCap = 600,
    private flushEvery = 0.5,
    private flushAt = 24,
    private now: () => number = () => Date.now(),
  ) {
    this.sink = sink;
  }

  setSink(sink: LogSink): void {
    this.sink = sink;
  }

  clear(): void {
    this.buf.length = 0;
    this.throttles.clear();
    this.periods.clear();
    this.acc = 0;
  }

  /** 当前环形缓冲内条目（测试/调试用）。 */
  entries(): readonly LogEntry[] {
    return this.buf;
  }

  log(level: LogLevel, cat: string, msg: string, data?: Record<string, unknown>): void {
    if (level < this.minLevel) return;
    const e: LogEntry = { t: +this.time.toFixed(3), wall: this.now(), level, cat, msg };
    if (data) e.data = data;
    this.buf.push(e);
    if (this.buf.length > this.ringCap) this.buf.splice(0, this.buf.length - this.ringCap);
    if (this.buf.length >= this.flushAt) this.flush();
  }

  debug(cat: string, msg: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.Debug, cat, msg, data);
  }

  info(cat: string, msg: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.Info, cat, msg, data);
  }

  warn(cat: string, msg: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.Warn, cat, msg, data);
  }

  error(cat: string, msg: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.Error, cat, msg, data);
  }

  /**
   * 事件合并：同 key 在 windowMs 内的重复事件，首条立即记录，
   * 窗口结束后续条汇总为一条 "msg ×N"。适合高频重复的告警（如人口达顶）。
   */
  throttled(
    key: string,
    windowMs: number,
    level: LogLevel,
    cat: string,
    msg: string,
    data?: Record<string, unknown>,
  ): void {
    const nowMs = this.now();
    const st = this.throttles.get(key);
    if (!st || nowMs >= st.until) {
      this.closeThrottle(key);
      this.throttles.set(key, { until: nowMs + windowMs, count: 1, level, cat, msg });
      this.log(level, cat, msg, data);
    } else {
      st.count++;
    }
  }

  private closeThrottle(key: string): void {
    const st = this.throttles.get(key);
    if (!st) return;
    this.throttles.delete(key);
    if (st.count > 1) this.log(st.level, st.cat, `${st.msg} ×${st.count}`);
  }

  /**
   * 周期快照：每 intervalMs 记录一条，data 取当下最新值（每帧调用只在到期时真正落一条）。
   * 适合状态快照（每座茅屋每秒一条、全局心跳每秒一条）。
   */
  periodic(
    key: string,
    intervalMs: number,
    level: LogLevel,
    cat: string,
    msg: string,
    data: () => Record<string, unknown>,
  ): void {
    const nowMs = this.now();
    const due = this.periods.get(key) ?? 0;
    if (nowMs < due) return;
    this.periods.set(key, nowMs + intervalMs);
    this.log(level, cat, msg, data());
  }

  /** 每帧驱动：推进游戏时间、收尾到期的事件合并窗口、按 flushEvery 批量上报。 */
  tick(dt: number): void {
    this.time += dt;
    this.acc += dt;
    const nowMs = this.now();
    for (const [key, st] of this.throttles) {
      if (nowMs >= st.until) this.closeThrottle(key);
    }
    if (this.acc >= this.flushEvery) this.flush();
  }

  flush(): void {
    this.acc = 0;
    if (!this.buf.length) return;
    const batch = this.buf.splice(0);
    try {
      this.sink.write(batch);
    } catch {
      // sink 故障不影响游戏：批次放回队首，下次 flush 重试。
      this.buf.unshift(...batch);
      if (this.buf.length > this.ringCap) this.buf.splice(0, this.buf.length - this.ringCap);
    }
  }
}

export const logger = new Logger(typeof window !== "undefined" ? new HttpSink() : new MemorySink());

// 页面卸载前尽力把缓冲冲出去（keepalive fetch 允许在卸载后完成）。
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => logger.flush());
}

import fs from "node:fs/promises";
import path from "node:path";

function toIsoNow() {
  return new Date().toISOString();
}

export function createAuditLoggerFromEnv() {
  const logPath = String(process.env.OPENJACK_AUDIT_LOG_PATH || "").trim();
  const summaryPath = String(process.env.OPENJACK_AUDIT_SUMMARY_PATH || "").trim();
  return new AuditLogger({ logPath, summaryPath });
}

class AuditLogger {
  constructor({ logPath = "", summaryPath = "" } = {}) {
    this.logPath = logPath;
    this.summaryPath = summaryPath;
    this._ready = false;
  }

  get enabled() {
    return Boolean(this.logPath || this.summaryPath);
  }

  async ensureReady() {
    if (this._ready) return;
    const dirs = new Set();
    if (this.logPath) dirs.add(path.dirname(path.resolve(this.logPath)));
    if (this.summaryPath) dirs.add(path.dirname(path.resolve(this.summaryPath)));
    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
    }
    this._ready = true;
  }

  async log(type, payload = {}) {
    if (!this.logPath) return;
    await this.ensureReady();
    const line = JSON.stringify({
      ts: toIsoNow(),
      type,
      ...payload,
    });
    await fs.appendFile(path.resolve(this.logPath), `${line}\n`, "utf8");
  }

  async writeSummary(summary) {
    if (!this.summaryPath) return;
    await this.ensureReady();
    await fs.writeFile(
      path.resolve(this.summaryPath),
      `${JSON.stringify({ generatedAt: toIsoNow(), ...summary }, null, 2)}\n`,
      "utf8",
    );
  }
}


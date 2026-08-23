import { config } from "../config.js";
import type { AuditEvent } from "./audit.js";

export interface AuditExportRecord {
  event: AuditEvent;
  userId?: string;
  orgId?: string;
  appId?: string;
  ip?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface AuditSink {
  send(record: AuditExportRecord): Promise<void>;
}

class WebhookSink implements AuditSink {
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  async send(record: AuditExportRecord): Promise<void> {
    await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
  }
}

class ConsoleSink implements AuditSink {
  async send(record: AuditExportRecord): Promise<void> {
    console.log("[audit-export]", JSON.stringify(record));
  }
}

function createSinks(): AuditSink[] {
  const sinks: AuditSink[] = [];
  const webhookUrl = config.AUDIT_WEBHOOK_URL || process.env.AUDIT_WEBHOOK_URL;
  if (webhookUrl) {
    sinks.push(new WebhookSink(webhookUrl));
  }
  if (config.AUDIT_CONSOLE_EXPORT === "true" || process.env.AUDIT_CONSOLE_EXPORT === "true") {
    sinks.push(new ConsoleSink());
  }
  return sinks;
}

export const auditSinks = createSinks();

export async function exportAuditRecord(record: AuditExportRecord): Promise<void> {
  await Promise.all(auditSinks.map((sink) => sink.send(record).catch((err: unknown) => {
    console.error("[audit-export] sink failed:", err);
  })));
}

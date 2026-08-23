import { config } from "../config.js";
import { getPluginEmailProvider } from "./plugins/registry.js";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailProvider {
  name?: string;
  send(message: EmailMessage): Promise<void>;
}

class NoOpEmailProvider implements EmailProvider {
  async send(message: EmailMessage): Promise<void> {
    console.log("[email] no-op provider would send:", JSON.stringify(message));
  }
}

class ConsoleEmailProvider implements EmailProvider {
  async send(message: EmailMessage): Promise<void> {
    console.log("[email] console provider:");
    console.log(`To: ${message.to}`);
    console.log(`Subject: ${message.subject}`);
    console.log(message.text);
  }
}

class SmtpEmailProvider implements EmailProvider {
  private transporter: import("nodemailer").Transporter | null = null;

  async send(message: EmailMessage): Promise<void> {
    if (!this.transporter) {
      const { createTransport } = await import("nodemailer");
      this.transporter = createTransport({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: config.SMTP_SECURE,
        auth:
          config.SMTP_USER && config.SMTP_PASS
            ? { user: config.SMTP_USER, pass: config.SMTP_PASS }
            : undefined,
      });
    }

    await this.transporter.sendMail({
      from: config.EMAIL_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}

class SendGridEmailProvider implements EmailProvider {
  async send(message: EmailMessage): Promise<void> {
    if (!config.SENDGRID_API_KEY) {
      throw new Error("SendGrid provider requires SENDGRID_API_KEY");
    }

    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.SENDGRID_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: message.to }] }],
        from: { email: config.EMAIL_FROM },
        subject: message.subject,
        content: [
          { type: "text/plain", value: message.text },
          ...(message.html ? [{ type: "text/html", value: message.html }] : []),
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`SendGrid request failed: ${response.status} ${body}`);
    }
  }
}

class MailgunEmailProvider implements EmailProvider {
  async send(message: EmailMessage): Promise<void> {
    if (!config.MAILGUN_API_KEY || !config.MAILGUN_DOMAIN) {
      throw new Error("Mailgun provider requires MAILGUN_API_KEY and MAILGUN_DOMAIN");
    }

    const params = new URLSearchParams();
    params.set("from", config.EMAIL_FROM);
    params.set("to", message.to);
    params.set("subject", message.subject);
    params.set("text", message.text);
    if (message.html) params.set("html", message.html);

    const response = await fetch(
      `https://api.mailgun.net/v3/${config.MAILGUN_DOMAIN}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`api:${config.MAILGUN_API_KEY}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Mailgun request failed: ${response.status} ${body}`);
    }
  }
}

function createEmailProvider(): EmailProvider {
  const plugin = getPluginEmailProvider();
  if (plugin) return plugin;

  const provider = config.EMAIL_PROVIDER || "none";
  switch (provider) {
    case "smtp":
      return new SmtpEmailProvider();
    case "sendgrid":
      return new SendGridEmailProvider();
    case "mailgun":
      return new MailgunEmailProvider();
    case "console":
      return new ConsoleEmailProvider();
    case "none":
    default:
      return new NoOpEmailProvider();
  }
}

export const emailProvider = createEmailProvider();

export async function sendNewDeviceAlert(input: {
  email: string;
  ipAddress?: string;
  userAgent?: string;
  deviceName?: string;
}): Promise<void> {
  await emailProvider.send({
    to: input.email,
    subject: "New sign-in from an unrecognized device",
    text: `A new device was used to sign in to your Hilbras account.\n\nIP: ${input.ipAddress || "unknown"}\nDevice: ${input.deviceName || input.userAgent || "unknown"}\n\nIf this wasn't you, please change your password immediately.`,
  });
}

export async function sendSuspiciousLoginAlert(input: {
  email: string;
  ipAddress?: string;
  userAgent?: string;
  reason: string;
}): Promise<void> {
  await emailProvider.send({
    to: input.email,
    subject: "Suspicious sign-in activity detected",
    text: `We detected suspicious sign-in activity on your Hilbras account.\n\nReason: ${input.reason}\nIP: ${input.ipAddress || "unknown"}\nDevice: ${input.userAgent || "unknown"}\n\nIf this wasn't you, please change your password immediately and review your active sessions.`,
    html: `<p>We detected suspicious sign-in activity on your Hilbras account.</p><ul><li><strong>Reason:</strong> ${input.reason}</li><li><strong>IP:</strong> ${input.ipAddress || "unknown"}</li><li><strong>Device:</strong> ${input.userAgent || "unknown"}</li></ul><p>If this wasn't you, please change your password immediately and review your active sessions.</p>`,
  });
}

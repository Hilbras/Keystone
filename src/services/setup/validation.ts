import postgres from "postgres";
import { Redis } from "ioredis";
import { ok, err, type Result } from "../../lib/result.js";
import type { DatabaseValidationInput, RedisValidationInput, EmailValidationInput, SmsValidationInput } from "./types.js";

export async function validateDatabase(input: DatabaseValidationInput): Promise<Result<void>> {
  const { databaseUrl } = input;
  if (!databaseUrl) {
    return err({ code: "MISSING_DATABASE_URL", message: "Database URL is required", statusCode: 400 });
  }

  let client: postgres.Sql | undefined;
  try {
    client = postgres(databaseUrl, { max: 1, connect_timeout: 5 });

    // Test basic connectivity.
    await client`SELECT 1`;

    // Test DDL privileges by creating and dropping a temporary table.
    await client`CREATE TABLE IF NOT EXISTS __keystone_setup_probe (id serial PRIMARY KEY)`;
    await client`ALTER TABLE __keystone_setup_probe ADD COLUMN IF NOT EXISTS probe_text text`;
    await client`DROP TABLE __keystone_setup_probe`;

    await client.end();
    return ok(undefined);
  } catch (error) {
    await client?.end().catch(() => {});
    const message = error instanceof Error ? error.message : "Database validation failed";
    return err({ code: "DATABASE_VALIDATION_FAILED", message, statusCode: 400 });
  }
}

export async function validateRedis(input: RedisValidationInput): Promise<Result<void>> {
  const { redisUrl } = input;
  if (!redisUrl) {
    return err({ code: "MISSING_REDIS_URL", message: "Redis URL is required", statusCode: 400 });
  }

  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    connectTimeout: 5000,
  });

  try {
    await redis.connect();
    await redis.ping();
    redis.disconnect();
    return ok(undefined);
  } catch (error) {
    try { redis.disconnect(); } catch { /* ignore */ }
    const message = error instanceof Error ? error.message : "Redis validation failed";
    return err({ code: "REDIS_VALIDATION_FAILED", message, statusCode: 400 });
  }
}

export async function validateEmail(input: EmailValidationInput, to: string): Promise<Result<void>> {
  if (input.provider === "none" || input.provider === "console") {
    return ok(undefined);
  }

  try {
    const provider = createTransientEmailProvider(input);
    await provider.send({
      to,
      subject: "Hilbras Keystone setup test",
      text: "This is a test message from the Hilbras Keystone setup wizard.",
    });
    return ok(undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Email validation failed";
    return err({ code: "EMAIL_VALIDATION_FAILED", message, statusCode: 400 });
  }
}

export async function validateSms(input: SmsValidationInput, to: string): Promise<Result<void>> {
  if (input.provider === "none" || input.provider === "console") {
    return ok(undefined);
  }

  try {
    const provider = createTransientSmsProvider(input);
    await provider.send({
      to,
      body: "Hilbras Keystone setup test message.",
    });
    return ok(undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : "SMS validation failed";
    return err({ code: "SMS_VALIDATION_FAILED", message, statusCode: 400 });
  }
}

function createTransientEmailProvider(input: EmailValidationInput) {
  return {
    send: async (message: { to: string; subject: string; text: string }) => {
      switch (input.provider) {
        case "smtp":
          return sendSmtp(input, message);
        case "sendgrid":
          return sendSendGrid(input, message);
        case "mailgun":
          return sendMailgun(input, message);
        default:
          throw new Error("Unsupported email provider");
      }
    },
  };
}

async function sendSmtp(input: EmailValidationInput, message: { to: string; subject: string; text: string }) {
  if (!input.smtpHost) throw new Error("SMTP host is required");
  const { createTransport } = await import("nodemailer");
  const transporter = createTransport({
    host: input.smtpHost,
    port: input.smtpPort || 587,
    secure: input.smtpSecure || false,
    auth: input.smtpUser && input.smtpPass ? { user: input.smtpUser, pass: input.smtpPass } : undefined,
  });
  await transporter.verify();
  await transporter.sendMail({
    from: input.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
  });
}

async function sendSendGrid(input: EmailValidationInput, message: { to: string; subject: string; text: string }) {
  if (!input.sendgridApiKey) throw new Error("SendGrid API key is required");
  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.sendgridApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: message.to }] }],
      from: { email: input.from },
      subject: message.subject,
      content: [{ type: "text/plain", value: message.text }],
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`SendGrid request failed: ${response.status} ${body}`);
  }
}

async function sendMailgun(input: EmailValidationInput, message: { to: string; subject: string; text: string }) {
  if (!input.mailgunApiKey || !input.mailgunDomain) throw new Error("Mailgun API key and domain are required");
  const params = new URLSearchParams();
  params.set("from", input.from);
  params.set("to", message.to);
  params.set("subject", message.subject);
  params.set("text", message.text);
  const response = await fetch(`https://api.mailgun.net/v3/${input.mailgunDomain}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`api:${input.mailgunApiKey}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Mailgun request failed: ${response.status} ${body}`);
  }
}

function createTransientSmsProvider(input: SmsValidationInput) {
  return {
    send: async (message: { to: string; body: string }) => {
      if (input.provider !== "twilio") throw new Error("Unsupported SMS provider");
      if (!input.twilioAccountSid || !input.twilioAuthToken) {
        throw new Error("Twilio account SID and auth token are required");
      }
      const params = new URLSearchParams();
      params.set("To", message.to);
      params.set("Body", message.body);
      if (input.twilioMessagingServiceSid) {
        params.set("MessagingServiceSid", input.twilioMessagingServiceSid);
      } else if (input.twilioFromNumber) {
        params.set("From", input.twilioFromNumber);
      } else {
        throw new Error("Twilio messaging service SID or from number is required");
      }
      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${input.twilioAccountSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${input.twilioAccountSid}:${input.twilioAuthToken}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params.toString(),
        }
      );
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Twilio request failed: ${response.status} ${body}`);
      }
    },
  };
}

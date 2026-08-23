import type { Result } from "../../lib/result.js";

export interface ConfigWriter {
  read(): Promise<Record<string, string | undefined>>;
  write(values: Record<string, string>): Promise<Result<void>>;
  backup(): Promise<Result<string>>;
}

export interface DatabaseValidationInput {
  databaseUrl: string;
}

export interface RedisValidationInput {
  redisUrl: string;
}

export interface EmailValidationInput {
  provider: "none" | "console" | "smtp" | "sendgrid" | "mailgun";
  from: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  smtpSecure?: boolean;
  sendgridApiKey?: string;
  mailgunApiKey?: string;
  mailgunDomain?: string;
}

export interface SmsValidationInput {
  provider: "none" | "console" | "twilio";
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFromNumber?: string;
  twilioMessagingServiceSid?: string;
}

export interface SetupConfigInput {
  env: Record<string, string>;
}

import { config } from "../config.js";
import { getPluginSmsProvider } from "./plugins/registry.js";

export interface SmsMessage {
  to: string;
  body: string;
}

export interface SmsProvider {
  name?: string;
  send(message: SmsMessage): Promise<void>;
}

class NoOpSmsProvider implements SmsProvider {
  async send(message: SmsMessage): Promise<void> {
    console.log("[sms] no-op provider would send:", JSON.stringify(message));
  }
}

class ConsoleSmsProvider implements SmsProvider {
  async send(message: SmsMessage): Promise<void> {
    console.log("[sms] console provider:");
    console.log(`To: ${message.to}`);
    console.log(message.body);
  }
}

class TwilioSmsProvider implements SmsProvider {
  async send(message: SmsMessage): Promise<void> {
    if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN) {
      throw new Error("Twilio provider requires TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN");
    }

    const params = new URLSearchParams();
    params.set("To", message.to);
    params.set("Body", message.body);

    if (config.TWILIO_MESSAGING_SERVICE_SID) {
      params.set("MessagingServiceSid", config.TWILIO_MESSAGING_SERVICE_SID);
    } else if (config.TWILIO_FROM_NUMBER) {
      params.set("From", config.TWILIO_FROM_NUMBER);
    } else {
      throw new Error("Twilio provider requires TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER");
    }

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${config.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.TWILIO_ACCOUNT_SID}:${config.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Twilio request failed: ${response.status} ${body}`);
    }
  }
}

function createSmsProvider(): SmsProvider {
  const plugin = getPluginSmsProvider();
  if (plugin) return plugin;

  const provider = config.SMS_PROVIDER || "none";
  switch (provider) {
    case "twilio":
      return new TwilioSmsProvider();
    case "console":
      return new ConsoleSmsProvider();
    case "none":
    default:
      return new NoOpSmsProvider();
  }
}

export const smsProvider = createSmsProvider();

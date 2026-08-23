export type EmailProvider = "none" | "console" | "smtp" | "sendgrid" | "mailgun";
export type SmsProvider = "none" | "console" | "twilio";
export type UiMode = "simple" | "advanced";

export interface InfrastructureConfig {
  databaseUrl: string;
  redisUrl: string;
}

export interface UrlsConfig {
  authApiPublicUrl: string;
  clientAppUrl: string;
  allowedOrigins: string;
  cookieDomain: string;
  cookieSecure: boolean;
}

export interface SecretsConfig {
  internalApiKey: string;
  encryptionKey: string;
  jwtPrivateKey: string;
  jwtPublicKey: string;
  autoGenerate: boolean;
}

export interface EmailConfig {
  provider: EmailProvider;
  from: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpSecure: boolean;
  sendgridApiKey: string;
  mailgunApiKey: string;
  mailgunDomain: string;
}

export interface SmsConfig {
  provider: SmsProvider;
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioFromNumber: string;
  twilioMessagingServiceSid: string;
}

export interface ConnectorConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  issuer?: string;
  domain?: string;
}

export interface ConnectorsConfig {
  google: ConnectorConfig;
  github: ConnectorConfig;
  azure: ConnectorConfig;
  okta: ConnectorConfig & { issuer: string };
  keycloak: ConnectorConfig & { issuer: string };
  zitadel: ConnectorConfig & { domain: string };
}

export interface OwnerConfig {
  email: string;
  password: string;
  name: string;
}

export interface WizardState {
  infrastructure: InfrastructureConfig;
  urls: UrlsConfig;
  secrets: SecretsConfig;
  email: EmailConfig;
  sms: SmsConfig;
  connectors: ConnectorsConfig;
  owner: OwnerConfig;
}

export const initialState: WizardState = {
  infrastructure: {
    databaseUrl: "postgresql://hilbras:hilbras@localhost:5432/hilbras",
    redisUrl: "redis://localhost:6379",
  },
  urls: {
    authApiPublicUrl: "http://localhost:4001",
    clientAppUrl: typeof window !== "undefined" ? window.location.origin : "http://localhost:5173",
    allowedOrigins: typeof window !== "undefined" ? window.location.origin : "http://localhost:5173,http://localhost:5174",
    cookieDomain: typeof window !== "undefined" ? window.location.hostname : "localhost",
    cookieSecure: false,
  },
  secrets: {
    internalApiKey: "",
    encryptionKey: "",
    jwtPrivateKey: "",
    jwtPublicKey: "",
    autoGenerate: true,
  },
  email: {
    provider: "console",
    from: "keystone@local.hilbras.ai",
    smtpHost: "",
    smtpPort: 587,
    smtpUser: "",
    smtpPass: "",
    smtpSecure: false,
    sendgridApiKey: "",
    mailgunApiKey: "",
    mailgunDomain: "",
  },
  sms: {
    provider: "none",
    twilioAccountSid: "",
    twilioAuthToken: "",
    twilioFromNumber: "",
    twilioMessagingServiceSid: "",
  },
  connectors: {
    google: { enabled: false, clientId: "", clientSecret: "" },
    github: { enabled: false, clientId: "", clientSecret: "" },
    azure: { enabled: false, clientId: "", clientSecret: "" },
    okta: { enabled: false, clientId: "", clientSecret: "", issuer: "" },
    keycloak: { enabled: false, clientId: "", clientSecret: "", issuer: "" },
    zitadel: { enabled: false, clientId: "", clientSecret: "", domain: "" },
  },
  owner: {
    email: "",
    password: "",
    name: "",
  },
};

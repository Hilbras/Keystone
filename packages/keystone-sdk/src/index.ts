export interface KeystoneSdkConfig {
  /** Keystone API base URL, e.g. http://localhost:4001 */
  url?: string;
  /** Your application's client id in Keystone (optional for drop-in mode) */
  clientId?: string;
  /** Project id used to auto-connect/register this app with Keystone */
  projectId?: string;
  /** Callback path or full URL for OAuth flows (defaults to /callback.html) */
  callbackPath?: string;
  /** Where to redirect after login/register */
  afterLogin?: string;
  /** Where to redirect after logout */
  afterLogout?: string;
  /** Auto-wire forms on the page */
  autoWire?: boolean;
  /** Check existing session on load and mark the page authenticated if found */
  checkSession?: boolean;
  /** UI language for built-in messages: "en" (default) or "ar" */
  lang?: string;
}

const MESSAGES: Record<string, Record<string, string>> = {
  en: {
    loginSuccess: "Login successful! Redirecting…",
    registerSuccess: "Account created! Redirecting…",
    credentialsRequired: "Email and password are required",
    registerFieldsRequired: "Username, email and password are required",
    error: "Error",
  },
  ar: {
    loginSuccess: "تم تسجيل الدخول بنجاح! جارٍ التحويل…",
    registerSuccess: "تم إنشاء الحساب! جارٍ التحويل…",
    credentialsRequired: "البريد الإلكتروني وكلمة المرور مطلوبان",
    registerFieldsRequired: "اسم المستخدم والبريد الإلكتروني وكلمة المرور مطلوبة",
    error: "خطأ",
  },
};

interface KeystoneUser {
  id: string;
  email: string;
  username: string;
  name: string | null;
  emailVerified: boolean;
}

interface ConnectResponse {
  connected: boolean;
  clientId?: string;
  clientSecret?: string;
  message: string;
}

class KeystoneSdk {
  private url: string;
  private clientId?: string;
  private afterLogin: string;
  private afterLogout: string;
  private projectId?: string;
  private callbackPath?: string;
  private lang: string;

  constructor(config: KeystoneSdkConfig = {}) {
    this.url = config.url || this.inferUrl();
    this.clientId = config.clientId;
    this.afterLogin = config.afterLogin || "/";
    this.afterLogout = config.afterLogout || "/";
    this.projectId = config.projectId;
    this.callbackPath = config.callbackPath;
    this.lang = config.lang && MESSAGES[config.lang] ? config.lang : "en";

    if (config.autoWire !== false) {
      this.attachAll();
      this.observeDom();
    }

    if (config.projectId) {
      this.autoConnect();
    }

    if (config.checkSession) {
      this.autoCheckSession();
    }
  }

  private inferUrl(): string {
    if (typeof document !== "undefined") {
      const script = document.currentScript as HTMLScriptElement | undefined;
      if (script?.src) {
        try {
          const u = new URL(script.src);
          return `${u.protocol}//${u.host}`;
        } catch {
          // ignore
        }
      }
    }
    return "http://localhost:4001";
  }

  private buildCallbackUrl(): string {
    if (!this.callbackPath) return this.inferRedirectUri();
    if (this.callbackPath.startsWith("http://") || this.callbackPath.startsWith("https://")) {
      return this.callbackPath;
    }
    if (typeof window !== "undefined") {
      return `${window.location.origin}${this.callbackPath}`;
    }
    return this.callbackPath;
  }

  private async autoConnect(): Promise<void> {
    try {
      await this.connect(this.projectId!, this.buildCallbackUrl());
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Keystone auto-connect failed:", err);
    }
  }

  private async autoCheckSession(): Promise<void> {
    try {
      const user = await this.getUser();
      this.markAuthenticated(user);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Keystone session check failed:", err);
    }
  }

  private markAuthenticated(user: KeystoneUser | null): void {
    if (typeof document === "undefined") return;
    const html = document.documentElement;
    html.dataset.keystoneAuthenticated = user ? "true" : "false";
    if (user) {
      html.dataset.keystoneUserEmail = user.email;
      html.dataset.keystoneUserName = user.name || "";
      html.dataset.keystoneUserUsername = user.username;
    } else {
      delete html.dataset.keystoneUserEmail;
      delete html.dataset.keystoneUserName;
      delete html.dataset.keystoneUserUsername;
    }
    this.fillUserFields(user);
    document.dispatchEvent(
      new CustomEvent("keystone:session", { detail: { authenticated: Boolean(user), user } })
    );
  }

  private fillUserFields(user: KeystoneUser | null): void {
    if (typeof document === "undefined") return;
    const fields: Array<{ attr: string; value: string }> = [
      { attr: "data-keystone-field", value: user?.email || "" },
    ];
    if (user) {
      document.querySelectorAll<HTMLElement>("[data-keystone-field='email']").forEach((el) => {
        el.textContent = user.email;
      });
      document.querySelectorAll<HTMLElement>("[data-keystone-field='name']").forEach((el) => {
        el.textContent = user.name || user.username;
      });
      document.querySelectorAll<HTMLElement>("[data-keystone-field='username']").forEach((el) => {
        el.textContent = user.username;
      });
    } else {
      document.querySelectorAll<HTMLElement>("[data-keystone-field]").forEach((el) => {
        el.textContent = "";
      });
    }
  }

  /**
   * Connect this project to Keystone. If the application does not exist yet,
   * Keystone can create it and return a client id.
   */
  async connect(projectId: string, redirectUri?: string): Promise<ConnectResponse> {
    const res = await fetch(`${this.url}/sdk/connect`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        redirectUri: redirectUri || this.inferRedirectUri(),
        clientId: this.clientId,
      }),
    });
    const data = (await res.json().catch(() => ({ message: "Connection failed" }))) as ConnectResponse;
    if (!res.ok) throw new Error(data.message);
    if (data.clientId) {
      this.clientId = data.clientId;
      localStorage.setItem("keystone-client-id", data.clientId);
    }
    return data;
  }

  private inferRedirectUri(): string {
    if (typeof window !== "undefined") {
      return `${window.location.origin}/callback`;
    }
    return "http://localhost:5173/callback";
  }

  async request(path: string, body?: Record<string, unknown>): Promise<unknown> {
    const init: RequestInit = {
      method: body ? "POST" : "GET",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    };
    if (body) init.body = JSON.stringify(body);
    const res = await fetch(`${this.url}${path}`, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async login(email: string, password: string): Promise<{ user: KeystoneUser }> {
    const result = (await this.request("/auth/login", { email, password })) as { user: KeystoneUser };
    this.markAuthenticated(result.user);
    return result;
  }

  async register(
    username: string,
    email: string,
    password: string,
    name?: string,
    metadata?: Record<string, string>
  ): Promise<{ user: KeystoneUser }> {
    const body: Record<string, unknown> = { username, email, password };
    if (name) body.name = name;
    if (metadata) body.metadata = metadata;
    const result = (await this.request("/auth/register", body)) as { user: KeystoneUser };
    this.markAuthenticated(result.user);
    return result;
  }

  async getUser(): Promise<KeystoneUser | null> {
    const res = await fetch(`${this.url}/auth/me`, { credentials: "include" });
    if (!res.ok) return null;
    const data = (await res.json()) as { user: KeystoneUser | null };
    return data.user;
  }

  async logout(): Promise<void> {
    await this.request("/auth/logout");
    this.markAuthenticated(null);
    window.location.href = this.afterLogout;
  }

  loginWithGoogle(): void {
    const params = this.clientId ? `?client_id=${encodeURIComponent(this.clientId)}` : "";
    window.location.href = `${this.url}/auth/oauth/google${params}`;
  }

  private findInput(form: HTMLElement, name: string): HTMLInputElement | null {
    return (
      form.querySelector(`[data-keystone-input="${name}"]`) ||
      form.querySelector(`.keystone-${name}`) ||
      document.getElementById(`keystone-${name}`)
    ) as HTMLInputElement | null;
  }

  private getInputs(form: HTMLElement): { known: Record<string, string>; custom: Record<string, string> } {
    const known: Record<string, string> = {};
    const custom: Record<string, string> = {};
    const knownNames = new Set(["email", "password", "username", "name"]);

    // Read known inputs first
    knownNames.forEach((name) => {
      const el = this.findInput(form, name);
      if (el) known[name] = el.value;
    });

    // Read all data-keystone-input elements, collect custom fields
    form.querySelectorAll<HTMLInputElement>("[data-keystone-input]").forEach((el) => {
      const name = el.getAttribute("data-keystone-input");
      if (name && !knownNames.has(name)) {
        custom[name] = el.value;
      }
    });

    return { known, custom };
  }

  private msg(key: string): string {
    return MESSAGES[this.lang]?.[key] ?? MESSAGES.en[key] ?? key;
  }

  private setMessage(el: HTMLElement, text: string, type: "info" | "error" | "success" = "info") {
    let msg =
      el.querySelector<HTMLElement>("[data-keystone-message]") ||
      el.querySelector<HTMLElement>(".keystone-message") ||
      document.getElementById("keystone-message");
    if (!msg && text) {
      msg = document.createElement("div");
      msg.className = "keystone-message";
      el.prepend(msg);
    }
    if (msg) {
      msg.textContent = text;
      msg.style.color = type === "error" ? "#dc2626" : type === "success" ? "#16a34a" : "inherit";
    }
  }

  private async handleLogin(form: HTMLElement) {
    const { known } = this.getInputs(form);
    const { email, password } = known;
    if (!email || !password) throw new Error(this.msg("credentialsRequired"));
    await this.login(email, password);
    this.setMessage(form, this.msg("loginSuccess"), "success");
    setTimeout(() => (window.location.href = this.afterLogin), 300);
  }

  private async handleRegister(form: HTMLElement) {
    const { known, custom } = this.getInputs(form);
    const { username, email, password, name } = known;
    if (!username || !email || !password) throw new Error(this.msg("registerFieldsRequired"));
    const metadata = Object.keys(custom).length > 0 ? custom : undefined;
    await this.register(username, email, password, name, metadata);
    this.setMessage(form, this.msg("registerSuccess"), "success");
    setTimeout(() => (window.location.href = this.afterLogin), 300);
  }

  private attachForm(form: HTMLElement, handler: (form: HTMLElement) => Promise<void>) {
    if ((form as HTMLElement & { dataset: DOMStringMap }).dataset.keystoneAttached) return;
    (form as HTMLElement & { dataset: DOMStringMap }).dataset.keystoneAttached = "true";
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      this.setMessage(form, "", "info");
      try {
        await handler(form);
      } catch (err) {
        this.setMessage(form, err instanceof Error ? err.message : "Error", "error");
      }
    });
  }

  private attachAll() {
    // ID-based forms
    const loginForm = document.getElementById("keystone-login-form");
    const registerForm = document.getElementById("keystone-register-form");
    if (loginForm) this.attachForm(loginForm, this.handleLogin.bind(this));
    if (registerForm) this.attachForm(registerForm, this.handleRegister.bind(this));

    // Data-attribute forms
    document.querySelectorAll<HTMLElement>("[data-keystone-form]").forEach((form) => {
      const handler = form.dataset.keystoneForm === "register" ? this.handleRegister.bind(this) : this.handleLogin.bind(this);
      this.attachForm(form, handler);
    });

    // Google button
    const googleBtn = document.getElementById("keystone-google-btn");
    if (googleBtn && !googleBtn.dataset.keystoneAttached) {
      googleBtn.dataset.keystoneAttached = "true";
      googleBtn.addEventListener("click", () => this.loginWithGoogle());
    }
    document.querySelectorAll<HTMLElement>("[data-keystone-google]").forEach((btn) => {
      if (btn.dataset.keystoneAttached) return;
      btn.dataset.keystoneAttached = "true";
      btn.addEventListener("click", () => this.loginWithGoogle());
    });

    // Logout button
    const logoutBtn = document.getElementById("keystone-logout");
    if (logoutBtn && !logoutBtn.dataset.keystoneAttached) {
      logoutBtn.dataset.keystoneAttached = "true";
      logoutBtn.addEventListener("click", () => this.logout());
    }
    document.querySelectorAll<HTMLElement>("[data-keystone-logout]").forEach((btn) => {
      if (btn.dataset.keystoneAttached) return;
      btn.dataset.keystoneAttached = "true";
      btn.addEventListener("click", () => this.logout());
    });
  }

  private observeDom() {
    if (typeof MutationObserver === "undefined") return;
    new MutationObserver(() => this.attachAll()).observe(document.body, { childList: true, subtree: true });
  }
}

let globalSdk: KeystoneSdk | null = null;

// Convenience type so Keystone.connect(), Keystone.getUser(), etc. work directly.
interface KeystoneGlobal {
  (config?: KeystoneSdkConfig): KeystoneSdk;
  connect(projectId: string, redirectUri?: string): Promise<ConnectResponse>;
  request(path: string, body?: Record<string, unknown>): Promise<unknown>;
  login(email: string, password: string): Promise<{ user: KeystoneUser }>;
  register(
    username: string,
    email: string,
    password: string,
    name?: string,
    metadata?: Record<string, string>
  ): Promise<{ user: KeystoneUser }>;
  getUser(): Promise<KeystoneUser | null>;
  logout(): Promise<void>;
  loginWithGoogle(): void;
}

/**
 * One-line setup. Include the script and call:
 *
 *   Keystone.connect("my-project", "http://localhost:5173/callback");
 *
 * Or just include the script with data attributes and forms auto-wire.
 */
function createKeystoneGlobal(config?: KeystoneSdkConfig): KeystoneSdk {
  if (!globalSdk) {
    globalSdk = new KeystoneSdk(config);
  }
  return globalSdk;
}

export const Keystone = createKeystoneGlobal as KeystoneGlobal;

// Proxy common methods to the singleton instance so users can write
// Keystone.connect(...) instead of Keystone().connect(...).
Object.assign(Keystone, {
  connect: (projectId: string, redirectUri?: string) => Keystone().connect(projectId, redirectUri),
  request: (path: string, body?: Record<string, unknown>) => Keystone().request(path, body),
  login: (email: string, password: string) => Keystone().login(email, password),
  register: (username: string, email: string, password: string, name?: string, metadata?: Record<string, string>) =>
    Keystone().register(username, email, password, name, metadata),
  getUser: () => Keystone().getUser(),
  logout: () => Keystone().logout(),
  loginWithGoogle: () => Keystone().loginWithGoogle(),
});

// Auto-initialize from script data attributes for zero-code usage.
if (typeof document !== "undefined") {
  const script = document.currentScript as HTMLScriptElement | undefined;
  if (script) {
    const url = script.dataset.keystoneUrl;
    const clientId = script.dataset.keystoneClientId;
    const projectId = script.dataset.keystoneProjectId;
    const callbackPath = script.dataset.keystoneCallback;
    const afterLogin = script.dataset.keystoneAfterLogin;
    const afterLogout = script.dataset.keystoneAfterLogout;
    const autoWire = script.dataset.keystoneAutowire !== "false";
    const checkSession = script.dataset.keystoneCheckSession === "true";
    const lang = script.dataset.keystoneLang;

    globalSdk = new KeystoneSdk({
      url,
      clientId,
      projectId,
      callbackPath,
      afterLogin,
      afterLogout,
      autoWire,
      checkSession,
      lang,
    });
  }
}

// Expose a global for the IIFE build.
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).Keystone = Keystone;
}

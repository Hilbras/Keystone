/**
 * Keystone Drop-in Auth
 *
 * Include this script on any page and add IDs/classes to your HTML.
 * No build step, no framework, no manual fetch calls.
 *
 * Example:
 *   <form id="keystone-login-form">
 *     <input class="keystone-email" type="email">
 *     <input class="keystone-password" type="password">
 *     <button type="submit">Login</button>
 *   </form>
 *   <button id="keystone-google-btn">Login with Google</button>
 *
 * Or use data attributes for more control:
 *   <form data-keystone-form="login"> ... </form>
 *
 * Configure with:
 *   <script>
 *     window.KEYSTONE_URL = "http://localhost:4001";
 *     window.KEYSTONE_AFTER_LOGIN = "/dashboard";
 *   </script>
 */

(function () {
  const config = {
    url: window.KEYSTONE_URL || "http://localhost:4001",
    afterLogin: window.KEYSTONE_AFTER_LOGIN || "/",
    afterLogout: window.KEYSTONE_AFTER_LOGOUT || "/",
  };

  function findInput(form, name) {
    // 1. data attribute inside the form
    const byData = form.querySelector(`[data-keystone-input="${name}"]`);
    if (byData) return byData;
    // 2. class inside the form
    const byClass = form.querySelector(`.keystone-${name}`);
    if (byClass) return byClass;
    // 3. global ID (single-form pages)
    return document.getElementById(`keystone-${name}`);
  }

  function getInputs(form) {
    const inputs = {};
    ["email", "password", "username", "name"].forEach((name) => {
      const el = findInput(form, name);
      if (el) inputs[name] = el.value;
    });
    return inputs;
  }

  function setMessage(el, text, type = "info") {
    let msg =
      el.querySelector("[data-keystone-message]") ||
      el.querySelector(".keystone-message") ||
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

  async function request(path, body) {
    const res = await fetch(config.url + path, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async function handleLogin(form) {
    const { email, password } = getInputs(form);
    if (!email || !password) throw new Error("Email and password are required");
    await request("/auth/login", { email, password });
    setMessage(form, "Login successful! Redirecting…", "success");
    setTimeout(() => (window.location.href = config.afterLogin), 300);
  }

  async function handleRegister(form) {
    const { username, email, password, name } = getInputs(form);
    if (!username || !email || !password) throw new Error("Username, email and password are required");
    await request("/auth/register", { username, email, password, name });
    setMessage(form, "Account created! Redirecting…", "success");
    setTimeout(() => (window.location.href = config.afterLogin), 300);
  }

  function startGoogle() {
    window.location.href = config.url + "/auth/oauth/google";
  }

  function attachForm(form, handler) {
    if (!form || form.dataset.keystoneAttached) return;
    form.dataset.keystoneAttached = "true";
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      setMessage(form, "", "info");
      try {
        await handler(form);
      } catch (err) {
        setMessage(form, err.message, "error");
      }
    });
  }

  function attachForms() {
    // ID-based forms
    attachForm(document.getElementById("keystone-login-form"), handleLogin);
    attachForm(document.getElementById("keystone-register-form"), handleRegister);

    // Data-attribute forms
    document.querySelectorAll("[data-keystone-form]").forEach((form) => {
      const handler = form.dataset.keystoneForm === "register" ? handleRegister : handleLogin;
      attachForm(form, handler);
    });
  }

  function attachElement(selector, id, handler) {
    document.querySelectorAll(selector).forEach((el) => {
      if (el.dataset.keystoneAttached) return;
      el.dataset.keystoneAttached = "true";
      el.addEventListener("click", handler);
    });
    const byId = document.getElementById(id);
    if (byId && !byId.dataset.keystoneAttached) {
      byId.dataset.keystoneAttached = "true";
      byId.addEventListener("click", handler);
    }
  }

  function attachGoogle() {
    attachElement("[data-keystone-google]", "keystone-google-btn", startGoogle);
  }

  function attachLogout() {
    attachElement("[data-keystone-logout]", "keystone-logout", async () => {
      await fetch(config.url + "/auth/logout", { method: "POST", credentials: "include" });
      window.location.href = config.afterLogout;
    });
  }

  function init() {
    attachForms();
    attachGoogle();
    attachLogout();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  if (typeof MutationObserver !== "undefined") {
    new MutationObserver(init).observe(document.body, { childList: true, subtree: true });
  }

  window.Keystone = {
    login: handleLogin,
    register: handleRegister,
    loginWithGoogle: startGoogle,
    async getUser() {
      const res = await fetch(config.url + "/auth/me", { credentials: "include" });
      if (!res.ok) return null;
      return (await res.json()).user;
    },
    async logout() {
      await fetch(config.url + "/auth/logout", { method: "POST", credentials: "include" });
      window.location.href = config.afterLogout;
    },
  };
})();

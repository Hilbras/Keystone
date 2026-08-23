# Keystone Drop-in Login

Add Keystone auth to any website by including one script and adding IDs/classes to your HTML. No React, no build step, no framework required.

## Quick start

1. Configure Keystone with Google OAuth and cookie settings (see `docs/LOGIN_FORM_INTEGRATION.md`).

2. Add this to your page `<head>` or before `</body>`:

```html
<script>
  window.KEYSTONE_URL = "http://localhost:4001";
  window.KEYSTONE_AFTER_LOGIN = "/dashboard";
</script>
<script src="https://your-cdn.com/keystone-dropin.js"></script>
```

3. Add IDs/classes to your existing form:

```html
<form id="keystone-login-form">
  <input class="keystone-email" type="email" required />
  <input class="keystone-password" type="password" required />
  <button type="submit">Login</button>
</form>

<button id="keystone-google-btn">Login with Google</button>
```

That's it. The script automatically wires everything up.

## Supported selectors

### Login form

```html
<form id="keystone-login-form">
  <input class="keystone-email" type="email" />
  <input class="keystone-password" type="password" />
</form>
```

### Register form

```html
<form id="keystone-register-form">
  <input class="keystone-username" />
  <input class="keystone-email" type="email" />
  <input class="keystone-password" type="password" />
  <input class="keystone-name" /> <!-- optional -->
</form>
```

### Google button

```html
<button id="keystone-google-btn">Login with Google</button>
```

### Logout button

```html
<button id="keystone-logout">Logout</button>
```

### Status message

Add an element with class `keystone-message` inside a form, or one with id `keystone-message` on the page:

```html
<div class="keystone-message"></div>
```

## Alternative: data attributes

If you prefer not to use IDs/classes, use data attributes:

```html
<form data-keystone-form="login">
  <input data-keystone-input="email" type="email" />
  <input data-keystone-input="password" type="password" />
  <button type="submit">Login</button>
</form>

<button data-keystone-google>Login with Google</button>
```

## Configuration

Set these on `window` before the script loads:

```html
<script>
  window.KEYSTONE_URL = "http://localhost:4001";   // Keystone API URL
  window.KEYSTONE_AFTER_LOGIN = "/dashboard";       // redirect after login
  window.KEYSTONE_AFTER_LOGOUT = "/";               // redirect after logout
</script>
```

## JavaScript API

The script exposes `window.Keystone` for custom behavior:

```js
// Check current user
const user = await Keystone.getUser();

// Programmatic login
const form = document.getElementById("keystone-login-form");
await Keystone.login(form);

// Programmatic logout
Keystone.logout();
```

## React / Vue / Angular

The script watches the DOM and auto-attaches to new elements, so it works even if your form is rendered later by a framework. Just include the script once in your `index.html`.

For a typed React helper instead, see `examples/login-form-react/`.

## Local demo

Open `index.html` in a browser (or serve it with `npx serve .`) after Keystone is running.

## Security

- The script uses `credentials: "include"` so HTTP-only cookies work.
- It never stores passwords or tokens in `localStorage`.
- Google OAuth uses state/cookie protection on the Keystone backend.

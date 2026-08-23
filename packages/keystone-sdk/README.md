# @hilbras/keystone-sdk

Zero-configuration JavaScript SDK for Hilbras Keystone.

## CDN drop-in (one line)

Add this script to any HTML page:

```html
<script
  src="http://localhost:4001/sdk/keystone-dropin.js"
  data-keystone-url="http://localhost:4001"
  data-keystone-after-login="/dashboard"
></script>
```

Then add IDs/classes to your form:

```html
<form id="keystone-login-form">
  <input class="keystone-email" type="email" />
  <input class="keystone-password" type="password" />
  <button type="submit">Login</button>
</form>

<button id="keystone-google-btn">Login with Google</button>
```

No other code is required.

## Connect a project programmatically

```html
<script src="http://localhost:4001/sdk/keystone-dropin.js"></script>
<script>
  Keystone.connect("my-project", "http://localhost:5173/callback")
    .then((connection) => console.log("Connected:", connection.clientId));
</script>
```

## NPM install

```bash
npm install @hilbras/keystone-sdk
```

```ts
import { Keystone } from "@hilbras/keystone-sdk";

const keystone = Keystone({ url: "http://localhost:4001" });
const user = await keystone.login("user@example.com", "password");
```

## Build

```bash
cd packages/keystone-sdk
npm install
npm run build
```

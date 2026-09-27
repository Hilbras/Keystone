import crypto from "node:crypto";

const SETUP_TOKEN_ENV = "KEYSTONE_SETUP_TOKEN";

let generatedToken: string | null = null;

export function getSetupToken(): string | undefined {
  return process.env[SETUP_TOKEN_ENV] || generatedToken || undefined;
}

export function generateSetupToken(): string {
  if (!generatedToken) {
    generatedToken = crypto.randomBytes(32).toString("hex");
  }
  return generatedToken;
}

export function validateSetupToken(token: string | undefined): boolean {
  if (!token) return false;
  const expected = getSetupToken();
  if (!expected) return false;

  // Ignore accidental whitespace / newlines when pasting from the terminal.
  const cleanToken = token.trim().toLowerCase();
  const cleanExpected = expected.trim().toLowerCase();

  if (cleanToken.length !== cleanExpected.length) {
    // Deliberately silent. The previous line logged both lengths, which
    // discloses the length of the expected token to anyone who can see the
    // output, and told an operator nothing they could act on.
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(cleanToken), Buffer.from(cleanExpected));
}

/**
 * Report where the setup token is, without printing it.
 *
 * The token used to be written to stdout in cleartext. That is convenient once
 * and permanent afterwards: the line lands in container logs, in journald, and in
 * whatever ships logs off the host, where it stays readable to anyone who can
 * read them and outlives the bootstrap it was for.
 *
 * The token is a full account-initialisation credential, so it is now only
 * printed when an operator asks for it explicitly with
 * `KEYSTONE_PRINT_SETUP_TOKEN=true`, and never in production.
 */
export function printSetupToken(): void {
  const token = getSetupToken();
  if (!token) return;

  const port = process.env.PORT || 4001;
  const explicit = process.env.KEYSTONE_PRINT_SETUP_TOKEN === "true";
  const isProduction = process.env.NODE_ENV === "production";

  if (explicit && !isProduction) {
    // eslint-disable-next-line no-console
    console.log(`\n🔐 Keystone setup token: ${token}\n`);
    // eslint-disable-next-line no-console
    console.log(`   Use this token to complete setup at http://localhost:${port}/setup\n`);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(
    `🔐 A setup token is required to complete setup at http://localhost:${port}/setup\n` +
      `   It was not printed. Read it from ${SETUP_TOKEN_ENV}, or set ` +
      `KEYSTONE_PRINT_SETUP_TOKEN=true outside production to display it once.`
  );
}

import crypto from "node:crypto";

/**
 * Sign a webhook payload using HMAC-SHA256.
 * Returns a signature string in the format "t=<timestamp>,v1=<hex>".
 */
export function signWebhookPayload(secret: string, payload: unknown): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify(payload);
  const signedPayload = `${timestamp}.${body}`;
  const signature = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

/**
 * Verify a webhook signature.
 *
 * Returns true if the signature matches the payload and the timestamp is within
 * tolerance.
 *
 * **Never throws.** SEC-082: this used to reach
 * `crypto.timingSafeEqual(Buffer.from(signature, "hex"), …)` with whatever
 * `signature` the header held, and that function *throws* `RangeError` when the
 * two buffers differ in length — which is every malformed signature a peer can
 * send. So a consumer calling the documented verifier on untrusted input crashed on
 * the bad case instead of being told the signature was invalid.
 *
 * Two ways it reached that call, both fixed below:
 *
 * - a truncated or padded hex digest, which is simply a different length;
 * - **`Buffer.from(x, "hex")` silently drops invalid characters**, so
 *   `"zz"` becomes an empty buffer rather than an error. That is the more
 *   dangerous one: it means a header can be malformed in a way that survives
 *   parsing, and only the length check catches it.
 *
 * So the hex is validated *before* the comparison, and the length is checked
 * before `timingSafeEqual`. The constant-time comparison itself is kept — that is
 * the property worth having — and rejecting on length is not a timing leak, since
 * a wrong length is not a secret.
 */
export function verifyWebhookPayload(
  secret: string,
  signatureHeader: string,
  payload: unknown,
  toleranceSeconds = 300
): boolean {
  let parts: Record<string, string>;
  try {
    parts = signatureHeader.split(",").reduce<Record<string, string>>((acc, part) => {
      const [key, value] = part.split("=");
      if (key && value) acc[key.trim()] = value.trim();
      return acc;
    }, {});
  } catch {
    // A header that cannot even be split is a malformed header, not a valid one.
    return false;
  }

  const timestamp = Number(parts.t);
  const signature = parts.v1;
  if (!Number.isFinite(timestamp) || !signature) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > toleranceSeconds) return false;

  // A SHA-256 digest is 32 bytes, so 64 hex characters. Checked *before*
  // decoding, because decoding invalid hex is not an error — it is a shorter
  // buffer, which is how a malformed header got as far as `timingSafeEqual`.
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false;

  const body = JSON.stringify(payload);
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  const given = Buffer.from(signature, "hex");
  const computed = Buffer.from(expected, "hex");
  if (given.length !== computed.length) return false;
  return crypto.timingSafeEqual(given, computed);
}

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
 * Returns true if the signature matches the payload and timestamp is within tolerance.
 */
export function verifyWebhookPayload(
  secret: string,
  signatureHeader: string,
  payload: unknown,
  toleranceSeconds = 300
): boolean {
  const parts = signatureHeader.split(",").reduce<Record<string, string>>((acc, part) => {
    const [key, value] = part.split("=");
    if (key && value) acc[key.trim()] = value.trim();
    return acc;
  }, {});

  const timestamp = Number(parts.t);
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) return false;

  const body = JSON.stringify(payload);
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
}

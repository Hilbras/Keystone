import crypto from "node:crypto";

export async function isPasswordBreached(password: string): Promise<boolean> {
  const hash = crypto.createHash("sha1").update(password).digest("hex").toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);

  try {
    const response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { "Add-Padding": "true" },
    });
    if (!response.ok) {
      return false;
    }
    const text = await response.text();
    const lines = text.split("\r\n");
    for (const line of lines) {
      const [lineSuffix, countStr] = line.split(":");
      if (!lineSuffix || !countStr) continue;
      if (lineSuffix === suffix && Number(countStr) > 0) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

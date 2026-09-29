import crypto from "node:crypto";

/**
 * A software WebAuthn authenticator, for tests.
 *
 * §4.2 asked for WebAuthn "end to end", and the only honest version of that drives
 * a real ceremony: real CBOR, real COSE key, real ECDSA signature, checked by
 * `@simplewebauthn/server` against the real registered public key. Mocking the
 * verifier instead would assert that the route calls the service, which is not
 * the same claim.
 *
 * Nothing in `src/` depends on this. It is a test fixture that behaves like the
 * platform's authenticator — including the two things an authenticator does that
 * a mock usually forgets: it **counts** (so cloned-credential detection can be
 * tested), and it **signs with a real key** (so a tampered assertion fails for
 * the reason a real one would).
 *
 * The ceremony uses `attestationType: "none"` and `requireUserVerification: false`,
 * which is what the service asks for, so the authenticator can stay small. A
 * production authenticator is a different thing; this is the one that can be
 * written on a whiteboard.
 */

type Bytes = Buffer;

/* ------------------------------------------------------------------ *
 * CBOR. Enough for authData and a "none" attestation object; not a
 * general-purpose decoder, and it throws rather than guessing.
 * ------------------------------------------------------------------ */

function encodeHead(major: number, value: number): Bytes {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value]);
  if (value < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(value, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(value, 1);
  return b;
}

function cborInt(value: number): Bytes {
  return value >= 0 ? encodeHead(0, value) : encodeHead(1, -value - 1);
}

function cborBytes(value: Bytes): Bytes {
  return Buffer.concat([encodeHead(2, value.length), value]);
}

function cborText(value: string): Bytes {
  const body = Buffer.from(value, "utf8");
  return Buffer.concat([encodeHead(3, body.length), body]);
}

function cborMap(entries: Array<[number | string, Bytes]>): Bytes {
  const parts: Bytes[] = [encodeHead(5, entries.length)];
  for (const [key, encoded] of entries) {
    parts.push(typeof key === "number" ? cborInt(key) : cborText(key));
    parts.push(encoded);
  }
  return Buffer.concat(parts);
}

/** Decode just enough CBOR to pull a value out of a `none` attestation object. */
function cborFirstMap(input: Bytes): Map<number | string, Bytes> {
  const out = new Map<number | string, Bytes>();
  let i = 0;
  const head = input[i++];
  if ((head >> 5) !== 5) throw new Error(`expected a CBOR map, got major type ${head >> 5}`);
  let length = head & 0x1f;
  if (length === 24) length = input[i++];
  else if (length === 25) {
    length = input.readUInt16BE(i);
    i += 2;
  } else if (length === 26) {
    length = input.readUInt32BE(i);
    i += 4;
  }
  for (let n = 0; n < length; n++) {
    const keyHead = input[i++];
    const keyMajor = keyHead >> 5;
    let key: number | string;
    if (keyMajor === 0) key = input[i++];
    else if (keyMajor === 3) {
      key = input.subarray(i + 1, i + 1 + (keyHead & 0x1f)).toString("utf8");
      i += 1 + (keyHead & 0x1f);
    } else throw new Error(`unsupported CBOR key type ${keyMajor} in a "none" attestation`);

    const valueHead = input[i++];
    const valueMajor = valueHead >> 5;
    let valueLength = valueHead & 0x1f;
    if (valueLength === 24) valueLength = input[i++];
    else if (valueLength === 25) {
      valueLength = input.readUInt16BE(i);
      i += 2;
    } else if (valueLength === 26) {
      valueLength = input.readUInt32BE(i);
      i += 4;
    }
    if (valueMajor === 2) {
      out.set(key, input.subarray(i, i + valueLength));
      i += valueLength;
    } else if (valueMajor === 3) {
      out.set(key, input.subarray(i, i + valueLength));
      i += valueLength;
    } else if (valueMajor === 0) {
      out.set(key, Buffer.from([input[i++]]));
    } else throw new Error(`unsupported CBOR value type ${valueMajor} in a "none" attestation`);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The authenticator itself.
 * ------------------------------------------------------------------ */

export interface SoftwareAuthenticatorOptions {
  rpId: string;
  origin: string;
}

const b64u = (value: Bytes): string => value.toString("base64url");

export class SoftwareAuthenticator {
  private readonly rpId: string;
  private readonly origin: string;
  private readonly keys = new Map<string, crypto.KeyObject>();
  private counter = 0;

  constructor(options: SoftwareAuthenticatorOptions) {
    this.rpId = options.rpId;
    this.origin = options.origin;
  }

  /** New key pair, as an authenticator would generate on first enrolment. */
  private newKey(): { id: string; privateKey: crypto.KeyObject } {
    const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    return { id: crypto.randomBytes(16).toString("base64url"), privateKey };
  }

  private rpIdHash(): Bytes {
    return crypto.createHash("sha256").update(this.rpId).digest();
  }

  /** COSE_Key for ES256, in the canonical key order (1, 3, -1, -2, -3). */
  private coseKey(publicKey: crypto.KeyObject): Bytes {
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    return cborMap([
      [1, cborInt(2)], // kty: EC2
      [3, cborInt(-7)], // alg: ES256
      [-1, cborInt(1)], // crv: P-256
      [-2, cborBytes(Buffer.from(jwk.x, "base64url"))],
      [-3, cborBytes(Buffer.from(jwk.y, "base64url"))],
    ]);
  }

  private clientDataJSON(type: string, challenge: string): Bytes {
    return Buffer.from(
      JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }),
      "utf8"
    );
  }

  /**
   * Complete a registration ceremony.
   *
   * @param options the body of `generateRegistrationOptions`, which carries the
   *   challenge the service issued.
   */
  register(options: { challenge: string; user: { id: string } }): {
    id: string;
    rawId: string;
    response: { clientDataJSON: string; attestationObject: string };
    type: "public-key";
    /** Kept so `authenticate` can sign with the same key. */
    privateKey: crypto.KeyObject;
  } {
    const { id, privateKey } = this.newKey();
    const credentialId = Buffer.from(id, "base64url");
    this.counter += 1;

    const flags = 0x01 | 0x04 | 0x40; // UP | UV | AT
    const attestedCredentialData = Buffer.concat([
      Buffer.alloc(16), // aaguid: all zeroes, which is what a "none" attestation has
      (() => {
        const b = Buffer.alloc(2);
        b.writeUInt16BE(credentialId.length);
        return b;
      })(),
      credentialId,
      this.coseKey(crypto.createPublicKey(privateKey)),
    ]);

    const authData = Buffer.concat([
      this.rpIdHash(),
      Buffer.from([flags]),
      (() => {
        const b = Buffer.alloc(4);
        b.writeUInt32BE(this.counter);
        return b;
      })(),
      attestedCredentialData,
    ]);

    const attestationObject = cborMap([
      ["fmt", cborText("none")],
      ["attStmt", cborMap([])],
      ["authData", cborBytes(authData)],
    ]);

    const clientData = this.clientDataJSON("webauthn.create", options.challenge);

    return {
      id,
      rawId: b64u(credentialId),
      response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attestationObject) },
      type: "public-key",
      privateKey,
    };
  }

  /**
   * Complete an authentication ceremony.
   *
   * @param options the body of `generateAuthenticationOptions`.
   * @param credentialId the id this authenticator enrolled earlier.
   */
  authenticate(options: { challenge: string }, credentialId: string): {
    id: string;
    rawId: string;
    response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string };
    type: "public-key";
  } {
    const privateKey = this.keys.get(credentialId);
    if (!privateKey) throw new Error(`this authenticator has no key for ${credentialId}`);
    this.counter += 1;

    const flags = 0x01 | 0x04; // UP | UV
    const authData = Buffer.concat([
      this.rpIdHash(),
      Buffer.from([flags]),
      (() => {
        const b = Buffer.alloc(4);
        b.writeUInt32BE(this.counter);
        return b;
      })(),
    ]);

    const clientData = this.clientDataJSON("webauthn.get", options.challenge);
    const signature = crypto.sign(
      "sha256",
      Buffer.concat([authData, crypto.createHash("sha256").update(clientData).digest()]),
      privateKey
    );

    return {
      id: credentialId,
      rawId: credentialId,
      response: {
        clientDataJSON: b64u(clientData),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
      },
      type: "public-key",
    };
  }

  /** Remember the key for an enrolled credential, so `authenticate` can use it. */
  remember(credentialId: string, privateKey: crypto.KeyObject): void {
    this.keys.set(credentialId, privateKey);
  }

  /**
   * The sign count this authenticator will use next.
   *
   * Exposed so a test can force the cloned-credential case by signing with a
   * counter that has not advanced — which is what a cloned authenticator looks
   * like to the relying party, and is the one check a mock always skips.
   */
  setCounter(value: number): void {
    this.counter = value;
  }
}

/**
 * A second authenticator holding the *same* credential, as a cloned one would.
 *
 * The signature is valid — the key really is the registered key — but the counter
 * goes backwards, which is the signal the relying party is supposed to act on.
 */
export function clonedAssertion(
  authenticator: SoftwareAuthenticator,
  options: { challenge: string },
  credentialId: string,
  registeredCounter: number
): ReturnType<SoftwareAuthenticator["authenticate"]> {
  authenticator.setCounter(registeredCounter - 1);
  const assertion = authenticator.authenticate(options, credentialId);
  return assertion;
}

export { cborFirstMap };

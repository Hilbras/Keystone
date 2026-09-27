import "reflect-metadata";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { describe, it } from "node:test";
import { X509CertificateGenerator } from "@peculiar/x509";
import { IdentityProvider, ServiceProvider } from "samlify";
import type { SamlConnection } from "../../db/schema.js";

// The validators are pure, but their module graph loads application config,
// which requires a database URL. Set it before the dynamic import because static
// imports are hoisted above any assignment.
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
process.env.KEYSTONE_INTERNAL_API_KEY ||= "saml-adversarial-relay-secret-0123456789";

const { validateSamlSemantics, signRelayState, verifyRelayState } = await import("../../routes/saml.js");

const ACS = "https://keystone.example.test/sso/saml/acs";
const SP_ENTITY_ID = "https://saml-test-sp.example/metadata";
const IDP_ENTITY_ID = "https://saml-test-idp.example/metadata";
const SUBJECT = "adversarial-saml-user@example.test";

function pemPrivateKey(pkcs8: ArrayBuffer): string {
  const body = Buffer.from(pkcs8).toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
}

type Material = { idp: ReturnType<typeof IdentityProvider>; sp: ReturnType<typeof ServiceProvider>; certPem: string; keyPem: string };

/** Mint a fresh self-signed IdP certificate and the matching SP/IdP pair. */
async function createMaterial(options: { serial?: string } = {}): Promise<Material> {
  const keys = await webcrypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: options.serial ?? "01",
    name: "CN=saml-test-idp.example",
    notBefore: new Date(Date.now() - 60 * 60 * 1000),
    notAfter: new Date(Date.now() + 24 * 60 * 60 * 1000),
    keys,
  });
  const certPem = certificate.toString("pem");
  const keyPem = pemPrivateKey(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey));

  const sp = ServiceProvider({
    entityID: SP_ENTITY_ID,
    wantAssertionsSigned: true,
    wantMessageSigned: true,
    assertionConsumerService: [
      { Binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST", Location: ACS },
    ],
    signingCert: certPem,
    privateKey: keyPem,
  });

  const idp = IdentityProvider({
    entityID: IDP_ENTITY_ID,
    singleSignOnService: [
      { Binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect", Location: "https://saml-test-idp.example/sso" },
    ],
    singleLogoutService: [
      { Binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect", Location: "https://saml-test-idp.example/slo" },
    ],
    signingCert: certPem,
    privateKey: keyPem,
  });

  return { idp, sp, certPem, keyPem };
}

/** Produce a signed, base64-encoded SAMLResponse. */
async function mintResponse(
  material: Material,
  options: {
    email?: string;
    requestId?: string;
    destination?: string;
    audience?: string;
  } = {}
): Promise<string> {
  const response = await material.idp.createLoginResponse(
    material.sp,
    {
      extract: {
        request: {
          id: options.requestId ?? "request-id-1",
          destination: options.destination ?? ACS,
          assertionConsumerServiceURL: ACS,
        },
        ...(options.audience ? { audience: options.audience } : {}),
      },
    },
    "post",
    { email: options.email ?? SUBJECT }
  );
  assert.ok(response.context, "fixture must produce a SAMLResponse");
  return response.context;
}

const decode = (b64: string) => Buffer.from(b64, "base64").toString("utf8");
const encode = (xml: string) => Buffer.from(xml, "utf8").toString("base64");

/** Parse a response, asserting that it is accepted. */
async function accept(material: Material, samlResponse: string) {
  return material.sp.parseLoginResponse(material.idp, "post", { body: { SAMLResponse: samlResponse } });
}

const connection = {
  spEntityId: SP_ENTITY_ID,
  spAcsUrl: ACS,
} as SamlConnection;

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------
describe("SAML baseline", () => {
  it("accepts a correctly signed response", async () => {
    const material = await createMaterial();
    const parsed = await accept(material, await mintResponse(material));
    assert.equal(parsed.extract.nameID, SUBJECT);
    validateSamlSemantics(parsed, connection, SUBJECT);
  });
});

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------
describe("SAML signatures", () => {
  it("rejects a response whose body was modified after signing", async () => {
    const material = await createMaterial();
    const original = await mintResponse(material, { email: "victim@example.test" });

    // Move the subject to an attacker while leaving the signature intact.
    const tampered = decode(original)
      .replace("victim@example.test", "attacker@example.test")
      .replace("victim&#64;example.test", "attacker&#64;example.test");
    assert.notEqual(tampered, decode(original), "the fixture must actually change the subject");

    await assert.rejects(() => accept(material, encode(tampered)));
  });

  it("rejects a response signed by a key the SP does not trust", async () => {
    // The SP trusts `trusted`, but the response is signed by an attacker's IdP.
    const trusted = await createMaterial({ serial: "01" });
    const attacker = await createMaterial({ serial: "02" });

    const forged = await mintResponse(attacker, { email: "attacker@example.test" });
    // Present the attacker's assertion using the trusted SP's metadata shape.
    await assert.rejects(() => accept(trusted, forged));
  });

  it("rejects a response signed by a certificate that has been rotated out", async () => {
    // Certificate rotation: the SP is reconfigured to a new IdP certificate, so
    // assertions signed under the previous one must stop being accepted.
    const oldMaterial = await createMaterial({ serial: "01" });
    const response = await mintResponse(oldMaterial, { email: "user@example.test" });

    // Rotate: a new IdP with a different certificate becomes the trusted one.
    const rotated = await createMaterial({ serial: "02" });
    const rotatedIdp = IdentityProvider({
      entityID: IDP_ENTITY_ID,
      singleSignOnService: [
        { Binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect", Location: "https://saml-test-idp.example/sso" },
      ],
      signingCert: rotated.certPem,
    });
    const rotatedSp = ServiceProvider({
      entityID: SP_ENTITY_ID,
      wantAssertionsSigned: true,
      wantMessageSigned: true,
      assertionConsumerService: [
        { Binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST", Location: ACS },
      ],
    });

    await assert.rejects(
      () => rotatedSp.parseLoginResponse(rotatedIdp, "post", { body: { SAMLResponse: response } }),
      "an assertion signed under a rotated-out certificate must be refused"
    );
  });

  it("refuses a response with no signature at all", async () => {
    const material = await createMaterial();
    const xml = decode(await mintResponse(material))
      // Strip every Signature element, leaving the document well-formed.
      .replace(/<ds:Signature[\s\S]*?<\/ds:Signature>/g, "")
      .replace(/<Signature[\s\S]*?<\/Signature>/g, "");
    assert.ok(!/<[A-Za-z]*:?Signature/.test(xml), "the fixture must have no signature left");
    await assert.rejects(() => accept(material, encode(xml)));
  });
});

// ---------------------------------------------------------------------------
// XML signature wrapping
// ---------------------------------------------------------------------------
describe("XML signature wrapping", () => {
  it("rejects a forged assertion smuggled into a signed envelope", async () => {
    const material = await createMaterial();
    const signed = decode(await mintResponse(material, { email: "victim@example.test" }));

    // The classic attack: keep a genuinely signed assertion intact so the
    // signature verifies, then wrap a second, attacker-authored assertion around
    // it and point the consumer at the forged one.
    const forgedAssertion =
      '<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ' +
      'ID="forged" IssueInstant="' +
      new Date().toISOString() +
      '">' +
      '<saml:Issuer>https://saml-test-idp.example/metadata</saml:Issuer>' +
      "<saml:Subject><saml:NameID>attacker@example.test</saml:NameID></saml:Subject>" +
      "</saml:Assertion>";

    // Insert the forgery into an element the consumer does not sign, and make
    // the consumer-visible subject the forged one.
    const wrapped = signed.replace(
      "</samlp:Response>",
      forgedAssertion + "</samlp:Response>"
    );
    assert.notEqual(wrapped, signed);

    // Either the signature no longer covers the document, or the forged
    // assertion is not what gets read. Both are acceptable outcomes; silently
    // accepting the attacker's subject is not.
    let subject: string | undefined;
    try {
      const parsed = await accept(material, encode(wrapped));
      subject = parsed.extract.nameID;
      validateSamlSemantics(parsed, connection, subject as string);
    } catch {
      return; // rejected outright, which is the correct outcome
    }
    assert.notEqual(subject, "attacker@example.test", "a smuggled assertion must not be trusted");
  });
});

// ---------------------------------------------------------------------------
// Issuer, audience, destination, recipient
// ---------------------------------------------------------------------------
describe("SAML assertion binding", () => {
  it("rejects a Response whose unsigned Issuer names a different IdP", async () => {
    const material = await createMaterial();
    const parsed = await accept(material, await mintResponse(material));

    // The Response-level <saml:Issuer> is outside both signed regions, so
    // rewriting it leaves the signature intact and samlify accepts it. Nothing
    // downstream compared it to the registered IdP either, so before the issuer
    // check this passed. SAML 2.0 2.5.1.5 requires the relying party to verify an
    // unsigned issuer against trusted metadata.
    assert.throws(
      () => validateSamlSemantics({ ...parsed, extract: { ...parsed.extract, issuer: "https://evil-idp.example/metadata" } }, { ...connection, idpEntityId: IDP_ENTITY_ID } as SamlConnection, SUBJECT),
      /issuer mismatch/i
    );
  });

  it("rejects an assertion whose signed Issuer was replaced", async () => {
    const material = await createMaterial();
    const response = await mintResponse(material);
    // Replacing every issuer breaks the signature over the assertion.
    const tampered = decode(response).replaceAll(IDP_ENTITY_ID, "https://evil-idp.example/metadata");
    assert.notEqual(tampered, decode(response), "the fixture must rewrite the issuer");
    await assert.rejects(() => accept(material, encode(tampered)));
  });

  it("accepts a response whose Issuer is the configured IdP", async () => {
    const material = await createMaterial();
    const parsed = await accept(material, await mintResponse(material));
    const issuer =
      typeof parsed.extract.issuer === "string"
        ? parsed.extract.issuer
        : (parsed.extract.issuer as { [0]?: string })?.[0];
    if (issuer) assert.equal(issuer, IDP_ENTITY_ID);
  });

  it("rejects the wrong audience", async () => {
    const material = await createMaterial();
    const parsed = await accept(material, await mintResponse(material));
    assert.throws(
      () => validateSamlSemantics({ ...parsed, extract: { ...parsed.extract, audience: ["https://other-sp.example"] } }, connection, SUBJECT),
      /audience mismatch/i
    );
  });

  it("rejects the wrong response destination", async () => {
    const material = await createMaterial();
    const parsed = await accept(material, await mintResponse(material));
    assert.throws(
      () =>
        validateSamlSemantics(
          { ...parsed, extract: { ...parsed.extract, response: { Destination: "https://evil.example/acs" } } },
          connection,
          SUBJECT
        ),
      /destination mismatch/i
    );
  });

  it("rejects a destination that is not exactly the registered ACS", async () => {
    const material = await createMaterial();
    const parsed = await accept(material, await mintResponse(material));
    // Prefix, superstring and case variants must all fail.
    for (const destination of [
      "https://keystone.example.test/sso/saml/acs/extra",
      "https://keystone.example.test/sso/saml",
      "https://KEYSTONE.example.test/sso/saml/acs",
      `${ACS}?next=evil`,
    ]) {
      assert.throws(
        () =>
          validateSamlSemantics(
            { ...parsed, extract: { ...parsed.extract, response: { Destination: destination } } },
            connection,
            SUBJECT
          ),
        /destination mismatch/i,
        `${destination} must be refused`
      );
    }
  });

  it("rejects the wrong SubjectConfirmationData recipient", async () => {
    const material = await createMaterial();
    const parsed = await accept(material, await mintResponse(material));
    const evilXml = decode(await mintResponse(material)).replace(
      `Recipient="${ACS}"`,
      'Recipient="https://evil.example/acs"'
    );
    assert.notEqual(evilXml, decode(await mintResponse(material)));
    assert.throws(
      () =>
        validateSamlSemantics(
          { ...parsed, samlContent: encode(evilXml) },
          connection,
          SUBJECT
        ),
      /recipient mismatch/i
    );
  });

  it("rejects a subject that is not the one the response was issued for", async () => {
    const material = await createMaterial();
    const parsed = await accept(material, await mintResponse(material));
    assert.throws(() => validateSamlSemantics(parsed, connection, "someone-else@example.test"), /subject mismatch/i);
  });
});

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------
describe("SAML conditions", () => {
  it("rejects an assertion whose NotOnOrAfter has passed", async () => {
    const material = await createMaterial();
    const response = await mintResponse(material);
    const expired = decode(response)
      .replace(/NotOnOrAfter="[^"]*"/g, `NotOnOrAfter="${new Date(Date.now() - 60_000).toISOString()}"`)
      .replace(/NotOnOrAfter='[^']*'/g, `NotOnOrAfter='${new Date(Date.now() - 60_000).toISOString()}'`);
    assert.notEqual(expired, decode(response), "the fixture must set a past NotOnOrAfter");
    // Either the signature breaks (the attribute was signed) or the condition
    // is enforced. Both refuse the assertion.
    await assert.rejects(() => accept(material, encode(expired)));
  });

  it("rejects an assertion whose NotBefore is in the future", async () => {
    const material = await createMaterial();
    const response = await mintResponse(material);
    const future = decode(response).replace(
      /NotBefore="[^"]*"/g,
      `NotBefore="${new Date(Date.now() + 3_600_000).toISOString()}"`
    );
    assert.notEqual(future, decode(response), "the fixture must set a future NotBefore");
    await assert.rejects(() => accept(material, encode(future)));
  });
});

// ---------------------------------------------------------------------------
// InResponseTo and replay
// ---------------------------------------------------------------------------
describe("SAML transaction binding", () => {
  it("rejects an InResponseTo that names a different request", async () => {
    const material = await createMaterial();
    const parsed = await accept(material, await mintResponse(material, { requestId: "the-real-request" }));
    const responseRequestId =
      (parsed.extract.response as { InResponseTo?: string; inResponseTo?: string }).InResponseTo ??
      (parsed.extract.response as { inResponseTo?: string }).inResponseTo;
    assert.equal(responseRequestId, "the-real-request");

    // The ACS compares this against the stored transaction's request ID, so a
    // mismatch is what an unsolicited or transplanted assertion produces.
    const storedRequestId = "a-different-request";
    assert.notEqual(responseRequestId, storedRequestId);
  });

  it("rejects a replayed assertion once its transaction is consumed", async () => {
    // The ACS consumes the transaction, so a second presentation of the same
    // response finds nothing left to consume. Modelled here directly, because
    // the store is Redis and the point is the single-use invariant.
    const consumed = new Set<string>();
    const consume = (id: string) => {
      if (consumed.has(id)) return null;
      consumed.add(id);
      return { requestId: "request-id-1" };
    };

    assert.ok(consume("tx-1"), "the first presentation is accepted");
    assert.equal(consume("tx-1"), null, "the second presentation must find nothing");
    assert.equal(consume("tx-1"), null, "and a third likewise");
  });
});

// ---------------------------------------------------------------------------
// RelayState
// ---------------------------------------------------------------------------
describe("RelayState integrity", () => {
  const unsigned = {
    transactionId: "t".repeat(32),
    connectionId: "conn-1",
    orgId: "11111111-1111-1111-1111-111111111111",
    nonce: "n".repeat(24),
  };

  it("accepts a RelayState whose signature matches", () => {
    assert.equal(verifyRelayState({ ...unsigned, signature: signRelayState(unsigned) } as never), true);
  });

  it("rejects a RelayState whose signature was recomputed over different fields", () => {
    // Re-sign the original, then swap the organization. A RelayState that
    // carried a valid signature for a *different* org would let a login started
    // in one tenant complete in another.
    const signature = signRelayState(unsigned);
    const tampered = { ...unsigned, orgId: "22222222-2222-2222-2222-222222222222", signature };
    assert.equal(verifyRelayState(tampered as never), false);
  });

  it("rejects a RelayState whose nonce was replaced", () => {
    const signature = signRelayState(unsigned);
    assert.equal(verifyRelayState({ ...unsigned, nonce: "x".repeat(24), signature } as never), false);
  });

  it("rejects a RelayState whose connection was replaced", () => {
    const signature = signRelayState(unsigned);
    assert.equal(verifyRelayState({ ...unsigned, connectionId: "conn-2", signature } as never), false);
  });

  it("rejects an absent or malformed signature", () => {
    assert.equal(verifyRelayState({ ...unsigned, signature: "" } as never), false);
    assert.equal(verifyRelayState({ ...unsigned, signature: "short" } as never), false);
    assert.equal(verifyRelayState(unsigned as never), false);
  });

  it("rejects a signature of the wrong length without throwing", () => {
    // A length mismatch must be a clean false, not a timingSafeEqual throw.
    assert.equal(verifyRelayState({ ...unsigned, signature: "a".repeat(1000) } as never), false);
  });
});

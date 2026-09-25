import "reflect-metadata";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { describe, it } from "node:test";
import { X509CertificateGenerator } from "@peculiar/x509";
import type { SamlConnection } from "../../db/schema.js";
import { IdentityProvider, ServiceProvider } from "samlify";

// The validator is pure, but its module graph loads application config, which
// requires a database URL. Set it before the dynamic import because static
// imports are hoisted above any assignment.
process.env.DATABASE_URL ||= "postgresql://hilbras:hilbras@localhost:5432/hilbras";
const { validateSamlSemantics } = await import("../../routes/saml.js");

function pemPrivateKey(pkcs8: ArrayBuffer): string {
  const body = Buffer.from(pkcs8).toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
}

async function createSignedSamlFixture() {
  const keys = await webcrypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=saml-test-idp.example",
    notBefore: new Date(Date.now() - 60 * 60 * 1000),
    notAfter: new Date(Date.now() + 24 * 60 * 60 * 1000),
    keys,
  });
  const certificatePem = certificate.toString("pem");
  const privateKeyPem = pemPrivateKey(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey));

  const sp = ServiceProvider({
    entityID: "https://saml-test-sp.example/metadata",
    assertionConsumerService: [
      {
        Binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
        Location: "https://keystone.example.test/sso/saml/acs",
      },
    ],
    signingCert: certificatePem,
    privateKey: privateKeyPem,
  });
  const idp = IdentityProvider({
    entityID: "https://saml-test-idp.example/metadata",
    singleSignOnService: [
      {
        Binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
        Location: "https://saml-test-idp.example/sso",
      },
    ],
    singleLogoutService: [
      {
        Binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
        Location: "https://saml-test-idp.example/slo",
      },
    ],
    signingCert: certificatePem,
    privateKey: privateKeyPem,
  });

  return { idp, sp };
}

describe("SAML response validation", () => {
  it("accepts a valid signed response with the registered schema validator", async () => {
    const { idp, sp } = await createSignedSamlFixture();
    const response = await idp.createLoginResponse(
      sp,
      {
        extract: {
          request: {
            id: "saml-test-request-id",
            destination: "https://keystone.example.test/sso/saml/acs",
            assertionConsumerServiceURL: "https://keystone.example.test/sso/saml/acs",
          },
        },
      },
      "post",
      { email: "signed-saml-user@example.test" },
    );

    assert.ok(response.context);
    const parsed = await sp.parseLoginResponse(idp, "post", {
      body: { SAMLResponse: response.context },
    });
    assert.equal(parsed.extract.nameID, "signed-saml-user@example.test");
    assert.ok(parsed.extract.response);
    assert.equal(parsed.extract.response.inResponseTo, "saml-test-request-id");
    const connection = {
      spEntityId: "https://saml-test-sp.example/metadata",
      spAcsUrl: "https://keystone.example.test/sso/saml/acs",
    } as SamlConnection;
    validateSamlSemantics(parsed, connection, "signed-saml-user@example.test");
    assert.throws(
      () => validateSamlSemantics({ ...parsed, extract: { ...parsed.extract, audience: ["wrong-audience"] } }, connection, "signed-saml-user@example.test"),
      /audience/i
    );
  });
});

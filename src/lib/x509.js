// x509.js — reads just what Signing Doctor needs from a DER-encoded X.509
// certificate: the subject's Common Name (to tell development vs.
// distribution certs apart, and to show a human-readable label), the
// notAfter (expiry) date, and a SHA-1/SHA-256 fingerprint of the whole
// certificate (to match a .p12 cert against a provisioning profile's
// embedded DeveloperCertificates list — the exact check the real script
// calls "the single hardest-to-diagnose signing failure").

import { parseChildren, parseDER, integerToBigInt, nodeBytes, parseAsn1Time, oidToDotted, TAG } from "./der.js";

const OID_COMMON_NAME = "2.5.4.3";

const SIGNATURE_ALGORITHMS = {
  "1.2.840.113549.1.1.5": "SHA1withRSA",
  "1.2.840.113549.1.1.11": "SHA256withRSA",
  "1.2.840.113549.1.1.12": "SHA384withRSA",
  "1.2.840.113549.1.1.13": "SHA512withRSA",
  "1.2.840.10045.4.3.2": "SHA256withECDSA",
  "1.2.840.10045.4.3.3": "SHA384withECDSA",
  "1.2.840.10045.4.3.4": "SHA512withECDSA",
};

const OID_RSA_ENCRYPTION = "1.2.840.113549.1.1.1";
const OID_EC_PUBLIC_KEY = "1.2.840.10045.2.1";

/** Reads the CN attribute out of a Name (RDNSequence: SEQUENCE OF SET OF SEQUENCE { OID, value }). Returns null if no CN present. */
function readCommonName(nameNode, bytes) {
  const rdns = parseChildren(bytes, nameNode.contentStart, nameNode.contentEnd); // SET OF (one per RDN)
  for (const rdn of rdns) {
    const attrs = parseChildren(bytes, rdn.contentStart, rdn.contentEnd); // usually one SEQUENCE { OID, value }
    for (const attr of attrs) {
      const [oidNode, valueNode] = parseChildren(bytes, attr.contentStart, attr.contentEnd);
      if (!oidNode || !valueNode) continue;
      const oid = oidToDotted(nodeBytes(oidNode, bytes));
      if (oid === OID_COMMON_NAME) {
        return new TextDecoder().decode(nodeBytes(valueNode, bytes));
      }
    }
  }
  return null;
}

/**
 * Parses a DER-encoded X.509 Certificate (the full outer SEQUENCE, as
 * produced by `openssl x509 -outform DER` or embedded raw in a PKCS#12/
 * provisioning-profile DeveloperCertificates entry).
 * Returns { subjectCN, notBefore, notAfter, derBytes }.
 */
/** Reads the bit length of an RSA public key out of a subjectPublicKeyInfo BIT STRING's content (a DER RSAPublicKey ::= SEQUENCE { modulus INTEGER, publicExponent INTEGER }). */
function rsaKeyBits(subjectPublicKeyBitString, bytes) {
  const raw = nodeBytes(subjectPublicKeyBitString, bytes);
  const keyDer = raw.subarray(1); // first byte is BIT STRING's "unused bits" count, always 0x00 for DER-encoded keys
  const [modulusNode] = parseDER(keyDer).children; // keyDer is the encoding of one SEQUENCE value — unwrap its own tag+length before reading its children
  let modulusLen = modulusNode.contentEnd - modulusNode.contentStart;
  const modulusBytes = nodeBytes(modulusNode, keyDer);
  if (modulusBytes[0] === 0x00) modulusLen -= 1; // strip the leading sign byte DER adds when the high bit would otherwise read as negative
  return modulusLen * 8;
}

function parseCertificate(bytes) {
  const outer = parseChildren(bytes, 0, bytes.length)[0]; // Certificate ::= SEQUENCE
  const outerChildren = parseChildren(bytes, outer.contentStart, outer.contentEnd);
  const [tbsCertificate, outerSignatureAlgorithm] = outerChildren; // Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
  let tbsChildren = parseChildren(bytes, tbsCertificate.contentStart, tbsCertificate.contentEnd);

  // tbsCertificate ::= SEQUENCE { [0] version (optional, context tag 0), serialNumber, signature,
  //                                issuer, validity, subject, subjectPublicKeyInfo, ... }
  // The optional [0] version wrapper (context-constructed tag 0) is only present for v2/v3 certs
  // (i.e. essentially always, in practice) — skip it if present so the rest of the field offsets line up.
  let idx = 0;
  if (tbsChildren[0] && tbsChildren[0].tagClass === 0x80 && tbsChildren[0].tag === 0) idx = 1;

  const serialNumberNode = tbsChildren[idx];
  const validityNode = tbsChildren[idx + 2 + 1]; // serialNumber(0), signature(1), issuer(2), validity(3)
  const subjectNode = tbsChildren[idx + 4];
  const subjectPublicKeyInfoNode = tbsChildren[idx + 5];

  const [notBeforeNode, notAfterNode] = parseChildren(bytes, validityNode.contentStart, validityNode.contentEnd);

  const [sigAlgOidNode] = parseChildren(bytes, outerSignatureAlgorithm.contentStart, outerSignatureAlgorithm.contentEnd);
  const sigAlgOid = oidToDotted(nodeBytes(sigAlgOidNode, bytes));
  const signatureAlgorithm = SIGNATURE_ALGORITHMS[sigAlgOid] || sigAlgOid;

  const [pkAlgIdNode, pkBitStringNode] = parseChildren(bytes, subjectPublicKeyInfoNode.contentStart, subjectPublicKeyInfoNode.contentEnd);
  const [pkAlgOidNode] = parseChildren(bytes, pkAlgIdNode.contentStart, pkAlgIdNode.contentEnd);
  const pkAlgOid = oidToDotted(nodeBytes(pkAlgOidNode, bytes));
  let publicKeyAlgorithm = pkAlgOid === OID_RSA_ENCRYPTION ? "RSA" : pkAlgOid === OID_EC_PUBLIC_KEY ? "EC" : pkAlgOid;
  let publicKeyBits = null;
  if (pkAlgOid === OID_RSA_ENCRYPTION) {
    try {
      publicKeyBits = rsaKeyBits(pkBitStringNode, bytes);
    } catch (e) {
      publicKeyBits = null;
    }
  }

  return {
    subjectCN: readCommonName(subjectNode, bytes),
    notBefore: parseAsn1Time(notBeforeNode, bytes),
    notAfter: parseAsn1Time(notAfterNode, bytes),
    serialNumber: integerToBigInt(serialNumberNode, bytes).toString(16),
    signatureAlgorithm,
    publicKeyAlgorithm,
    publicKeyBits,
    derBytes: bytes,
  };
}

function toHexColonUpper(buf) {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
    .join(":");
}

async function fingerprintSha1(derBytes) {
  const digest = await crypto.subtle.digest("SHA-1", derBytes);
  return toHexColonUpper(digest);
}

async function fingerprintSha256(derBytes) {
  const digest = await crypto.subtle.digest("SHA-256", derBytes);
  return toHexColonUpper(digest);
}

export { parseCertificate, fingerprintSha1, fingerprintSha256 };

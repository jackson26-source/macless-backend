// pkcs12.js — extracts the certificate(s) out of a PKCS#12 file (a .p12
// distribution cert, or a modern Android keystore — since JDK 9, keytool's
// default keystore format IS PKCS#12, so both use this exact same parser).
//
// Deliberately does NOT touch the private key. Signing Doctor never needs
// the key itself — every check it runs (subject, expiry, fingerprint,
// algorithm/size) reads off the certificate, and "was the password right"
// is answered by whether the certificate's own encrypted container
// (PBES2/PBKDF2+AES) decrypts cleanly. Skipping the key entirely means
// this never handles raw private key material beyond the password used
// to unwrap it — smaller code, smaller attack surface, nothing to get
// subtly wrong about a value nothing here actually uses.
//
// Only supports the modern PBES2 (PBKDF2 + AES-CBC) scheme, which is what
// current `keytool`/`openssl` produce by default (verified against a real
// `keytool -genkeypair` keystore and a real `openssl pkcs12 -export`
// output while building this — both use PBES2/PBKDF2/AES-256-CBC). Older
// files using the legacy RC2-40 scheme aren't handled — see the "legacy
// format" error below rather than silently misparsing.

import { parseChildren, parseDER, oidToDotted, nodeBytes, integerToBigInt, TAG } from "./der.js";

/** `bytes` is the raw encoding of exactly one SEQUENCE value (e.g. an OCTET STRING's content that itself holds a nested SEQUENCE) — read that outer TLV first, then return its children, rather than misreading the SEQUENCE's own tag+length header as if it were a list of top-level siblings. */
function unwrapSequence(bytes) {
  return parseDER(bytes).children;
}

const OID_PKCS7_DATA = "1.2.840.113549.1.7.1";
const OID_PKCS7_ENCRYPTED_DATA = "1.2.840.113549.1.7.6";
const OID_CERT_BAG = "1.2.840.113549.1.12.10.1.3";
const OID_X509_CERTIFICATE = "1.2.840.113549.1.9.22.1";
const OID_PBES2 = "1.2.840.113549.1.5.13";
const OID_PBKDF2 = "1.2.840.113549.1.5.12";
const OID_AES256_CBC = "2.16.840.1.101.3.4.1.42";
const OID_AES128_CBC = "2.16.840.1.101.3.4.1.2";
const OID_HMAC_SHA1 = "1.2.840.113549.2.7";
const OID_HMAC_SHA256 = "1.2.840.113549.2.9";
const OID_HMAC_SHA384 = "1.2.840.113549.2.10";
const OID_HMAC_SHA512 = "1.2.840.113549.2.11";

const PRF_HASH = {
  [OID_HMAC_SHA1]: "SHA-1",
  [OID_HMAC_SHA256]: "SHA-256",
  [OID_HMAC_SHA384]: "SHA-384",
  [OID_HMAC_SHA512]: "SHA-512",
};

class UnsupportedFormatError extends Error {}
class WrongPasswordError extends Error {}

/** Decrypts a PBES2-wrapped ciphertext (as found in a PKCS#12 EncryptedContentInfo) given the ASCII password. Returns the decrypted plaintext bytes with PKCS#7 padding stripped. */
async function decryptPBES2(algorithmIdentifier, ciphertext, passwordBytes, bytes) {
  const [algOid, params] = parseChildren(bytes, algorithmIdentifier.contentStart, algorithmIdentifier.contentEnd);
  if (oidToDotted(nodeBytes(algOid, bytes)) !== OID_PBES2) {
    throw new UnsupportedFormatError("Not a PBES2-encrypted value — likely an older (legacy RC2) .p12/.keystore format.");
  }
  const [kdf, encScheme] = parseChildren(bytes, params.contentStart, params.contentEnd);

  const [kdfOid, kdfParams] = parseChildren(bytes, kdf.contentStart, kdf.contentEnd);
  if (oidToDotted(nodeBytes(kdfOid, bytes)) !== OID_PBKDF2) throw new UnsupportedFormatError("Key derivation isn't PBKDF2 — unsupported format.");
  const kdfChildren = parseChildren(bytes, kdfParams.contentStart, kdfParams.contentEnd);
  const saltNode = kdfChildren[0];
  const iterationsNode = kdfChildren[1];
  // Optional keyLength (INTEGER) and prf (AlgorithmIdentifier) may follow, in either order presence-wise per RFC 8018 — prf is the only one we need, identified by being a SEQUENCE containing an OID rather than an INTEGER.
  let prfHash = "SHA-1"; // RFC 8018 default when prf is omitted
  for (let i = 2; i < kdfChildren.length; i++) {
    const child = kdfChildren[i];
    if (child.tag === TAG.SEQUENCE) {
      const [prfOid] = parseChildren(bytes, child.contentStart, child.contentEnd);
      const oid = oidToDotted(nodeBytes(prfOid, bytes));
      if (PRF_HASH[oid]) prfHash = PRF_HASH[oid];
    }
  }
  const salt = nodeBytes(saltNode, bytes);
  const iterations = Number(integerToBigInt(iterationsNode, bytes));

  const [encOid, encParams] = parseChildren(bytes, encScheme.contentStart, encScheme.contentEnd);
  const encOidDotted = oidToDotted(nodeBytes(encOid, bytes));
  let keyLengthBits;
  if (encOidDotted === OID_AES256_CBC) keyLengthBits = 256;
  else if (encOidDotted === OID_AES128_CBC) keyLengthBits = 128;
  else throw new UnsupportedFormatError(`Unsupported content-encryption algorithm (OID ${encOidDotted}) — expected AES-CBC.`);
  const iv = nodeBytes(encParams, bytes); // encryptionScheme params for aes-CBC-PAD is just the IV OCTET STRING

  const keyMaterial = await crypto.subtle.importKey("raw", passwordBytes, "PBKDF2", false, ["deriveBits"]);
  const derivedBits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: prfHash }, keyMaterial, keyLengthBits);
  const aesKey = await crypto.subtle.importKey("raw", derivedBits, "AES-CBC", false, ["decrypt"]);

  try {
    const plainBuf = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, aesKey, ciphertext);
    return new Uint8Array(plainBuf);
  } catch (e) {
    // AES-CBC decrypt in Web Crypto validates PKCS#7 padding and throws OperationError on a bad pad — the practical signal of a wrong password, since a correct password almost always yields valid padding and a wrong one almost never does.
    throw new WrongPasswordError("Couldn't decrypt — wrong password, or an unsupported/legacy PKCS#12 format.");
  }
}

/**
 * The password bytes fed into PBKDF2. Worth noting explicitly because
 * it's easy to get wrong by reading older references: RFC 7292 Appendix
 * B's original PKCS#12 PBE algorithm encodes the password as UTF-16BE
 * with a trailing NUL ("BMPString"), and it's tempting to assume that
 * carries over here — but that convention belongs to that legacy PBE
 * algorithm specifically. Once the container uses PBES2/PBKDF2 (RFC
 * 8018) — the modern default for both `openssl pkcs12 -export` and
 * `keytool -genkeypair` today — the password goes in as plain UTF-8,
 * full stop. Confirmed by generating real keystores/certs with both
 * tools and testing both encodings against the actual ciphertext: UTF-8
 * decrypts cleanly, BMPString+NUL does not.
 */
function pkcs12PasswordBytes(password) {
  return new TextEncoder().encode(password);
}

/** Walks a SafeContents (SEQUENCE OF SafeBag) and returns every embedded X.509 certificate's raw DER bytes. */
function extractCertsFromSafeContents(safeContentsBytes) {
  const bags = unwrapSequence(safeContentsBytes);
  const certs = [];
  for (const bag of bags) {
    const [bagIdNode, bagValueWrapper] = parseChildren(safeContentsBytes, bag.contentStart, bag.contentEnd);
    const bagId = oidToDotted(nodeBytes(bagIdNode, safeContentsBytes));
    if (bagId !== OID_CERT_BAG) continue; // skip key bags entirely — never needed
    const [certBag] = parseChildren(safeContentsBytes, bagValueWrapper.contentStart, bagValueWrapper.contentEnd); // [0] EXPLICIT CertBag
    const [certTypeNode, certValueWrapper] = parseChildren(safeContentsBytes, certBag.contentStart, certBag.contentEnd);
    const certType = oidToDotted(nodeBytes(certTypeNode, safeContentsBytes));
    if (certType !== OID_X509_CERTIFICATE) continue;
    const [certOctetString] = parseChildren(safeContentsBytes, certValueWrapper.contentStart, certValueWrapper.contentEnd); // [0] EXPLICIT OCTET STRING
    certs.push(nodeBytes(certOctetString, safeContentsBytes));
  }
  return certs;
}

/**
 * Parses a PKCS#12 file and returns every X.509 certificate it contains
 * (as raw DER bytes, ready for x509.js), given the file's password.
 * Throws WrongPasswordError if the password doesn't decrypt the
 * encrypted contents, or UnsupportedFormatError for a legacy/unrecognized
 * encryption scheme.
 */
async function extractCertificates(p12Bytes, password) {
  const passwordBytes = pkcs12PasswordBytes(password);
  const [pfxVersion, authSafeContentInfo] = unwrapSequence(p12Bytes); // ignoring optional MacData — integrity check, not needed for reading contents
  const [contentTypeNode, contentWrapper] = parseChildren(p12Bytes, authSafeContentInfo.contentStart, authSafeContentInfo.contentEnd);
  const contentType = oidToDotted(nodeBytes(contentTypeNode, p12Bytes));
  if (contentType !== OID_PKCS7_DATA) throw new UnsupportedFormatError("Unexpected outer PKCS#12 content type.");
  const [authSafeOctetString] = parseChildren(p12Bytes, contentWrapper.contentStart, contentWrapper.contentEnd); // [0] EXPLICIT OCTET STRING
  const authSafeBytes = nodeBytes(authSafeOctetString, p12Bytes);

  const contentInfos = unwrapSequence(authSafeBytes); // AuthenticatedSafe ::= SEQUENCE OF ContentInfo
  const certs = [];
  let sawAnyEncryptedData = false;

  for (const ci of contentInfos) {
    const [ciTypeNode, ciContentWrapper] = parseChildren(authSafeBytes, ci.contentStart, ci.contentEnd);
    const ciType = oidToDotted(nodeBytes(ciTypeNode, authSafeBytes));

    if (ciType === OID_PKCS7_DATA) {
      // Unencrypted SafeContents — an OCTET STRING directly containing SafeBags. Some tools put cert bags here instead of in EncryptedData.
      const [octetString] = parseChildren(authSafeBytes, ciContentWrapper.contentStart, ciContentWrapper.contentEnd);
      certs.push(...extractCertsFromSafeContents(nodeBytes(octetString, authSafeBytes)));
    } else if (ciType === OID_PKCS7_ENCRYPTED_DATA) {
      sawAnyEncryptedData = true;
      const [encryptedDataSeq] = parseChildren(authSafeBytes, ciContentWrapper.contentStart, ciContentWrapper.contentEnd); // [0] EXPLICIT EncryptedData
      const [edVersion, encryptedContentInfo] = parseChildren(authSafeBytes, encryptedDataSeq.contentStart, encryptedDataSeq.contentEnd);
      const eciChildren = parseChildren(authSafeBytes, encryptedContentInfo.contentStart, encryptedContentInfo.contentEnd);
      const algorithmIdentifier = eciChildren[1];
      const encryptedContentNode = eciChildren[2]; // [0] IMPLICIT OCTET STRING
      const ciphertext = nodeBytes(encryptedContentNode, authSafeBytes);
      const plaintext = await decryptPBES2(algorithmIdentifier, ciphertext, passwordBytes, authSafeBytes);
      certs.push(...extractCertsFromSafeContents(plaintext));
    }
    // (keyBag/pkcs8ShroudedKeyBag content, if present as its own top-level ContentInfo, is silently skipped — never needed)
  }

  return { certs, hadEncryptedContent: sawAnyEncryptedData };
}

export { extractCertificates, UnsupportedFormatError, WrongPasswordError };

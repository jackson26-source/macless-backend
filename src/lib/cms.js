// cms.js — extracts the embedded content out of a CMS/PKCS#7 SignedData
// envelope. A .mobileprovision file IS exactly this: Apple signs the
// profile's plist and embeds the plist bytes directly in the envelope
// (never detached), which is exactly what `security cms -D -i` does on
// macOS — decode the envelope and print the embedded content, nothing
// more.
//
// Deliberately does NOT verify the signature or walk the embedded
// certificate chain. Neither does the real signing-doctor.sh script —
// `security cms -D -i` just decodes; it doesn't assert the profile was
// signed by Apple's real WWDR CA. Whether a profile is genuinely
// Apple-issued isn't something this tool has ever claimed to check —
// what it checks is whether the profile's own *declared* contents
// (team ID, bundle ID, expiry, embedded dev certs) are consistent with
// what you told it to expect and with the cert you're pairing it with.

import { parseDER, parseChildren, oidToDotted, nodeBytes } from "./der.js";

const OID_SIGNED_DATA = "1.2.840.113549.1.7.2";

class NotACmsEnvelopeError extends Error {}

/**
 * Parses a DER-encoded CMS ContentInfo wrapping SignedData and returns
 * the embedded (non-detached) content's raw bytes — for a provisioning
 * profile, this is the plist XML.
 */
function extractSignedContent(bytes) {
  const { children } = parseDER(bytes); // ContentInfo ::= SEQUENCE { contentType, content [0] EXPLICIT }
  const [contentTypeNode, contentWrapper] = children;
  if (!contentTypeNode || !contentWrapper) throw new NotACmsEnvelopeError("Not a CMS ContentInfo structure.");
  const contentType = oidToDotted(nodeBytes(contentTypeNode, bytes));
  if (contentType !== OID_SIGNED_DATA) throw new NotACmsEnvelopeError(`Not a CMS SignedData envelope (contentType OID ${contentType}).`);

  const [signedData] = parseChildren(bytes, contentWrapper.contentStart, contentWrapper.contentEnd);
  const sdChildren = parseChildren(bytes, signedData.contentStart, signedData.contentEnd);
  // SignedData ::= SEQUENCE { version, digestAlgorithms SET, encapContentInfo SEQUENCE, certificates [0] OPTIONAL, crls [1] OPTIONAL, signerInfos SET }
  // certificates/crls are OPTIONAL context-tagged fields — encapContentInfo is always the 3rd child regardless of whether they're present, since it comes before them.
  const encapContentInfo = sdChildren[2];
  const [eContentType, eContentWrapper] = parseChildren(bytes, encapContentInfo.contentStart, encapContentInfo.contentEnd);
  if (!eContentWrapper) throw new NotACmsEnvelopeError("This profile's content is detached (no embedded plist) — can't read it from the file alone.");
  const [eContentOctetString] = parseChildren(bytes, eContentWrapper.contentStart, eContentWrapper.contentEnd);
  return nodeBytes(eContentOctetString, bytes);
}

export { extractSignedContent, NotACmsEnvelopeError };

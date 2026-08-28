// der.js — a minimal DER/BER reader. Not a general-purpose ASN.1 library:
// just enough to walk the specific structures Signing Doctor needs
// (PKCS#12 keystores, X.509 certificates, CMS/PKCS#7 SignedData) without
// pulling in an external dependency. Every format below is built on the
// same primitive: a sequence of {tag, constructed, class, length, bytes,
// children} nodes.
//
// Why hand-write this instead of using a library: Cloudflare Workers has
// no npm-install-at-request-time and this sandbox has no npm registry
// access to even fetch one during development, so anything used here has
// to either ship as source or be built from platform primitives. DER is
// a fully specified, stable, tiny format — a few hundred lines covers
// everything the real signing-doctor.sh script reads.

const CLASS_UNIVERSAL = 0x00;
const CLASS_CONTEXT = 0x80;

function readLength(bytes, pos) {
  const first = bytes[pos];
  if ((first & 0x80) === 0) return { length: first, next: pos + 1 };
  const numBytes = first & 0x7f;
  if (numBytes === 0) throw new Error("DER: indefinite length not supported");
  let length = 0;
  for (let i = 0; i < numBytes; i++) length = length * 256 + bytes[pos + 1 + i];
  return { length, next: pos + 1 + numBytes };
}

/** Parses one DER TLV at `pos`. Returns { tag, tagClass, constructed, length, contentStart, contentEnd, end }. */
function readTLV(bytes, pos) {
  const tagByte = bytes[pos];
  const tagClass = tagByte & 0xc0;
  const constructed = (tagByte & 0x20) !== 0;
  let tagNumber = tagByte & 0x1f;
  let next = pos + 1;
  if (tagNumber === 0x1f) {
    // high-tag-number form — not needed for anything Signing Doctor reads, but don't silently misparse if encountered
    tagNumber = 0;
    let b;
    do {
      b = bytes[next];
      tagNumber = tagNumber * 128 + (b & 0x7f);
      next++;
    } while (b & 0x80);
  }
  const { length, next: contentStart } = readLength(bytes, next);
  const contentEnd = contentStart + length;
  return { tag: tagNumber, tagClass, constructed, length, contentStart, contentEnd, end: contentEnd, raw: bytes.subarray(pos, contentEnd) };
}

/** Parses a full sequence of sibling TLVs between [start, end). Does NOT recurse — call parseChildren again on a constructed node's content to go deeper. */
function parseChildren(bytes, start, end) {
  const nodes = [];
  let pos = start;
  while (pos < end) {
    const node = readTLV(bytes, pos);
    nodes.push(node);
    pos = node.end;
  }
  return nodes;
}

/** Convenience: parse a top-level DER document and return its single root TLV plus, if constructed, its immediate children. */
function parseDER(bytes) {
  const root = readTLV(bytes, 0);
  const children = root.constructed ? parseChildren(bytes, root.contentStart, root.contentEnd) : [];
  return { root, children };
}

/** Decodes an OID's raw content bytes (i.e. an OID TLV's contentStart..contentEnd) into dotted notation, e.g. "1.2.840.113549.1.12.10.1.3". */
function oidToDotted(bytes) {
  const parts = [];
  parts.push(Math.floor(bytes[0] / 40), bytes[0] % 40);
  let value = 0;
  for (let i = 1; i < bytes.length; i++) {
    value = value * 128 + (bytes[i] & 0x7f);
    if ((bytes[i] & 0x80) === 0) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join(".");
}

function bytesToBigHexOID(bytes) {
  // Minimal OID decoder — only used to recognize a small fixed set of known OIDs (see oid.js-equivalent constants below).
  const parts = [];
  let first = bytes[0];
  parts.push(Math.floor(first / 40), first % 40);
  let value = 0;
  for (let i = 1; i < bytes.length; i++) {
    const b = bytes[i];
    value = value * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join(".");
}

/** Reads an INTEGER node's raw bytes as a non-negative BigInt (DER integers are big-endian two's complement; every integer Signing Doctor reads — versions, serial numbers — is non-negative). */
function integerToBigInt(node, bytes) {
  const content = bytes.subarray(node.contentStart, node.contentEnd);
  let hex = "";
  for (const b of content) hex += b.toString(16).padStart(2, "0");
  return hex.length ? BigInt("0x" + hex) : 0n;
}

/** Reads an OCTET STRING or similar simple content node as raw bytes. */
function nodeBytes(node, bytes) {
  return bytes.subarray(node.contentStart, node.contentEnd);
}

/** DER UTCTime/GeneralizedTime -> a JS Date. */
function parseAsn1Time(node, bytes) {
  const str = new TextDecoder().decode(nodeBytes(node, bytes));
  // UTCTime: YYMMDDHHMMSSZ  |  GeneralizedTime: YYYYMMDDHHMMSSZ
  const isGeneralized = str.length >= 15 && /^\d{14}/.test(str);
  let year, rest;
  if (isGeneralized) {
    year = Number(str.slice(0, 4));
    rest = str.slice(4);
  } else {
    const yy = Number(str.slice(0, 2));
    year = yy < 50 ? 2000 + yy : 1900 + yy;
    rest = str.slice(2);
  }
  const month = Number(rest.slice(0, 2));
  const day = Number(rest.slice(2, 4));
  const hour = Number(rest.slice(4, 6));
  const min = Number(rest.slice(6, 8));
  const sec = Number(rest.slice(8, 10)) || 0;
  return new Date(Date.UTC(year, month - 1, day, hour, min, sec));
}

export { readTLV, readLength, parseChildren, parseDER, oidToDotted, bytesToBigHexOID, integerToBigInt, nodeBytes, parseAsn1Time, CLASS_UNIVERSAL, CLASS_CONTEXT };

// Universal tag numbers used throughout the higher-level parsers.
const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8String: 0x0c,
  SEQUENCE: 0x10,
  SET: 0x11,
  PrintableString: 0x13,
  T61String: 0x14,
  IA5String: 0x16,
  UTCTime: 0x17,
  GeneralizedTime: 0x18,
};

export { TAG };

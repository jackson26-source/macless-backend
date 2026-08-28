// plist.js — a minimal parser for Apple's XML property list format, just
// enough to read a provisioning profile's plist (the content extracted
// by cms.js). Not a general XML parser: handles exactly the plist DTD's
// element set (dict/key/array/string/data/date/true/false/integer/real)
// and nothing else — no namespaces, no attributes beyond what plist
// itself never uses, no CDATA. Workers has no DOMParser and this
// sandbox has no npm registry to fetch an XML library from, so this is
// hand-rolled against the plist spec directly.

function stripDoctype(xml) {
  // Drop the XML declaration and DOCTYPE — cheap to skip rather than parse, and irrelevant to the data.
  return xml.replace(/<\?xml[^>]*\?>/, "").replace(/<!DOCTYPE[^>]*(\[[^\]]*\])?>/s, "").trim();
}

/** Tokenizes into a flat list of {type: 'open'|'close'|'selfclose'|'text', name, text}. */
function tokenize(xml) {
  const tokens = [];
  let i = 0;
  const n = xml.length;
  while (i < n) {
    if (xml[i] === "<") {
      const end = xml.indexOf(">", i);
      if (end === -1) throw new Error("plist: unterminated tag");
      const tag = xml.slice(i + 1, end);
      if (tag.startsWith("!--")) {
        const commentEnd = xml.indexOf("-->", i);
        i = commentEnd === -1 ? n : commentEnd + 3;
        continue;
      }
      if (tag.startsWith("/")) {
        tokens.push({ type: "close", name: tag.slice(1).trim() });
      } else if (tag.endsWith("/")) {
        tokens.push({ type: "selfclose", name: tag.slice(0, -1).trim() });
      } else {
        tokens.push({ type: "open", name: tag.trim() });
      }
      i = end + 1;
    } else {
      const nextTag = xml.indexOf("<", i);
      const textEnd = nextTag === -1 ? n : nextTag;
      const text = xml.slice(i, textEnd);
      if (text.trim().length > 0) tokens.push({ type: "text", text: decodeEntities(text) });
      i = textEnd;
    }
  }
  return tokens;
}

function decodeEntities(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function base64ToBytes(b64) {
  const clean = b64.replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Recursive-descent: consumes tokens starting at `pos`, returns [value, nextPos] for the single plist value starting there. */
function parseValue(tokens, pos) {
  const tok = tokens[pos];
  if (!tok) throw new Error("plist: unexpected end of document");

  if (tok.type === "selfclose") {
    if (tok.name === "true") return [true, pos + 1];
    if (tok.name === "false") return [false, pos + 1];
    throw new Error(`plist: unexpected self-closing tag <${tok.name}/>`);
  }

  if (tok.type !== "open") throw new Error(`plist: expected an element, got ${tok.type}`);
  const name = tok.name;

  if (name === "dict") {
    const obj = {};
    let i = pos + 1;
    while (tokens[i] && !(tokens[i].type === "close" && tokens[i].name === "dict")) {
      if (tokens[i].name !== "key") throw new Error("plist: expected <key> inside <dict>");
      let key;
      if (tokens[i].type === "selfclose") {
        key = "";
        i += 1;
      } else {
        const keyTextTok = tokens[i + 1];
        key = keyTextTok && keyTextTok.type === "text" ? keyTextTok.text : "";
        i += keyTextTok && keyTextTok.type === "text" ? 3 : 2; // <key>text</key> or <key></key>
      }
      const [value, nextI] = parseValue(tokens, i);
      obj[key] = value;
      i = nextI;
    }
    return [obj, i + 1]; // skip closing </dict>
  }

  if (name === "array") {
    const arr = [];
    let i = pos + 1;
    while (tokens[i] && !(tokens[i].type === "close" && tokens[i].name === "array")) {
      const [value, nextI] = parseValue(tokens, i);
      arr.push(value);
      i = nextI;
    }
    return [arr, i + 1];
  }

  if (name === "string" || name === "date" || name === "integer" || name === "real") {
    const textTok = tokens[pos + 1];
    const text = textTok && textTok.type === "text" ? textTok.text : "";
    const closeIdx = textTok && textTok.type === "text" ? pos + 2 : pos + 1; // handles empty <string></string>
    if (name === "integer") return [parseInt(text, 10), closeIdx + 1];
    if (name === "real") return [parseFloat(text), closeIdx + 1];
    return [text, closeIdx + 1];
  }

  if (name === "data") {
    const textTok = tokens[pos + 1];
    const text = textTok && textTok.type === "text" ? textTok.text : "";
    const closeIdx = textTok && textTok.type === "text" ? pos + 2 : pos + 1;
    return [base64ToBytes(text), closeIdx + 1];
  }

  throw new Error(`plist: unsupported element <${name}>`);
}

/** Parses a full XML plist document (as extracted from a provisioning profile's CMS envelope) into a plain JS value (usually an object, for a top-level <dict>). */
function parsePlist(xmlText) {
  const body = stripDoctype(xmlText);
  const tokens = tokenize(body);
  let i = 0;
  if (tokens[i] && tokens[i].type === "open" && /^plist(\s|$)/.test(tokens[i].name)) {
    i += 1; // enter <plist version="1.0"> — the tag can carry attributes, only its element name matters here
  }
  const [value] = parseValue(tokens, i);
  return value;
}

export { parsePlist };

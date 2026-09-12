// zip-extract.js — minimal, dependency-free ZIP reader for pulling a single
// named file out of a small archive (a GitHub Actions artifact download).
// Zero external dependencies, same posture as the rest of this codebase.
//
// Deliberately reads the ZIP End Of Central Directory + Central Directory
// records rather than trusting the per-entry Local File Header's size
// fields. Streaming zip writers (including the one behind GitHub's own
// actions/upload-artifact) commonly set the "data descriptor" bit (general
// purpose flag bit 3), which means the Local File Header's compressed/
// uncompressed size fields are zero and the real sizes are written in a
// data descriptor AFTER the file data instead. The Central Directory does
// not have this problem — its size fields are always correct — so this
// reader uses the Local File Header only to find where a given entry's
// compressed bytes start (by reading that entry's own filename/extra-field
// lengths, which can differ from the Central Directory's copy), and takes
// the actual sizes and compression method from the Central Directory.
//
// Supports compression method 0 (stored) and 8 (deflate, via the
// platform's DecompressionStream — available in both Cloudflare Workers
// and modern Node, so this can be exercised in a local test the same way
// it runs in production).

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;

function findEndOfCentralDirectory(bytes) {
  // EOCD is a fixed 22-byte record plus an optional comment (0-65535 bytes)
  // at the very end of the file, so scan backward for its signature rather
  // than assuming a fixed offset.
  const maxCommentLen = 65535;
  const minOffset = Math.max(0, bytes.length - 22 - maxCommentLen);
  for (let i = bytes.length - 22; i >= minOffset; i--) {
    if (
      bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06
    ) {
      return i;
    }
  }
  return -1;
}

function readUInt32LE(view, offset) {
  return view.getUint32(offset, true);
}
function readUInt16LE(view, offset) {
  return view.getUint16(offset, true);
}

function parseCentralDirectory(bytes) {
  const eocdOffset = findEndOfCentralDirectory(bytes);
  if (eocdOffset === -1) throw new Error("Not a valid ZIP file (no End Of Central Directory record found).");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = readUInt32LE(view, eocdOffset);
  if (signature !== EOCD_SIGNATURE) throw new Error("Malformed ZIP End Of Central Directory record.");

  const totalEntries = readUInt16LE(view, eocdOffset + 10);
  const centralDirSize = readUInt32LE(view, eocdOffset + 12);
  const centralDirOffset = readUInt32LE(view, eocdOffset + 16);

  const entries = [];
  let pos = centralDirOffset;
  const decoder = new TextDecoder("utf-8");
  for (let i = 0; i < totalEntries; i++) {
    if (readUInt32LE(view, pos) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error("Malformed ZIP Central Directory entry at index " + i + ".");
    }
    const compressionMethod = readUInt16LE(view, pos + 10);
    const compressedSize = readUInt32LE(view, pos + 20);
    const uncompressedSize = readUInt32LE(view, pos + 24);
    const fileNameLength = readUInt16LE(view, pos + 28);
    const extraFieldLength = readUInt16LE(view, pos + 30);
    const fileCommentLength = readUInt16LE(view, pos + 32);
    const localHeaderOffset = readUInt32LE(view, pos + 42);
    const nameStart = pos + 46;
    const fileName = decoder.decode(bytes.subarray(nameStart, nameStart + fileNameLength));

    entries.push({ fileName, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
    pos = nameStart + fileNameLength + extraFieldLength + fileCommentLength;
  }
  // centralDirSize isn't strictly needed once every entry is walked, but a
  // mismatch is a useful signal that something upstream is corrupt.
  if (pos - centralDirOffset > centralDirSize + 4096) {
    throw new Error("ZIP Central Directory entries ran past the recorded directory size — archive may be corrupt.");
  }
  return entries;
}

async function inflateRaw(compressedBytes) {
  const stream = new Blob([compressedBytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

// Returns { fileName, bytes } for the first entry in the archive whose name
// matches "namePredicate" (a function, or a plain string for an exact
// match), or null if the archive has no such entry. Throws only on a
// genuinely malformed ZIP — a missing file just returns null, since the
// caller (the /api/build-artifact route) treats "no screenshot in this
// artifact" the same as "no artifact at all": a hint, not a hard failure.
async function extractFileFromZip(zipBytes, namePredicate) {
  const matches = typeof namePredicate === "function" ? namePredicate : (name) => name === namePredicate;
  const entries = parseCentralDirectory(zipBytes);
  const entry = entries.find((e) => matches(e.fileName));
  if (!entry) return null;

  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const lh = entry.localHeaderOffset;
  if (readUInt32LE(view, lh) !== LOCAL_FILE_SIGNATURE) {
    throw new Error("Malformed ZIP Local File Header for \"" + entry.fileName + "\".");
  }
  const lhFileNameLength = readUInt16LE(view, lh + 26);
  const lhExtraFieldLength = readUInt16LE(view, lh + 28);
  const dataStart = lh + 30 + lhFileNameLength + lhExtraFieldLength;
  const compressedBytes = zipBytes.subarray(dataStart, dataStart + entry.compressedSize);

  let outBytes;
  if (entry.compressionMethod === 0) {
    outBytes = compressedBytes;
  } else if (entry.compressionMethod === 8) {
    outBytes = await inflateRaw(compressedBytes);
  } else {
    throw new Error("Unsupported ZIP compression method " + entry.compressionMethod + " for \"" + entry.fileName + "\" — only stored (0) and deflate (8) are handled.");
  }
  if (outBytes.length !== entry.uncompressedSize) {
    throw new Error("Decompressed size mismatch for \"" + entry.fileName + "\": expected " + entry.uncompressedSize + ", got " + outBytes.length + ".");
  }
  return { fileName: entry.fileName, bytes: outBytes };
}

export { extractFileFromZip };

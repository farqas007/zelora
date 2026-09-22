/**
 * Base64url (RFC 4648 §5) without padding, implemented in dependency-free
 * TypeScript so the same code works in Node, browsers and Cloudflare Workers.
 *
 * Both helpers deliberately avoid `Buffer` and any Node-only API.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Maps a byte value (0-63) to its base64url character. */
const ENCODE_TABLE = [...ALPHABET].map((character) => character.charCodeAt(0));

/** Maps a character code to its base64url value, or -1 when out of range. */
const DECODE_TABLE: number[] = new Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) {
  DECODE_TABLE[ALPHABET.charCodeAt(i)] = i;
}

/** Encode bytes as base64url without padding. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let result = "";
  const length = bytes.length;
  const complete = length - (length % 3);

  for (let i = 0; i < complete; i += 3) {
    const first = bytes[i]!;
    const second = bytes[i + 1]!;
    const third = bytes[i + 2]!;
    result += String.fromCharCode(
      ENCODE_TABLE[first >> 2]!,
      ENCODE_TABLE[((first & 0x03) << 4) | (second >> 4)]!,
      ENCODE_TABLE[((second & 0x0f) << 2) | (third >> 6)]!,
      ENCODE_TABLE[third & 0x3f]!,
    );
  }

  const remainder = length % 3;
  if (remainder === 1) {
    const byte = bytes[length - 1]!;
    result += String.fromCharCode(
      ENCODE_TABLE[byte >> 2]!,
      ENCODE_TABLE[(byte & 0x03) << 4]!,
    );
  } else if (remainder === 2) {
    const first = bytes[length - 2]!;
    const second = bytes[length - 1]!;
    result += String.fromCharCode(
      ENCODE_TABLE[first >> 2]!,
      ENCODE_TABLE[((first & 0x03) << 4) | (second >> 4)]!,
      ENCODE_TABLE[(second & 0x0f) << 2]!,
    );
  }

  return result;
}

/**
 * Decode unpadded base64url back into bytes.
 *
 * Returns `null` for any input that is not canonical base64url without
 * padding (bad characters, `=` padding, non-canonical trailing bits or a
 * length that cannot represent whole bytes). An empty string decodes to an
 * empty byte array.
 */
export function base64UrlToBytes(input: string): Uint8Array | null {
  if (input.length === 0) {
    return new Uint8Array();
  }

  const length = input.length;
  if (length % 4 === 1) {
    return null;
  }

  const remainder = length % 4;
  const output = new Uint8Array(((length - remainder) / 4) * 3 + (remainder === 0 ? 0 : remainder - 1));
  let outIndex = 0;
  let i = 0;

  while (i + 4 <= length) {
    const first = decodeChar(input.charCodeAt(i));
    const second = decodeChar(input.charCodeAt(i + 1));
    const third = decodeChar(input.charCodeAt(i + 2));
    const fourth = decodeChar(input.charCodeAt(i + 3));
    if (first < 0 || second < 0 || third < 0 || fourth < 0) {
      return null;
    }
    output[outIndex++] = (first << 2) | (second >> 4);
    output[outIndex++] = ((second & 0x0f) << 4) | (third >> 2);
    output[outIndex++] = ((third & 0x03) << 6) | fourth;
    i += 4;
  }

  if (remainder === 2) {
    const first = decodeChar(input.charCodeAt(i));
    const second = decodeChar(input.charCodeAt(i + 1));
    if (first < 0 || second < 0 || (second & 0x0f) !== 0) {
      return null;
    }
    output[outIndex++] = (first << 2) | (second >> 4);
  } else if (remainder === 3) {
    const first = decodeChar(input.charCodeAt(i));
    const second = decodeChar(input.charCodeAt(i + 1));
    const third = decodeChar(input.charCodeAt(i + 2));
    if (first < 0 || second < 0 || third < 0 || (third & 0x03) !== 0) {
      return null;
    }
    output[outIndex++] = (first << 2) | (second >> 4);
    output[outIndex++] = ((second & 0x0f) << 4) | (third >> 2);
  }

  return output;
}

/** @internal */
function decodeChar(charCode: number): number {
  return charCode < DECODE_TABLE.length ? DECODE_TABLE[charCode]! : -1;
}
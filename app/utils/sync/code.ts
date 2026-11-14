// 同步码：把 spaceId 和 spaceSecret 拼成便于抄写复制的一串。
// 格式：只用大写字母和数字（base32：A–Z、2–7），每 4 位一组、用短横线分开，末尾带 1 位校验码。
//   原文 = spaceId(16 位 base32) + spaceSecret 的 base32(52 位，对应 32 字节) + 校验位
// 校验：每个字符的值（0–31）乘一个奇数权重后求和，对 32 取余，补成 0。奇数权重在模 32 下可逆，
// 所以抄错任意一个字符一定能发现；相邻两个字符写反绝大多数也能发现。

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ID_LEN = 16;
const SECRET_BYTES = 32;
const SECRET_LEN = 52; // ceil(32 * 8 / 5)
export const SYNC_CODE_ERROR = '同步码有误';

function checkValue(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += ALPHABET.indexOf(body[i]) * (2 * (i % 16) + 1);
  return (32 - (sum % 32)) % 32;
}

function bytesToBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32ToBytes(text: string, byteLen: number): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out.slice(0, byteLen));
}

function b64urlToBytes(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 服务器给的 spaceId（16 位小写 base32）和 spaceSecret（32 字节的 urlsafe base64）→ 同步码。 */
export function encodeSyncCode(spaceId: string, spaceSecret: string): string {
  const id = spaceId.trim().toUpperCase();
  if (id.length !== ID_LEN || [...id].some(c => !ALPHABET.includes(c))) throw new Error('空间编号格式不对，生成不了同步码');
  let secret: Uint8Array;
  try {
    secret = b64urlToBytes(spaceSecret.trim());
  } catch {
    throw new Error('空间密钥格式不对，生成不了同步码');
  }
  if (secret.length !== SECRET_BYTES) throw new Error('空间密钥格式不对，生成不了同步码');
  const body = id + bytesToBase32(secret);
  const full = body + ALPHABET[checkValue(body)];
  return full.match(/.{1,4}/g)!.join('-');
}

/** 同步码 → { spaceId, spaceSecret }（和服务器给的格式一致）。容忍大小写和多余空格；有误抛「同步码有误」。 */
export function decodeSyncCode(code: string): { spaceId: string; spaceSecret: string } {
  const text = code.replace(/[\s-]+/g, '').toUpperCase();
  if (text.length !== ID_LEN + SECRET_LEN + 1 || [...text].some(c => !ALPHABET.includes(c))) throw new Error(SYNC_CODE_ERROR);
  const body = text.slice(0, -1);
  if (ALPHABET[checkValue(body)] !== text.slice(-1)) throw new Error(SYNC_CODE_ERROR);
  const spaceId = body.slice(0, ID_LEN).toLowerCase();
  const secret = base32ToBytes(body.slice(ID_LEN), SECRET_BYTES);
  return { spaceId, spaceSecret: bytesToB64url(secret) };
}

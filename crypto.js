// 账本加密：和 Mac 版（ledger 仓库的 secure.py）格式完全一样，同一个密码两边算出同一把钥匙，
// 一边加密的账单另一边能解开。账单内容在手机上加密后才上传，云端只存乱码。
//
// 密码经 scrypt 推导出 64 字节：前 32 字节是 AES-GCM 加密密钥（只在内存里），
// 后 32 字节是“写入凭证”（改账单时发给云端，云端只存它的 SHA-256 来核对）。

import { scryptAsync } from "./vendor/noble-hashes/scrypt.js";

const CHECK_TEXT = "ledger-password-check-v1";
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

export class BadPassword extends Error {}

export function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function unb64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function newKdfParams() {
  return { alg: "scrypt", n: 2 ** 16, r: 8, p: 1, salt: b64(crypto.getRandomValues(new Uint8Array(16))) };
}

async function importKey(encKey, auth) {
  const aes = await crypto.subtle.importKey("raw", encKey, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { encKey, auth, aes };
}

// 由密码推导密钥。kdf 参数来自云端，先检查范围，防止被塞进超大参数卡死手机。
// 不要用 scrypt 的 onProgress：它每算一小块就回调一次，会慢 4 倍多。
export async function deriveKey(password, kdf) {
  const n = Number(kdf.n), r = Number(kdf.r), p = Number(kdf.p);
  const ok =
    kdf.alg === "scrypt" &&
    [n, r, p].every(Number.isInteger) &&
    n >= 2 ** 14 && n <= 2 ** 20 && (n & (n - 1)) === 0 &&
    r >= 1 && r <= 32 && p >= 1 && p <= 4;
  if (!ok) throw new Error("unsupported key-derivation parameters");
  const raw = await scryptAsync(utf8.encode(password.normalize("NFC")), unb64(kdf.salt), {
    N: n, r, p, dkLen: 64, asyncTick: 20, // 每 20 毫秒让一下，算的时候画面不卡
  });
  return importKey(raw.slice(0, 32), hex(raw.slice(32)));
}

// AES-GCM 加密。context 把密文绑定到它的位置（哪个账本的哪条账单），挪到别处就解不开。
// 格式：base64(12 字节随机数 + 密文 + 16 字节校验)，和 Mac 版一样。
export async function encrypt(key, data, context) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: utf8.encode(context) }, key.aes, data),
  );
  const out = new Uint8Array(12 + sealed.length);
  out.set(nonce);
  out.set(sealed, 12);
  return b64(out);
}

export async function decrypt(key, token, context) {
  try {
    const raw = unb64(token);
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: raw.slice(0, 12), additionalData: utf8.encode(context) },
        key.aes,
        raw.slice(12),
      ),
    );
  } catch {
    throw new BadPassword();
  }
}

export const encryptText = (key, text, context) => encrypt(key, utf8.encode(text), context);
export const decryptText = async (key, token, context) => fromUtf8.decode(await decrypt(key, token, context));

// 一段用密钥加密的固定文字，存在云端，用来判断输入的密码对不对。
export const makeCheck = (key, ledgerId) => encryptText(key, CHECK_TEXT, `check:${ledgerId}`);

export async function verifyCheck(key, checkBlob, ledgerId) {
  try {
    return (await decryptText(key, checkBlob, `check:${ledgerId}`)) === CHECK_TEXT;
  } catch {
    return false;
  }
}

// 第二套密码（只有「噜噜的情债」）：用它（自己的 scrypt 盐）把账本的密钥和写入凭证加密包起来。
// 和 Mac 版 secure.wrap_key / unwrap_key 一样。
export async function wrapKey(key, password, context) {
  const kdf = newKdfParams();
  const payload = JSON.stringify({ enc_key: b64(key.encKey), auth: key.auth });
  return JSON.stringify({ v: 1, kdf, wrapped: await encryptText(await deriveKey(password, kdf), payload, context) });
}

export async function unwrapKey(blob, password, context) {
  try {
    const data = JSON.parse(blob);
    const raw = JSON.parse(await decryptText(await deriveKey(password, data.kdf), data.wrapped, context));
    return await importKey(unb64(raw.enc_key), String(raw.auth));
  } catch {
    throw new BadPassword();
  }
}

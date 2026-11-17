export const SELF_HOSTED_ACCESS_COOKIE = "float_self_hosted_access";
export const SELF_HOSTED_ACCESS_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const encoder = new TextEncoder();

function getAccessPassword(): string {
  return process.env.SELF_HOSTED_ACCESS_PASSWORD || "";
}

function getSigningSecret(): string {
  return process.env.SELF_HOSTED_ACCESS_SECRET || "";
}

export function isSelfHostedAccessConfigured(): boolean {
  const passwordLength = getAccessPassword().length;
  return passwordLength >= 32 && passwordLength <= 256 && getSigningSecret().length >= 32;
}

function bytesToBase64Url(bytes: ArrayBuffer): string {
  const array = new Uint8Array(bytes);
  let binary = "";
  for (const byte of array) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

async function signPayload(payload: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(getSigningSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return bytesToBase64Url(signature);
}

export async function verifySelfHostedAccessPassword(candidate: string): Promise<boolean> {
  if (!isSelfHostedAccessConfigured() || typeof candidate !== "string" || candidate.length > 256) {
    return false;
  }
  const [expected, actual] = await Promise.all([
    globalThis.crypto.subtle.digest("SHA-256", encoder.encode(getAccessPassword())),
    globalThis.crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
  ]);
  const expectedBytes = new Uint8Array(expected);
  const actualBytes = new Uint8Array(actual);
  let mismatch = 0;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    mismatch |= expectedBytes[index] ^ actualBytes[index];
  }
  return mismatch === 0;
}

export async function createSelfHostedAccessCookieValue(): Promise<string> {
  if (!isSelfHostedAccessConfigured()) return "";
  const expiresAt = Math.floor(Date.now() / 1000) + SELF_HOSTED_ACCESS_MAX_AGE_SECONDS;
  const payload = `v1.${expiresAt}`;
  return `${payload}.${await signPayload(payload)}`;
}

export async function verifySelfHostedAccessCookieValue(value: string): Promise<boolean> {
  if (!isSelfHostedAccessConfigured() || !value || value.length > 256) return false;
  const [version, expiresAtRaw, signature, ...rest] = value.split(".");
  if (rest.length > 0 || version !== "v1" || !expiresAtRaw || !signature) return false;
  const expiresAt = Number(expiresAtRaw);
  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + SELF_HOSTED_ACCESS_MAX_AGE_SECONDS + 60
  ) {
    return false;
  }
  const expected = await signPayload(`v1.${expiresAtRaw}`);
  return constantTimeEqual(signature, expected);
}

export interface VerifiedWebAppUser {
  id: string;
  first_name: string;
  username?: string;
}

/**
 * Validates Telegram Mini App initData using Telegram's bot-token HMAC scheme.
 * The optional "signature" field is included in the bot HMAC data-check string;
 * only "hash" is excluded.
 */
export async function verifyTelegramWebApp(
  botToken: string | undefined,
  initData: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<VerifiedWebAppUser | null> {
  if (!botToken || !initData || initData.length > 8192) return null;

  try {
    const params = new URLSearchParams(initData);
    const entries = [...params.entries()];
    const keys = new Set<string>();
    for (const [key] of entries) {
      if (keys.has(key)) return null;
      keys.add(key);
    }

    const receivedHash = params.get("hash");
    const authDateValue = params.get("auth_date");
    const authDate = authDateValue && /^\d+$/.test(authDateValue) ? Number(authDateValue) : NaN;
    const userJson = params.get("user");
    if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash) || !userJson ||
      !Number.isSafeInteger(authDate) || authDate <= 0) return null;
    if (authDate > nowSeconds + 60 || nowSeconds - authDate > 86400) return null;

    const dataCheckString = entries
      .filter(([key]) => key !== "hash")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const encoder = new TextEncoder();
    const webAppKey = await crypto.subtle.importKey(
      "raw", encoder.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const secret = await crypto.subtle.sign("HMAC", webAppKey, encoder.encode(botToken));
    const signingKey = await crypto.subtle.importKey(
      "raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const digest = await crypto.subtle.sign("HMAC", signingKey, encoder.encode(dataCheckString));
    const calculatedHash = [...new Uint8Array(digest)]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");

    let mismatch = calculatedHash.length ^ receivedHash.length;
    for (let i = 0; i < Math.min(calculatedHash.length, receivedHash.length); i++) {
      mismatch |= calculatedHash.charCodeAt(i) ^ receivedHash.charCodeAt(i);
    }
    if (mismatch !== 0) return null;

    const user = JSON.parse(userJson) as { id?: number; first_name?: string; username?: string };
    if (!Number.isSafeInteger(user.id) || !user.id) return null;
    return { id: String(user.id), first_name: user.first_name ?? "", username: user.username };
  } catch {
    return null;
  }
}

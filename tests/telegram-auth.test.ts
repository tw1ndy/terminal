import { describe, expect, it } from "vitest";
import { verifyTelegramWebApp } from "../src/telegram-auth";

const sampleToken = "5768337691:AAH5YkoiEuPk8-FZa32hStHTqXiLPtAEhx8";
const sampleInitData = "query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A279058397%2C%22first_name%22%3A%22Vladislav%22%2C%22last_name%22%3A%22Kibenko%22%2C%22username%22%3A%22vdkfrost%22%2C%22language_code%22%3A%22ru%22%2C%22is_premium%22%3Atrue%7D&auth_date=1662771648&hash=c501b71e775f74ce10e377dea85a7ea24ecd640b223ea86dfe453e0eaed2e2b2";

async function signInitData(data: string, token: string): Promise<string> {
  const params = new URLSearchParams(data);
  params.delete("hash");
  const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const checkString = entries.map(([key, value]) => `${key}=${value}`).join("\n");
  const encoder = new TextEncoder();
  const firstKey = await crypto.subtle.importKey(
    "raw", encoder.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const secret = await crypto.subtle.sign("HMAC", firstKey, encoder.encode(token));
  const secondKey = await crypto.subtle.importKey(
    "raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const digest = await crypto.subtle.sign("HMAC", secondKey, encoder.encode(checkString));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

describe("Telegram Mini App initData authentication", () => {
  it("accepts Telegram's published official HMAC test vector", async () => {
    await expect(verifyTelegramWebApp(sampleToken, sampleInitData, 1662771700))
      .resolves.toEqual({ id: "279058397", first_name: "Vladislav", username: "vdkfrost" });
  });

  it("includes the signature parameter in the bot HMAC check string", async () => {
    const params = new URLSearchParams(sampleInitData);
    params.delete("hash");
    params.set("signature", "telegram-ed25519-signature");
    const hash = await signInitData(params.toString(), sampleToken);
    params.set("hash", hash);
    await expect(verifyTelegramWebApp(sampleToken, params.toString(), 1662771700))
      .resolves.toMatchObject({ id: "279058397" });
    params.set("signature", "tampered");
    await expect(verifyTelegramWebApp(sampleToken, params.toString(), 1662771700))
      .resolves.toBeNull();
  });

  it("rejects expired, future-dated, duplicated and modified data", async () => {
    await expect(verifyTelegramWebApp(sampleToken, sampleInitData, 1662858100))
      .resolves.toBeNull();
    await expect(verifyTelegramWebApp(sampleToken, sampleInitData, 1662771500))
      .resolves.toBeNull();
    await expect(verifyTelegramWebApp(sampleToken, sampleInitData + "&auth_date=1662771648", 1662771700))
      .resolves.toBeNull();
    await expect(verifyTelegramWebApp(sampleToken, sampleInitData.replace("Vladislav", "Attacker"), 1662771700))
      .resolves.toBeNull();
  });

  it("rejects missing credentials and malformed payloads", async () => {
    await expect(verifyTelegramWebApp(undefined, sampleInitData, 1662771700)).resolves.toBeNull();
    await expect(verifyTelegramWebApp(sampleToken, "", 1662771700)).resolves.toBeNull();
    await expect(verifyTelegramWebApp(sampleToken, "hash=abc&auth_date=1662771648", 1662771700)).resolves.toBeNull();
  });
});

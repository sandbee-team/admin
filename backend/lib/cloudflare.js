// Cloudflare token verification: user-owned tokens and account-owned tokens
// verify at different endpoints, so the user form is tried first and the
// account form second (when an account id is known). Only status is returned.
import { ProviderError, request } from "./provider-http.js";

const ACCOUNT_RE = /^[a-f0-9]{32}$/;
const FALLBACK = new Set(["unauthorized", "forbidden", "not-found", "invalid"]);
export async function verifyToken(
  token,
  accountId = "",
  { fetch: fetchImpl, signal, sleep } = {},
) {
  if (accountId && !ACCOUNT_RE.test(accountId))
    throw new ProviderError("cloudflare", "invalid");
  const attempt = async (path) => {
    const { json } = await request({
      provider: "cloudflare",
      path,
      token,
      fetch: fetchImpl,
      signal,
      sleep,
    });
    return json?.success === true && json?.result?.status === "active";
  };
  try {
    if (await attempt("/user/tokens/verify")) return { ok: true, form: "user" };
  } catch (error) {
    if (!(error instanceof ProviderError && FALLBACK.has(error.code)))
      throw error;
  }
  if (!accountId) return { ok: false, form: null };
  try {
    return (await attempt(`/accounts/${accountId}/tokens/verify`))
      ? { ok: true, form: "account" }
      : { ok: false, form: null };
  } catch (error) {
    if (error instanceof ProviderError && FALLBACK.has(error.code))
      return { ok: false, form: null };
    throw error;
  }
}

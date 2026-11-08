export const KEY_PATTERN = /^[A-Za-z0-9._-]{16,256}$/;

export function connectionConfiguration(apiKey, apiUrl = "https://api.caelario.com", platform = process.platform) {
  if (!KEY_PATTERN.test(apiKey)) throw new Error("the Caelario API key format is invalid");
  const origin = new URL(apiUrl);
  if (!["http:", "https:"].includes(origin.protocol)) throw new Error("the Caelario API URL requires HTTP or HTTPS");
  if (/[&|<>^%!()\r\n]/.test(origin.origin)) throw new Error("the Caelario API origin contains unsafe launcher characters");
  if (origin.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) {
    throw new Error("the Caelario API URL must use HTTPS");
  }
  if (origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error("the Caelario API URL must contain only an origin");
  }
  return {
    command: platform === "win32" ? "cmd" : "npx",
    args: [...(platform === "win32" ? ["/c", "npx"] : []), "-y", "caelario-mcp", "serve"],
    env: { CAELARIO_API_URL: origin.origin, CAELARIO_API_KEY: apiKey },
  };
}

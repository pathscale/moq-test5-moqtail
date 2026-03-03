const T0 = performance.now();
const DEFAULT_RELAY = "http://hk.nofilter.io";

export function diagTime(): number {
  return Math.round(performance.now() - T0);
}

export function getCountryCode(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const region = new Intl.Locale(navigator.language).region;
    if (region) return region.toLowerCase();
    const continent = tz.split("/")[0]?.toLowerCase() ?? "xx";
    return continent.slice(0, 2);
  } catch {
    return "xx";
  }
}

export function getOrCreateStreamName(): string {
  const key = "moq-test-stream-name";
  const stored = localStorage.getItem(key);
  if (stored) return stored;
  const country = getCountryCode();
  const id = crypto.randomUUID().slice(0, 6);
  const name = `${country}-${id}`;
  localStorage.setItem(key, name);
  return name;
}

export function getOrCreateRelayUrl(): string {
  const key = "moq-relay-url";
  const stored = localStorage.getItem(key);
  if (stored) return stored;
  localStorage.setItem(key, DEFAULT_RELAY);
  return DEFAULT_RELAY;
}

export function normalizePath(path: string): string {
  return path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

export function joinUrl(base: string, path: string): string {
  const url = new URL(base);
  const basePath = url.pathname.replace(/\/+$/, "");
  const nextPath = normalizePath(path);
  url.pathname = nextPath ? `${basePath}/${nextPath}`.replace(/\/+/g, "/") : basePath || "/";
  return url.toString();
}

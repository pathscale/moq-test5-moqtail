const T0 = performance.now();

export type RelayOption = {
  name: string;
  url: string;
};

export const RELAY_OPTIONS: RelayOption[] = [
  {
    name: "moq-dev",
    url: "https://moqrelay2.sylvan-b.com/",
  },
  {
    name: "moxygen",
    url: "https://moxyrelay.sylvan-b.com/",
  },
  {
    name: "moqtail",
    url: "https://moqtail1.sylvan-b.com/",
  },
];

const DEFAULT_RELAY = RELAY_OPTIONS[0].url;

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
  if (stored && RELAY_OPTIONS.some((option) => option.url === stored)) {
    return stored;
  }
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

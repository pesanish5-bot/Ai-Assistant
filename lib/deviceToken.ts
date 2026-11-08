const STORAGE_KEY = "ultron.deviceToken";

export function readStoredDeviceToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.sessionStorage.getItem(STORAGE_KEY);
    return value && value.length >= 32 ? value : null;
  } catch {
    return null;
  }
}

export function storeDeviceToken(token: string): void {
  window.sessionStorage.setItem(STORAGE_KEY, token.trim());
}

export function clearStoredDeviceToken(): void {
  window.sessionStorage.removeItem(STORAGE_KEY);
}

export function deviceAuthHeaders(): HeadersInit {
  const token = readStoredDeviceToken();
  return token ? { "x-ultron-device-token": token, Authorization: `Bearer ${token}` } : {};
}

export function isLikelyRemoteHud(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return false;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const [a, b] = match.slice(1).map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

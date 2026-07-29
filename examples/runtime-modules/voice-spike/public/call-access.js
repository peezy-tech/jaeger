const CALL_TOKEN_STORAGE_KEY = "jaeger.voice.call-token";

export function loadAccessTokens({
  location = window.location,
  history = window.history,
  storage = window.sessionStorage,
} = {}) {
  const params = new URLSearchParams(location.hash.slice(1));
  const fragmentCallToken = params.get("call");
  const capabilityToken = params.get("capability");
  if (fragmentCallToken) rememberCallToken(fragmentCallToken, storage);
  const callToken = fragmentCallToken ?? readRememberedCallToken(storage);
  if (fragmentCallToken || capabilityToken) {
    history.replaceState(
      null,
      "",
      `${location.pathname}${location.search}`,
    );
  }
  return { callToken, capabilityToken };
}

export function rememberCallToken(token, storage = window.sessionStorage) {
  try {
    storage.setItem(CALL_TOKEN_STORAGE_KEY, token);
  } catch {
    // The original link can still restore access when storage is unavailable.
  }
}

export function forgetCallToken(storage = window.sessionStorage) {
  try {
    storage.removeItem(CALL_TOKEN_STORAGE_KEY);
  } catch {
    // Nothing else is required when storage is unavailable.
  }
}

function readRememberedCallToken(storage) {
  try {
    return storage.getItem(CALL_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

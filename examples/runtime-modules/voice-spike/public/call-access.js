export function loadAccessTokens({
  location = window.location,
  history = window.history,
} = {}) {
  const params = new URLSearchParams(location.hash.slice(1));
  const callToken = params.get("call");
  const capabilityToken = params.get("capability");
  if (callToken || capabilityToken) {
    history.replaceState(
      null,
      "",
      `${location.pathname}${location.search}`,
    );
  }
  return { callToken, capabilityToken };
}

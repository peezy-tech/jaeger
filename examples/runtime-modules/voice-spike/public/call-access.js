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

export async function answerInvitationWithRecovery(
  token,
  { answer, inspect, now = Date.now() },
) {
  try {
    return await answer(token);
  } catch (error) {
    let invitation;
    try {
      invitation = await inspect(token);
    } catch {
      throw error;
    }
    if (!hasActiveAnsweredAccess(invitation, now)) throw error;
    return invitation;
  }
}

export function hasActiveAnsweredAccess(invitation, now = Date.now()) {
  return (
    invitation?.status === "answered" &&
    Date.parse(invitation.accessExpiresAt) > now
  );
}

export function isCurrentRealtimeSession(
  params,
  { activeSessionId, startingSessionId },
) {
  if (!params?.sessionId) return true;
  return (
    params.sessionId === activeSessionId ||
    params.sessionId === startingSessionId
  );
}

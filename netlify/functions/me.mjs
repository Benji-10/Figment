import { requireUser, jsonError, HttpError } from "./_lib/auth.mjs";
import { getConversationForUser } from "./_lib/conversation.mjs";
import { syncCalendar, getActiveEvent, describeCurrentActivity } from "./_lib/calendar.mjs";

export default async (req, context) => {
  try {
    const user = await requireUser();

    const url = new URL(req.url);
    const conversationId = url.searchParams.get("conversationId");
    if (!conversationId) throw new HttpError(400, "conversationId is required.");

    const found = await getConversationForUser(user.id, conversationId);
    if (!found) throw new HttpError(404, "Conversation not found.");
    const { character, conversation } = found;

    await syncCalendar(character.id, character.timezone);
    const activeEvent = await getActiveEvent(character.id);

    return Response.json({
      user: { id: user.id, email: user.email },
      character: {
        id: character.id,
        name: character.name,
        avatarEmoji: character.avatar_emoji,
        tagline: character.tagline,
        currentActivity: describeCurrentActivity(character, activeEvent),
        currentMood: character.current_mood,
        busy: Boolean(activeEvent && activeEvent.availability < 50),
        statusUpdatedAt: character.status_updated_at,
      },
      conversationId: conversation.id,
      conversationState: conversation.state,
    });
  } catch (error) {
    return jsonError(error);
  }
};

export const config = {
  path: "/api/me",
  method: "GET",
};

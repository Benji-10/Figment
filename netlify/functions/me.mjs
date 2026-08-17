import { requireUser, jsonError } from "./_lib/auth.mjs";
import { getCharacter, ensureConversation } from "./_lib/conversation.mjs";

export default async (req, context) => {
  try {
    const user = await requireUser();
    const character = await getCharacter();
    const conversation = await ensureConversation(user.id, character.id);

    return Response.json({
      user: { id: user.id, email: user.email },
      character: {
        name: character.name,
        avatarEmoji: character.avatar_emoji,
        tagline: character.tagline,
        currentActivity: character.current_activity,
        currentMood: character.current_mood,
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

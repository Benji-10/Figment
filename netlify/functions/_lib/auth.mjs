import { getUser } from "@netlify/identity";
import { db } from "./db.mjs";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Verifies the request comes from a logged-in Identity user and makes
// sure we have a matching row in app_users (creating/refreshing it as
// needed). Every function that touches the chat calls this first.
export async function requireUser() {
  const identityUser = await getUser();
  if (!identityUser) {
    throw new HttpError(401, "You need to be logged in.");
  }

  const database = db();
  await database.sql`
    INSERT INTO app_users (id, email, display_name)
    VALUES (${identityUser.id}, ${identityUser.email}, ${identityUser.userMetadata?.full_name ?? null})
    ON CONFLICT (id) DO UPDATE
      SET email = EXCLUDED.email,
          last_seen_at = now()
  `;

  return identityUser;
}

export function jsonError(error) {
  const status = error instanceof HttpError ? error.status : 500;
  if (status === 500) {
    console.error(error);
  }
  return Response.json(
    { error: error.message || "Something went wrong." },
    { status }
  );
}

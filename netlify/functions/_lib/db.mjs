import { neon } from "@neondatabase/serverless";
import { SCHEMA_STATEMENTS } from "./schema.mjs";

let _sql;
let _ensurePromise = null;

function connectionString() {
  // DATABASE_URL is the standard name (what you get pasting a Neon
  // connection string into Netlify's env vars). NETLIFY_DATABASE_URL is
  // included too in case you *are* on a plan where Netlify's native
  // Database/Neon extension injects it.
  const url = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
  if (!url) {
    throw new Error(
      "No database connection string found. Set DATABASE_URL in your Netlify environment variables to a Neon Postgres connection string."
    );
  }
  return url;
}

// Reuses a single client per function instance instead of reconnecting on
// every call.
export function db() {
  if (!_sql) {
    _sql = neon(connectionString());
  }
  return { sql: _sql };
}

// Creates the schema on first use if it doesn't already exist, then
// remembers it's done for the lifetime of this warm function instance.
// Safe to call at the top of every handler — it's a no-op after the first
// successful run.
export async function ensureSchema() {
  if (!_ensurePromise) {
    const sql = db().sql;
    _ensurePromise = (async () => {
      for (const statement of SCHEMA_STATEMENTS) {
        await sql.query(statement.text, statement.params || []);
      }
    })().catch((err) => {
      _ensurePromise = null; // let the next call retry instead of caching a failure
      throw err;
    });
  }
  return _ensurePromise;
}

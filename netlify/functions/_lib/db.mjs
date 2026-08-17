import { getDatabase } from "@netlify/database";

let _db;

// Reuses a single client per function instance instead of reconnecting
// on every call.
export function db() {
  if (!_db) {
    _db = getDatabase();
  }
  return _db;
}

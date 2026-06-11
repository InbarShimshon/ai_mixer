// Durable storage for per-user sessions + saved sets.
// Uses Postgres when DATABASE_URL is set (Neon/Supabase/etc. — survives every
// deploy & restart), otherwise falls back to a local .users.json file (dev).
import fs from "fs";

const FILE = ".users.json";
const useDb = !!process.env.DATABASE_URL;
let pool = null;

export async function loadUsers() {
  if (useDb) {
    const pg = await import("pg");
    pool = new pg.default.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
    await pool.query("CREATE TABLE IF NOT EXISTS kv (key text PRIMARY KEY, value jsonb)");
    const r = await pool.query("SELECT value FROM kv WHERE key = 'users'");
    console.log("storage: Postgres (durable)");
    return r.rows[0]?.value || {};
  }
  console.log("storage: local file (not durable — set DATABASE_URL for durability)");
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; }
}

// Debounced write of the whole users object (small data; a few users).
let timer = null;
let pending = null;
export function saveUsers(users) {
  pending = users;
  if (timer) return;
  timer = setTimeout(flush, 1200);
}
async function flush() {
  timer = null;
  const users = pending;
  pending = null;
  if (!users) return;
  try {
    if (useDb && pool) {
      await pool.query(
        "INSERT INTO kv (key, value) VALUES ('users', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = $1::jsonb",
        [JSON.stringify(users)]
      );
    } else {
      fs.writeFileSync(FILE, JSON.stringify(users));
    }
  } catch (e) {
    console.error("storage save failed:", e.message);
  }
}

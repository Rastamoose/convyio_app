import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const dbUrl = process.env.SUPABASE_DB_URL;
const supabaseUrl = process.env.SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
if (!dbUrl || !supabaseUrl || !secretKey) {
  console.error("SUPABASE_DB_URL/SUPABASE_URL/SUPABASE_SECRET_KEY must be set in .env");
  process.exit(1);
}

const sql = postgres(dbUrl);
await sql`
  TRUNCATE TABLE
    attachments, message_reactions, messages, board_events, board_items,
    ref_counters, channels, actors, meta
  RESTART IDENTITY CASCADE
`;
await sql.end();
console.log("Wiped every table (a new server_id is generated on next server start).");

const supabase = createClient(supabaseUrl, secretKey);
const { data: files, error: listError } = await supabase.storage.from("attachments").list();
if (listError) throw listError;
if (files && files.length > 0) {
  const { error: removeError } = await supabase.storage.from("attachments").remove(files.map((f) => f.name));
  if (removeError) throw removeError;
}
console.log(`Wiped ${files?.length ?? 0} object(s) from the attachments bucket.`);

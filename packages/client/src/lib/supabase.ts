import { createClient } from "@supabase/supabase-js";

/**
 * The one browser Supabase client. Auth (Google OAuth + email/password)
 * flows through this; the server never sees Supabase credentials, only the
 * resulting access token as a Bearer header / WS join `authToken`.
 */
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
);

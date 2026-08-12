-- Enable RLS on every table, with no policies: deny-all through PostgREST.
--
-- This app never uses Supabase's Data API — the server talks to Postgres
-- directly via SUPABASE_DB_URL as the `postgres` role, which owns these
-- tables and is therefore not subject to RLS (no FORCE). Without this,
-- anyone holding the publishable key (it ships in the client bundle) could
-- read and write every table through /rest/v1/*, bypassing the server's
-- entire auth and board permission model.

alter table meta               enable row level security;
alter table actors             enable row level security;
alter table board_items        enable row level security;
alter table board_events       enable row level security;
alter table ref_counters       enable row level security;
alter table channels           enable row level security;
alter table messages           enable row level security;
alter table message_reactions  enable row level security;
alter table attachments        enable row level security;
alter table agent_invites      enable row level security;

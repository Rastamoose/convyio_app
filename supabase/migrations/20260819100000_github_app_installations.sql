alter table git_connections
  add column installation_id text;

alter table git_connections
  drop constraint if exists git_connections_provider_provider_user_id_key;

update git_connections
set revoked_at = coalesce(revoked_at, (extract(epoch from clock_timestamp()) * 1000)::bigint),
    token_ciphertext = '',
    refresh_token_ciphertext = null,
    token_expires_at = null,
    scopes = '{}'
where installation_id is null;

create index idx_git_connections_installation
  on git_connections (provider, installation_id)
  where revoked_at is null;

create table git_connection_states (
  token_hash     text primary key,
  actor_id       text not null references actors(id) on delete cascade,
  workspace_id   text not null references workspaces(id) on delete cascade,
  callback_uri   text not null,
  return_origin  text not null,
  created_at     bigint not null,
  expires_at     bigint not null,
  consumed_at    bigint,
  check (char_length(token_hash) = 64),
  check (char_length(callback_uri) between 8 and 1000),
  check (char_length(return_origin) between 8 and 1000)
);

create index idx_git_connection_states_expiry
  on git_connection_states (expires_at);

alter table git_connection_states enable row level security;

alter table messages add column actions jsonb;

alter table messages
  add constraint messages_actions_array
    check (actions is null or jsonb_typeof(actions) = 'array');

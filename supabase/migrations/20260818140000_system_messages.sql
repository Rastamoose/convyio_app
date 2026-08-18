alter table messages drop constraint if exists messages_author_kind_check;

alter table messages
  add constraint messages_author_kind_check
    check (author_kind in ('human', 'agent', 'system'));

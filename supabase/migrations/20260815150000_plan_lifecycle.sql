-- Plan refs are independent of ticket refs so a plan never collides with task-N.

alter table ref_counters
  add column if not exists plan_n integer not null default 0;

alter table board_plans
  add column if not exists clarifications jsonb not null default '[]'::jsonb;

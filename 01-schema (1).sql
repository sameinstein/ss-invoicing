-- =====================================================================
-- S&S Shop invoicing app  |  STAGE 1 of 2: database structure
-- Run this ONCE in Supabase: SQL Editor -> New query -> paste -> Run.
-- Then run 02-seed-imported-data.sql.
-- Safe to re-run: everything uses "if not exists" / "or replace".
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helper: keep updated_at fresh
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------
-- Business profile (exactly one row)
-- ---------------------------------------------------------------------
create table if not exists public.business_profile (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null,
  tagline                text,
  address                text,
  phone                  text,
  email                  text,
  tin                    text,                       -- optional tax number printed on invoices
  logo_data              text,                       -- data: URL of the logo image
  currency               text not null default 'UGX',
  vat_rate               numeric(5,2) not null default 18,
  invoice_prefix         text not null default 'S&S-IN-',
  next_invoice_number    integer not null default 1,
  number_padding         integer not null default 4,
  default_due_days       integer not null default 30,
  payment_instructions   text,
  invoice_footer         text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- Only one profile row is ever allowed
create unique index if not exists business_profile_single_row
  on public.business_profile ((true));

drop trigger if exists trg_business_profile_updated on public.business_profile;
create trigger trg_business_profile_updated before update on public.business_profile
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Clients
-- ---------------------------------------------------------------------
create table if not exists public.clients (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  phone              text,
  phone_normalized   text,                            -- digits/+ only, used for matching & WhatsApp
  email              text,
  address            text,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists clients_name_idx  on public.clients (lower(name));
create index if not exists clients_phone_idx on public.clients (phone_normalized);

drop trigger if exists trg_clients_updated on public.clients;
create trigger trg_clients_updated before update on public.clients
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Saved items / services
-- ---------------------------------------------------------------------
create table if not exists public.items (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  description   text,
  unit_price    numeric(14,2) not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

drop trigger if exists trg_items_updated on public.items;
create trigger trg_items_updated before update on public.items
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Invoices
--   client_name / client_phone / client_email are a snapshot of what was
--   on the invoice, so later edits to a client never rewrite old invoices.
-- ---------------------------------------------------------------------
create table if not exists public.invoices (
  id             uuid primary key default gen_random_uuid(),
  number         text not null unique,
  client_id      uuid references public.clients(id) on delete set null,
  client_name    text not null,
  client_phone   text,
  client_email   text,
  client_address text,
  issue_date     date not null default current_date,
  due_date       date,
  subtotal       numeric(14,2) not null default 0,
  discount       numeric(14,2) not null default 0,
  vat_applied    boolean not null default false,
  vat_rate       numeric(5,2) not null default 18,
  vat_amount     numeric(14,2) not null default 0,
  total          numeric(14,2) not null default 0,
  notes          text,
  terms          text,
  po_number      text,
  is_draft       boolean not null default false,
  is_void        boolean not null default false,
  is_imported    boolean not null default false,      -- came from Invoice Simple
  is_locked      boolean not null default false,      -- content can never be edited/deleted
  source_ref     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint invoices_amounts_chk check (subtotal >= 0 and discount >= 0 and vat_amount >= 0 and total >= 0)
);
create index if not exists invoices_client_idx on public.invoices (client_id);
create index if not exists invoices_issue_idx  on public.invoices (issue_date desc);

drop trigger if exists trg_invoices_updated on public.invoices;
create trigger trg_invoices_updated before update on public.invoices
  for each row execute function public.set_updated_at();

-- Line items (imported summary-only invoices have none)
create table if not exists public.invoice_lines (
  id           uuid primary key default gen_random_uuid(),
  invoice_id   uuid not null references public.invoices(id) on delete cascade,
  position     integer not null default 0,
  item_id      uuid references public.items(id) on delete set null,
  description  text not null,
  quantity     numeric(12,3) not null default 1,
  unit_price   numeric(14,2) not null default 0,
  amount       numeric(14,2) not null default 0
);
create index if not exists invoice_lines_invoice_idx on public.invoice_lines (invoice_id, position);

-- ---------------------------------------------------------------------
-- Payments received against invoices
-- ---------------------------------------------------------------------
create table if not exists public.payments (
  id           uuid primary key default gen_random_uuid(),
  invoice_id   uuid not null references public.invoices(id) on delete cascade,
  amount       numeric(14,2) not null check (amount > 0),
  paid_on      date not null default current_date,
  method       text not null default 'cash'
               check (method in ('cash','bank','card','mobile_money','cheque','other')),
  reference    text,
  notes        text,
  is_imported  boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists payments_invoice_idx on public.payments (invoice_id);
create index if not exists payments_date_idx    on public.payments (paid_on desc);

-- ---------------------------------------------------------------------
-- Expenses
-- ---------------------------------------------------------------------
create table if not exists public.expense_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  sort_order  integer not null default 0,
  is_active   boolean not null default true
);

create table if not exists public.expenses (
  id              uuid primary key default gen_random_uuid(),
  spent_on        date not null default current_date,
  amount          numeric(14,2) not null check (amount > 0),
  category_id     uuid references public.expense_categories(id) on delete set null,
  supplier        text,
  description     text,
  payment_method  text not null default 'cash'
                  check (payment_method in ('cash','bank','card','mobile_money','cheque','other')),
  vat_amount      numeric(14,2) not null default 0,
  receipt_path    text,                               -- file path inside the private 'receipts' bucket
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists expenses_date_idx     on public.expenses (spent_on desc);
create index if not exists expenses_category_idx on public.expenses (category_id);

drop trigger if exists trg_expenses_updated on public.expenses;
create trigger trg_expenses_updated before update on public.expenses
  for each row execute function public.set_updated_at();

-- Default expense categories (editable later in the app)
insert into public.expense_categories (name, sort_order) values
  ('Stock / Purchases', 1),
  ('Rent', 2),
  ('Transport', 3),
  ('Utilities', 4),
  ('Airtime & Data', 5),
  ('Salaries & Wages', 6),
  ('Repairs & Maintenance', 7),
  ('Packaging & Supplies', 8),
  ('Marketing', 9),
  ('Taxes & Licences', 10),
  ('Miscellaneous', 99)
on conflict (name) do nothing;

-- ---------------------------------------------------------------------
-- PROTECTION: imported / locked invoices can never be changed or deleted,
-- and imported payments can never be changed or deleted.
-- (New payments can still be added to an imported invoice.)
-- ---------------------------------------------------------------------
create or replace function public.protect_locked_invoices() returns trigger
language plpgsql as $$
begin
  if old.is_locked then
    raise exception 'Invoice % is an imported record and is locked. It cannot be edited or deleted.', old.number
      using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

drop trigger if exists trg_protect_invoices on public.invoices;
create trigger trg_protect_invoices before update or delete on public.invoices
  for each row execute function public.protect_locked_invoices();

create or replace function public.protect_imported_payments() returns trigger
language plpgsql as $$
begin
  if old.is_imported then
    raise exception 'This payment was imported from Invoice Simple and cannot be edited or deleted.'
      using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

drop trigger if exists trg_protect_payments on public.payments;
create trigger trg_protect_payments before update or delete on public.payments
  for each row execute function public.protect_imported_payments();

-- Line items of a locked invoice are also protected
create or replace function public.protect_locked_lines() returns trigger
language plpgsql as $$
declare locked boolean;
begin
  select is_locked into locked from public.invoices
   where id = coalesce(new.invoice_id, old.invoice_id);
  if coalesce(locked, false) then
    raise exception 'Line items of a locked invoice cannot be changed.' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

drop trigger if exists trg_protect_lines on public.invoice_lines;
create trigger trg_protect_lines before insert or update or delete on public.invoice_lines
  for each row execute function public.protect_locked_lines();

-- ---------------------------------------------------------------------
-- Invoice numbering: hands out S&S-IN-0001, S&S-IN-0002, ... atomically
-- ---------------------------------------------------------------------
create or replace function public.take_next_invoice_number() returns text
language plpgsql as $$
declare p text; n integer; pad integer;
begin
  update public.business_profile
     set next_invoice_number = next_invoice_number + 1
   returning invoice_prefix, next_invoice_number - 1, number_padding
        into p, n, pad;
  if p is null then
    raise exception 'Business profile has not been set up yet.';
  end if;
  return p || lpad(n::text, pad, '0');
end $$;

-- ---------------------------------------------------------------------
-- Views (they respect the same security rules as the tables)
-- ---------------------------------------------------------------------
-- Every invoice with amount paid, balance due and a computed status
create or replace view public.invoice_summary
with (security_invoker = true) as
select
  i.*,
  coalesce(p.paid, 0)                              as paid,
  greatest(i.total - coalesce(p.paid, 0), 0)       as balance_due,
  p.last_paid_on                                   as last_paid_on,
  case
    when i.is_void                                                          then 'void'
    when i.is_draft                                                         then 'draft'
    when i.total > 0 and coalesce(p.paid, 0) >= i.total                     then 'paid'
    when i.due_date is not null and i.due_date < current_date               then 'overdue'
    when coalesce(p.paid, 0) > 0                                            then 'partial'
    else 'unpaid'
  end                                              as status
from public.invoices i
left join (
  select invoice_id, sum(amount) as paid, max(paid_on) as last_paid_on
    from public.payments
   group by invoice_id
) p on p.invoice_id = i.id;

-- Clients that share a phone number under different names (review, then merge in the app if you wish)
create or replace view public.possible_duplicate_clients
with (security_invoker = true) as
select c.phone_normalized,
       count(*)                       as records,
       array_agg(c.name order by c.name) as names,
       array_agg(c.id)                as client_ids
  from public.clients c
 where coalesce(c.phone_normalized, '') <> ''
 group by c.phone_normalized
having count(*) > 1;

-- ---------------------------------------------------------------------
-- SECURITY: only signed-in users may touch data. The public (anon) key
-- can read nothing. IMPORTANT: after creating your login, turn OFF
-- "Allow new users to sign up" in Supabase (Authentication settings)
-- so nobody else can ever create an account.
-- ---------------------------------------------------------------------
alter table public.business_profile   enable row level security;
alter table public.clients            enable row level security;
alter table public.items              enable row level security;
alter table public.invoices           enable row level security;
alter table public.invoice_lines      enable row level security;
alter table public.payments           enable row level security;
alter table public.expense_categories enable row level security;
alter table public.expenses           enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'business_profile','clients','items','invoices','invoice_lines',
    'payments','expense_categories','expenses'
  ] loop
    execute format('drop policy if exists "signed_in_full_access" on public.%I', t);
    execute format(
      'create policy "signed_in_full_access" on public.%I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- Views and functions are used by signed-in users only
revoke all on public.invoice_summary          from anon;
revoke all on public.possible_duplicate_clients from anon;
grant select on public.invoice_summary          to authenticated;
grant select on public.possible_duplicate_clients to authenticated;
revoke execute on function public.take_next_invoice_number() from anon, public;
grant  execute on function public.take_next_invoice_number() to authenticated;

-- ---------------------------------------------------------------------
-- KEEP-ALIVE: a tiny public function that does a real database query.
-- The GitHub Actions job calls it every few days so Supabase never
-- pauses the project for inactivity. It exposes nothing but the time.
-- ---------------------------------------------------------------------
create or replace function public.ping() returns timestamptz
language sql security definer set search_path = public as $$
  select now();
$$;
grant execute on function public.ping() to anon, authenticated;

-- ---------------------------------------------------------------------
-- Private storage bucket for receipt photos
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

drop policy if exists "receipts_signed_in_all" on storage.objects;
create policy "receipts_signed_in_all" on storage.objects
  for all to authenticated
  using (bucket_id = 'receipts')
  with check (bucket_id = 'receipts');

-- Done. Now run 02-seed-imported-data.sql

-- =====================================================================
-- S&S Shop invoicing app  |  Fix: "UPDATE requires a WHERE clause"
-- Run this ONCE in Supabase: SQL Editor -> New query -> paste -> Run.
-- Safe to re-run ("create or replace"). Touches no data, only replaces
-- the invoice-numbering function with one that has an explicit WHERE.
-- =====================================================================

create or replace function public.take_next_invoice_number() returns text
language plpgsql as $$
declare p text; n integer; pad integer;
begin
  update public.business_profile
     set next_invoice_number = next_invoice_number + 1
   where id = (select id from public.business_profile limit 1)
  returning invoice_prefix, next_invoice_number - 1, number_padding
       into p, n, pad;
  if p is null then
    raise exception 'Business profile has not been set up yet.';
  end if;
  return p || lpad(n::text, pad, '0');
end $$;

-- Done. Creating a new invoice should work now — no app files need to change.

-- =====================================================================
-- S&S Shop invoicing app  |  Migration: product photos on saved items
-- Run this ONCE in Supabase: SQL Editor -> New query -> paste -> Run.
-- Safe to re-run: everything uses "if not exists" / "on conflict do nothing".
-- Does not touch or alter any existing invoice/payment/client data.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. New column: where the item's photo lives inside the private
--    'item-photos' storage bucket (nothing is stored in the database
--    itself — just the file path, so the database stays tiny).
-- ---------------------------------------------------------------------
alter table public.items
  add column if not exists photo_path text;

-- ---------------------------------------------------------------------
-- 2. Private storage bucket for product photos (same pattern as the
--    existing 'receipts' bucket). Private + signed URLs, so photos are
--    never publicly guessable even though the bucket holds no secrets.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('item-photos', 'item-photos', false)
on conflict (id) do nothing;

drop policy if exists "item_photos_signed_in_all" on storage.objects;
create policy "item_photos_signed_in_all" on storage.objects
  for all to authenticated
  using (bucket_id = 'item-photos')
  with check (bucket_id = 'item-photos');

-- Done. No app restart needed on the database side — just upload the
-- updated app.css / app.js / index.html files from this round.

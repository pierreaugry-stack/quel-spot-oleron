-- Quel spot à Oléron ? — base des reviews de sessions
-- À coller une seule fois dans Supabase : menu « SQL Editor » → « New query » → coller → « Run ».
-- AVANT de lancer : remplace CHANGE-MOI (ligne « insert into private.settings ») par le code
-- que tu donneras à tes potes pour pouvoir publier une review.

-- 1. Les reviews (lecture publique, écriture uniquement par la fonction submit_review)
create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  spot text not null check (char_length(spot) <= 40),
  session_at timestamptz not null,
  rating smallint not null check (rating between 0 and 10),
  author text check (char_length(author) <= 40),
  description text check (char_length(description) <= 3000),
  photos text[] not null default '{}',
  conditions jsonb
);
alter table public.reviews enable row level security;
grant usage on schema public to anon, authenticated;
grant select on public.reviews to anon, authenticated;
drop policy if exists "reviews lisibles par tous" on public.reviews;
create policy "reviews lisibles par tous" on public.reviews for select to anon, authenticated using (true);

-- 2. Le code de publication (jamais lisible depuis le site)
create schema if not exists private;
create table if not exists private.settings (key text primary key, value text not null);
insert into private.settings (key, value) values ('code', 'CHANGE-MOI')
  on conflict (key) do update set value = excluded.value;

-- 3. Publication d'une review : vérifie le code puis enregistre
create or replace function public.submit_review(
  p_code text, p_spot text, p_session_at timestamptz, p_rating int,
  p_author text, p_description text, p_photos text[], p_conditions jsonb
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare new_id uuid;
begin
  if not exists (select 1 from private.settings where key = 'code' and value = p_code) then
    raise exception 'code invalide' using errcode = '28000';
  end if;
  if p_session_at > now() + interval '1 hour' or p_session_at < now() - interval '120 days' then
    raise exception 'date de session invalide';
  end if;
  insert into public.reviews (spot, session_at, rating, author, description, photos, conditions)
  values (p_spot, p_session_at, p_rating, left(p_author, 40), left(p_description, 3000),
          coalesce(p_photos[1:6], '{}'), p_conditions)
  returning id into new_id;
  return new_id;
end $$;
revoke all on function public.submit_review from public;
grant execute on function public.submit_review to anon, authenticated;

-- 4. Les photos : dossier public « photos », images de 5 Mo maximum
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 5242880, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists "envoi de photos" on storage.objects;
create policy "envoi de photos" on storage.objects for insert to anon, authenticated with check (bucket_id = 'photos');

-- Pour supprimer une review : menu « Table Editor » → reviews → clic droit sur la ligne → Delete.
-- Pour changer le code : update private.settings set value = 'nouveau-code' where key = 'code';

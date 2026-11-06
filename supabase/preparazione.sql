-- =====================================================================
--  SOPRALLUOGHI PERITI - preparazione del database su Supabase
--  Si incolla tutto nel SQL Editor di Supabase e si preme "Run".
--  Si può rilanciare senza problemi: non cancella i dati già presenti.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. PROFILI DEI PERITI
--    Una riga per ogni perito: i suoi elenchi personalizzati e
--    l'eventuale obbligo di cambiare la password al prossimo accesso
--    (per metterlo a un perito: deve_cambiare_password = true).
-- ---------------------------------------------------------------------
create table if not exists public.profili (
  id uuid primary key references auth.users(id) on delete cascade,
  elenchi jsonb,
  deve_cambiare_password boolean not null default false,
  creato timestamptz not null default now()
);

alter table public.profili enable row level security;

drop policy if exists "profilo: leggo il mio" on public.profili;
create policy "profilo: leggo il mio" on public.profili
  for select to authenticated
  using (id = (select auth.uid()));

drop policy if exists "profilo: modifico il mio" on public.profili;
create policy "profilo: modifico il mio" on public.profili
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

grant select, update on public.profili to authenticated;

-- Quando si crea un nuovo perito, gli si crea da solo il profilo
create or replace function public.nuovo_perito()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profili (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke execute on function public.nuovo_perito() from public, anon, authenticated;

drop trigger if exists al_nuovo_perito on auth.users;
create trigger al_nuovo_perito
  after insert on auth.users
  for each row execute function public.nuovo_perito();

-- Profilo anche per i periti creati prima di questo script
insert into public.profili (id)
select id from auth.users
on conflict (id) do nothing;


-- ---------------------------------------------------------------------
-- 2. PRATICHE
--    Ogni perito vede, modifica e cancella solo le sue.
-- ---------------------------------------------------------------------
create table if not exists public.pratiche (
  id uuid primary key,
  perito uuid not null default auth.uid() references auth.users(id) on delete cascade,
  num text,
  richiedente text,
  aggiornata timestamptz not null default now(),
  dati jsonb not null default '{}'::jsonb
);

create index if not exists pratiche_perito on public.pratiche (perito);

alter table public.pratiche enable row level security;

drop policy if exists "pratiche: leggo le mie" on public.pratiche;
create policy "pratiche: leggo le mie" on public.pratiche
  for select to authenticated
  using (perito = (select auth.uid()));

drop policy if exists "pratiche: creo le mie" on public.pratiche;
create policy "pratiche: creo le mie" on public.pratiche
  for insert to authenticated
  with check (perito = (select auth.uid()));

drop policy if exists "pratiche: modifico le mie" on public.pratiche;
create policy "pratiche: modifico le mie" on public.pratiche
  for update to authenticated
  using (perito = (select auth.uid()))
  with check (perito = (select auth.uid()));

drop policy if exists "pratiche: cancello le mie" on public.pratiche;
create policy "pratiche: cancello le mie" on public.pratiche
  for delete to authenticated
  using (perito = (select auth.uid()));

grant select, insert, update, delete on public.pratiche to authenticated;


-- ---------------------------------------------------------------------
-- 3. FOTO (l'elenco; i file veri stanno nell'archivio, punto 4)
-- ---------------------------------------------------------------------
create table if not exists public.foto (
  id uuid primary key,
  pratica uuid not null references public.pratiche(id) on delete cascade,
  perito uuid not null default auth.uid() references auth.users(id) on delete cascade,
  quando timestamptz,
  byte integer
);

create index if not exists foto_pratica on public.foto (pratica);
create index if not exists foto_perito on public.foto (perito);

alter table public.foto enable row level security;

drop policy if exists "foto: leggo le mie" on public.foto;
create policy "foto: leggo le mie" on public.foto
  for select to authenticated
  using (perito = (select auth.uid()));

drop policy if exists "foto: creo le mie" on public.foto;
create policy "foto: creo le mie" on public.foto
  for insert to authenticated
  with check (perito = (select auth.uid()));

drop policy if exists "foto: modifico le mie" on public.foto;
create policy "foto: modifico le mie" on public.foto
  for update to authenticated
  using (perito = (select auth.uid()))
  with check (perito = (select auth.uid()));

drop policy if exists "foto: cancello le mie" on public.foto;
create policy "foto: cancello le mie" on public.foto
  for delete to authenticated
  using (perito = (select auth.uid()));

grant select, insert, update, delete on public.foto to authenticated;


-- ---------------------------------------------------------------------
-- 4. ARCHIVIO FILE (foto ridotte e schede PDF)
--    Privato. Ogni perito ha la sua cartella, che ha per nome il suo
--    codice utente, e può toccare solo quella.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sopralluoghi', 'sopralluoghi', false, 10485760, array['image/jpeg', 'application/pdf'])
on conflict (id) do nothing;

drop policy if exists "archivio: leggo i miei file" on storage.objects;
create policy "archivio: leggo i miei file" on storage.objects
  for select to authenticated
  using (bucket_id = 'sopralluoghi' and (storage.foldername(name))[1] = (select auth.uid()::text));

drop policy if exists "archivio: carico i miei file" on storage.objects;
create policy "archivio: carico i miei file" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'sopralluoghi' and (storage.foldername(name))[1] = (select auth.uid()::text));

drop policy if exists "archivio: sostituisco i miei file" on storage.objects;
create policy "archivio: sostituisco i miei file" on storage.objects
  for update to authenticated
  using (bucket_id = 'sopralluoghi' and (storage.foldername(name))[1] = (select auth.uid()::text))
  with check (bucket_id = 'sopralluoghi' and (storage.foldername(name))[1] = (select auth.uid()::text));

drop policy if exists "archivio: cancello i miei file" on storage.objects;
create policy "archivio: cancello i miei file" on storage.objects
  for delete to authenticated
  using (bucket_id = 'sopralluoghi' and (storage.foldername(name))[1] = (select auth.uid()::text));


-- ---------------------------------------------------------------------
-- 5. SPAZIO USATO DA TUTTO LO STUDIO
--    Restituisce solo il totale in byte: nessuno vede i file degli altri.
-- ---------------------------------------------------------------------
create or replace function public.spazio_studio()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum((metadata->>'size')::bigint), 0)::bigint
  from storage.objects
  where bucket_id = 'sopralluoghi';
$$;

revoke execute on function public.spazio_studio() from public, anon;
grant execute on function public.spazio_studio() to authenticated;


-- Fine. Se in basso compare "Success. No rows returned", è tutto a posto.

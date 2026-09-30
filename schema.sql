-- Smart Waste Management System — Supabase schema

create table profiles (
  id uuid primary key references auth.users on delete cascade,
  full_name text,
  role text not null default 'citizen' check (role in ('citizen','admin')),
  created_at timestamptz default now()
);

create table complaints (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id),
  description text,
  photo_url text not null,
  lat double precision not null,
  lng double precision not null,
  category text,            -- overflowing_bin | roadside_garbage | missed_collection | illegal_dumping | other
  severity text,            -- low | medium | high | critical
  auto_response text,
  zone text,
  status text not null default 'open'
    check (status in ('open','routed','in_progress','resolved','needs_review')),
  duplicate_of uuid references complaints(id),
  upvotes int not null default 0,
  resolution_photo_url text,
  verification text,        -- resolved | not_resolved | uncertain
  created_at timestamptz default now(),
  resolved_at timestamptz
);
create index on complaints (status, created_at desc);
create index on complaints (lat, lng);

create table pickup_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id),
  waste_type text not null,
  address text not null,
  preferred_date date not null,
  status text not null default 'pending' check (status in ('pending','scheduled','done')),
  created_at timestamptz default now()
);

-- Auto-create profile on signup
create function handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, full_name) values (new.id, new.raw_user_meta_data->>'full_name');
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

create function is_admin() returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

-- Duplicate detection: same category, within radius_m metres, open, last 7 days (haversine)
create function find_duplicate(p_id uuid, p_lat float, p_lng float, p_cat text, radius_m int default 50)
returns uuid language sql stable as $$
  select c.id from complaints c
  where c.id <> p_id and c.category = p_cat
    and c.status in ('open','routed','in_progress') and c.duplicate_of is null
    and c.created_at > now() - interval '7 days'
    and 6371000 * 2 * asin(sqrt(
        power(sin(radians(c.lat - p_lat) / 2), 2) +
        cos(radians(p_lat)) * cos(radians(c.lat)) * power(sin(radians(c.lng - p_lng) / 2), 2)
    )) <= radius_m
  order by c.created_at limit 1;
$$;

-- Admin status update (called from dashboard)
create function set_status(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'admin only'; end if;
  update complaints set status = p_status,
    resolved_at = case when p_status = 'resolved' then now() else resolved_at end
  where id = p_id;
end $$;

-- RLS
alter table profiles enable row level security;
alter table complaints enable row level security;
alter table pickup_requests enable row level security;

create policy "own profile" on profiles for select using (id = auth.uid() or is_admin());
create policy "read own or admin" on complaints for select using (user_id = auth.uid() or is_admin());
create policy "insert own" on complaints for insert with check (user_id = auth.uid());
create policy "own pickups" on pickup_requests for select using (user_id = auth.uid() or is_admin());
create policy "insert own pickup" on pickup_requests for insert with check (user_id = auth.uid());
create policy "admin update pickup" on pickup_requests for update using (is_admin());

-- Storage: public bucket for complaint photos
insert into storage.buckets (id, name, public) values ('complaint-photos', 'complaint-photos', true);
create policy "upload own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'complaint-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "admin upload proof" on storage.objects for insert to authenticated
  with check (bucket_id = 'complaint-photos' and (storage.foldername(name))[1] = 'proof' and is_admin());
create policy "public read" on storage.objects for select using (bucket_id = 'complaint-photos');

-- Sign up karne ke baad khud ko admin banao:
-- update profiles set role = 'admin' where id = (select id from auth.users where email = 'you@example.com');
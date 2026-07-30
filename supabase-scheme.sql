-- Выполнить один раз в Supabase SQL Editor (новый, отдельный проект)

create table admins (
  chat_id bigint primary key,
  username text,
  created_at timestamptz default now()
);

create table questions (
  id serial primary key,
  question_text text not null,
  options jsonb not null,       -- массив строк, напр. ["Вариант 1","Вариант 2","Вариант 3","Вариант 4"]
  correct_index int not null,   -- 0 = A, 1 = B, 2 = C, 3 = D
  active boolean default true,
  created_at timestamptz default now()
);

create table sessions (
  chat_id bigint primary key,
  state text not null default 'idle',
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);

create table attempts (
  id serial primary key,
  chat_id bigint,
  full_name text,
  phone text,
  score int,
  total int,
  created_at timestamptz default now()
);

-- RLS не включаем: доступ идёт только с сервера через service_role ключ,
-- который никогда не попадает в браузер.

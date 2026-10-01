-- =====================================================================
--  LES OBJETS
--  À coller dans Supabase > SQL Editor > Run. Idempotent.
--
--  Un objet se LOOTE en gagnant une partie en duo avec un coéquipier.
--  Tant qu'on n'en a jamais obtenu un, on ne voit qu'une description
--  mystérieuse ; une fois découvert, l'effet réel reste visible.
--
--  Le catalogue vit en base : tu peux retoucher noms, textes et raretés
--  depuis le SQL Editor sans toucher au site ni à la fonction.
-- =====================================================================

create table if not exists public.items (
  key     text primary key,
  name    text not null,
  icon    text not null default '❔',
  rarity  text not null default 'commun',
  target  text not null default 'adversaire',
  teaser  text not null,   -- visible par tous : évocateur, jamais précis
  effect  text not null,   -- visible seulement quand on l'a découvert
  active  boolean not null default true,
  sort    int not null default 0
);

do $$ begin
  alter table public.items add constraint items_rarity_valid check (rarity in ('commun','rare','legendaire'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.items add constraint items_target_valid check (target in ('soi','adversaire'));
exception when duplicate_object then null; end $$;

-- L'inventaire. Une ligne = un exemplaire.
create table if not exists public.player_items (
  id          uuid primary key default gen_random_uuid(),
  player_id   text not null references public.players(id) on delete cascade,
  item_key    text not null references public.items(key) on delete cascade,
  obtained_at timestamptz not null default now(),
  source_match text,                                        -- la partie qui l'a fait tomber
  used_at     timestamptz,
  target_id   text references public.players(id) on delete set null
);
create index if not exists player_items_player_idx on public.player_items (player_id, used_at);
-- Un butin par partie : garantit qu'un relevé rejoué ne duplique rien.
create unique index if not exists player_items_source_key
  on public.player_items (player_id, source_match) where source_match is not null;


-- ---------------------------------------------------------------------
--  Lecture publique, écriture réservée au serveur
-- ---------------------------------------------------------------------
alter table public.items        enable row level security;
alter table public.player_items enable row level security;

drop policy if exists items_read on public.items;
create policy items_read on public.items for select to anon, authenticated using (true);

drop policy if exists player_items_read on public.player_items;
create policy player_items_read on public.player_items for select to anon, authenticated using (true);

-- Aucune policy d'écriture : seule la fonction « riot » (clé serveur) distribue.

do $$ begin
  begin execute 'alter publication supabase_realtime add table public.player_items'; exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table public.items';        exception when duplicate_object then null; end;
end $$;


-- ---------------------------------------------------------------------
--  Le catalogue
--  `teaser` doit donner envie sans rien révéler de chiffré.
-- ---------------------------------------------------------------------
insert into public.items (key, name, icon, rarity, target, teaser, effect, sort) values

  -- ---- bonus, pour soi ----
  ('pierre_garde', 'Pierre de Garde', '🪨', 'commun', 'soi',
   'Une pierre terne, qui semble absorber les mauvaises nouvelles.',
   'Ta prochaine défaite ne te coûte aucun LP.', 1),

  ('bottes_celerite', 'Bottes de Célérité', '👟', 'commun', 'soi',
   'Elles récompensent ceux qui ne traînent pas en chemin.',
   'Si ta prochaine victoire dure moins de 25 minutes : +20 LP.', 2),

  ('larme_deesse', 'Larme de la Déesse', '💧', 'commun', 'soi',
   'Son pouvoir est modeste, mais il dure.',
   '+3 LP sur chacune de tes 5 prochaines parties.', 3),

  ('elixir_rage', 'Élixir de Rage', '🔥', 'rare', 'soi',
   'On raconte qu''il décuple tout ce que l''on arrache.',
   'Ta prochaine victoire rapporte le double de LP.', 4),

  ('ange_gardien', 'Ange Gardien', '😇', 'rare', 'soi',
   'Il veille en silence, et n''interviendra qu''une seule fois.',
   'La prochaine fois que tu perds deux parties d''affilée, la seconde est annulée.', 5),

  ('baron_nashor', 'Baron Nashor', '🐍', 'legendaire', 'soi',
   'Ce que tu gagnes, tous les tiens le ressentent.',
   'Ta prochaine victoire rapporte +15 LP supplémentaires à ton équipe.', 6),

  -- ---- malus, à lancer sur un adversaire ----
  ('marque_chasseur', 'Marque du Chasseur', '🏹', 'commun', 'adversaire',
   'Chez elle, mourir finira par coûter cher.',
   'Si ta cible meurt 5 fois ou plus dans sa prochaine partie : −20 LP.', 10),

  ('isolement', 'Isolement', '🚪', 'commun', 'adversaire',
   'Elle jouera seule, qu''elle le veuille ou non.',
   'Sa prochaine partie doit être en solo. Jouée en duo, elle ne compte pas.', 11),

  ('brouillard', 'Brouillard de Guerre', '🕯️', 'commun', 'adversaire',
   'Il faudra qu''elle y voie clair.',
   'Si son score de vision est inférieur à 15 : −15 LP.', 12),

  ('poids_monde', 'Poids du Monde', '🏔️', 'rare', 'adversaire',
   'Ses victoires auront un goût d''inachevé.',
   'Sa prochaine victoire ne lui rapporte que la moitié des LP.', 13),

  ('peage', 'Péage', '💰', 'rare', 'adversaire',
   'Une part de son butin changera discrètement de camp.',
   'Les 20 premiers LP qu''elle gagne partent dans ton équipe.', 14),

  ('malediction_nexus', 'Malédiction du Nexus', '💀', 'rare', 'adversaire',
   'La chute n''en sera que plus rude.',
   'Sa prochaine défaite lui coûte le double.', 15),

  ('amnesie', 'Amnésie', '🌀', 'legendaire', 'adversaire',
   'Elle devra sortir de ses habitudes.',
   'Sa prochaine partie doit se jouer sur un champion jamais joué depuis le début du challenge, sinon −25 LP.', 16),

  ('pile_ou_face', 'Pile ou Face', '🎲', 'legendaire', 'adversaire',
   'Tout peut basculer. Dans les deux sens.',
   'Sa prochaine partie : +30 LP si elle gagne, −30 si elle perd, en plus du résultat normal.', 17)

on conflict (key) do update set
  name = excluded.name, icon = excluded.icon, rarity = excluded.rarity,
  target = excluded.target, teaser = excluded.teaser, effect = excluded.effect,
  sort = excluded.sort;

select rarity, target, count(*) from public.items group by rarity, target order by rarity, target;

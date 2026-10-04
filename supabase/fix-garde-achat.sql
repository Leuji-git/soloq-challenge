-- =====================================================================
--  fix-garde-achat.sql — débloquer les achats en boutique
--
--  LE BUG
--  Le déclencheur guard_player_update protège la fiche d'un joueur. Sa
--  dernière condition n'acceptait qu'une revendication de profil
--  (claimed_by qui passe de NULL à moi) ou un abandon (de moi à NULL).
--
--  Un achat en boutique, lui, ne touche QUE la colonne `gold` :
--  claimed_by reste inchangé. La condition tombait donc à faux et le
--  déclencheur levait « Ce profil joueur appartient déjà à quelqu'un
--  d'autre » — sur un achat, c'est incompréhensible.
--
--  LE CORRECTIF
--  Si claimed_by ne bouge pas, ce n'est ni une revendication ni un
--  abandon : c'est une écriture de jeu. Les colonnes d'identité (nom,
--  tag, équipe…) ont déjà été vérifiées juste au-dessus, donc il n'y a
--  plus rien à refuser.
--
--  À lancer après boutique-v2.sql. Idempotent.
-- =====================================================================

create or replace function public.guard_player_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;   -- SQL Editor / service_role
  if public.is_admin() then return new; end if;
  -- L'échange d'équipe acheté en boutique, et lui seul.
  if coalesce(current_setting('app.team_swap', true), '') = 'on' then return new; end if;

  -- L'identité du joueur reste intouchable.
  if row(new.id, new.name, new.tag, new.team, new.seed_score, new.sort)
     is distinct from
     row(old.id, old.name, old.tag, old.team, old.seed_score, old.sort) then
    raise exception 'Seul un administrateur peut modifier la fiche d''un joueur';
  end if;

  -- claimed_by inchangé : écriture de jeu (or dépensé en boutique,
  -- bonus…). Rien à refuser, l'identité vient d'être vérifiée.
  if new.claimed_by is not distinct from old.claimed_by then return new; end if;

  -- Reste le cas d'une revendication ou d'un abandon de profil.
  if not (
       (old.claimed_by is null      and new.claimed_by = auth.uid())
    or (old.claimed_by = auth.uid() and new.claimed_by is null)
  ) then
    raise exception 'Ce profil joueur appartient déjà à quelqu''un d''autre';
  end if;

  return new;
end $$;

notify pgrst, 'reload schema';

-- Vérification : qui peut acheter quoi aujourd'hui.
select name, gold,
       case when gold >= 25000 then 'tout, changement d''équipe compris'
            when gold >= 5000  then 'objets, 25 LP, double LP'
            when gold >= 2000  then 'objets et 25 LP'
            when gold >= 350   then 'des objets'
            else 'rien encore' end as peut_acheter
  from public.players order by gold desc;

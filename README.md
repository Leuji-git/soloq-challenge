# SoloQ Challenge

Site statique + Supabase. Aucune étape de build : les fichiers sont servis tels quels.
Les parties sont **relevées automatiquement chez Riot** par une Edge Function Supabase :
personne ne déclare rien.

```
index.html      le classement public
admin.html      la console d'administration
app.js          la logique du site
admin.js        la logique de la console
styles.css      le design
config.js       l'URL et la clé publique Supabase
vercel.json     en-têtes de sécurité
supabase/       les scripts SQL
supabase/functions/riot/index.ts   la fonction serveur qui interroge Riot
```

---

## Les scripts SQL, dans l'ordre

À coller dans **Supabase → SQL Editor → New query → Run**. Tous sont idempotents : les relancer ne casse rien.

| Ordre | Fichier | Ce qu'il fait |
|---|---|---|
| 1 | `schema.sql` | Tables, sécurité RLS, temps réel |
| 2 | `fix-triggers.sql` | Laisse passer le SQL Editor dans les triggers de garde |
| 3 | `registration.sql` | Inscription auto-service + tirage d'équipe côté serveur |
| 4 | `bets.sql` | Partenaires de duo et paris verrouillés |
| 5 | `bet-required.sql` | Rend le pari obligatoire en duo adverse (mise ≥ 5) |
| 6 | `riot-api.sql` | Suivi automatique : relevés, verrouillage des écritures, tâche planifiée — **après** avoir déployé la fonction |
| 7 | `clean-riot-ids.sql` | Retire les caractères invisibles des pseudos et tags (lien dpm.lol cassé), et empêche leur retour |
| 8 | `sync-cadence.sql` | Passe le relevé de 3 à 5 minutes |
| 9 | `items.sql` | Les objets : catalogue, inventaire, lecture publique |

---

## Suivi automatique par l'API Riot

### Comment ça marche

L'API Riot ne donne pas les LP d'une partie. La fonction relève le rang de chaque
joueur toutes les 5 minutes (League-V4) ; quand son total victoires + défaites
augmente, l'écart de LP entre deux relevés est le gain de la partie. Match-V5
dit laquelle, le champion, et si un autre joueur du challenge était dans la même
équipe (duo allié ou adverse, reconnu tout seul).

- **Promotions / rétrogradations** : gérées, le calcul passe par le score absolu.
- **Deux parties entre deux relevés** : total exact, répartition estimée (« ≈ »).
- **Esquive / décroissance** : enregistrée comme *ajustement*, compte dans le net.
- **Remakes, Flex, ARAM, placements** : ignorés.
- **Hors des dates du challenge** : ignoré.
- **Pari** : ne s'applique qu'à un duo adverse *lancé après* son ouverture ;
  s'éteint sans effet au bout de 6 h.

### La clé API Riot

| Type | Durée | Usage |
|---|---|---|
| Développement | **expire toutes les 24 h** | pour mettre en place et tester |
| Personnelle | n'expire pas | pour le challenge — **environ 2 semaines d'examen** |

Demande la clé personnelle sur <https://developer.riotgames.com> → **Register Product** → *Personal*.

### 1. Déployer la fonction

Supabase → **Edge Functions** → **Deploy a new function** → **Via Editor**.

- Nom : `riot` (exactement)
- Colle tout le contenu de `supabase/functions/riot/index.ts`
- **Deploy**

Puis, dans les réglages de la fonction, **désactive « Verify JWT »**.

> ⚠️ Bug connu du tableau de bord : cet interrupteur **se réactive tout seul à chaque
> modification** de la fonction. Revérifie-le après chaque mise à jour. S'il est
> réactivé, la tâche planifiée échoue ; le site continue de relancer des relevés
> pour les joueurs connectés, mais la console affichera « En retard ».

### 2. Ajouter la clé

Supabase → **Edge Functions** → **Secrets** → nouveau secret :

```
RIOT_API_KEY = RGAPI-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

Avec une clé de développement, reviens la remplacer ici chaque jour.

### 3. Lancer `supabase/riot-api.sql`

Il crée les tables de relevé, **ferme toute écriture de partie depuis le navigateur**,
et programme le relevé toutes les 5 minutes.

Si `create extension pg_cron` est refusé : **Database → Extensions**, active
`pg_cron` et `pg_net`, puis relance le script.

### 4. Pousser le nouveau site

Enchaîne-le juste après le script SQL : l'ancien site ne sait plus écrire une fois
le script passé, et le nouveau a besoin des tables qu'il crée.

### 5. Vérifier

Console admin → **Parties relevées** → **Forcer un relevé**. Le compte rendu doit
indiquer les comptes rattachés : les joueurs inscrits avant le suivi automatique
sont retrouvés à partir de leur pseudo et de leur tag.

Un joueur « En attente » dont le compte reste introuvable a une faute dans son
pseudo : corrige-la dans la console (possible tant que Riot n'est pas rattaché).

### Tester avant le 1er octobre

Seules les parties du challenge sont relevées. Pour voir une vraie partie arriver :
avance la date de début à aujourd'hui dans la console, joue une classée, attends
quelques minutes, puis **Zone rouge → Supprimer toutes les parties** et remets la
vraie date.

---

## Déploiement sur Vercel

> Node.js n'est pas installé sur cette machine, donc la CLI Vercel (`npx vercel`)
> n'est pas utilisable. Git l'est : on passe par GitHub, et chaque `git push`
> redéploiera le site tout seul.

### 1. Créer le dépôt local

```bash
cd "C:/Users/jules/Desktop/soloq-challenge" && git init && git add . && git commit -m "SoloQ Challenge" && git branch -M main
```

### 2. Créer le dépôt distant

Sur <https://github.com/new> : un nom (`soloq-challenge`), **Public ou Private, les deux marchent**, et surtout **ne coche ni README, ni .gitignore, ni licence** — le dépôt doit être vide.

Puis, en remplaçant `TON-PSEUDO` :

```bash
cd "C:/Users/jules/Desktop/soloq-challenge" && git remote add origin https://github.com/TON-PSEUDO/soloq-challenge.git && git push -u origin main
```

### 3. Importer dans Vercel

<https://vercel.com/new> → **Import** le dépôt → puis :

- **Framework Preset** : `Other`
- **Root Directory** : laisser la racine
- **Build Command** : vide
- **Output Directory** : vide
- **Install Command** : vide

**Deploy**. Une minute plus tard tu as une URL du type `soloq-challenge.vercel.app`.

### 4. Déclarer l'URL dans Supabase — l'étape qu'on oublie

**Authentication → URL Configuration** :

- **Site URL** : `https://soloq-challenge.vercel.app`
- **Redirect URLs** : ajouter ces deux lignes
  ```
  https://soloq-challenge.vercel.app/**
  http://localhost:3000/**
  ```

Sans ça, la connexion Discord renverra vers `localhost` et échouera pour tout le monde.

Le redirect côté **Discord Developer Portal** ne change pas : il pointe vers Supabase, pas vers le site.

### 5. Les mises à jour ensuite

```bash
cd "C:/Users/jules/Desktop/soloq-challenge" && git add . && git commit -m "Description du changement" && git push
```

Vercel redéploie automatiquement en une trentaine de secondes.

---

## Devenir administrateur

Après ta première connexion sur le site déployé :

```sql
select id, display_name from public.profiles;
update public.profiles set is_admin = true where id = 'ton-uuid';
```

Le bouton **Console admin** apparaît alors dans la barre du haut.

---

## La garantie de sécurité

`config.js` contient l'URL et la clé **publique** Supabase. C'est voulu : ces valeurs sont conçues pour vivre dans le navigateur. La sécurité ne repose pas sur leur secret mais sur les règles RLS de PostgreSQL.

```sql
create policy games_insert on public.games for insert to authenticated
  with check (created_by = auth.uid() and (public.owns_player(player_id) or public.is_admin()));
```

Forger une requête depuis la console du navigateur ne sert à rien : le serveur refuse. **Ne colle jamais la clé `service_role`** dans ce fichier, elle contournerait tout.

## Tester en local

```bash
cd "C:/Users/jules/Desktop/soloq-challenge" && python -m http.server 3000
```

Puis <http://localhost:3000>.

> Utilise des slashs `/` dans le chemin : avec des antislashs, le `\` final
> échappe le guillemet fermant et Python reçoit un argument parasite.
>
> Ouvrir `index.html` par double-clic ne fonctionne pas : `app.js` est un module
> ES, bloqué par les navigateurs en `file://`. Il faut passer par un serveur.

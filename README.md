# SoloQ Challenge

Site statique + Supabase. Aucune étape de build : les fichiers sont servis tels quels.

```
index.html      le classement public
admin.html      la console d'administration
app.js          la logique du site
admin.js        la logique de la console
styles.css      le design
config.js       l'URL et la clé publique Supabase
vercel.json     en-têtes de sécurité
supabase/       les scripts SQL
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

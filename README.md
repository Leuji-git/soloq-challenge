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
| 8 | `sync-cadence.sql` | Relevé automatique toutes les 5 min, à la demande toutes les 90 s — **à relancer**, l'étranglement y était à 240 s |
| 9 | `items.sql` | Les objets : catalogue, inventaire, lecture publique |
| 10 | `alerte-cle.sql` | Prévient le Discord quand la clé Riot meurt, et quand elle revient |
| 11 | `bac-a-sable.sql` | Simuler des parties et distribuer des objets depuis la console |
| 12 | `objets-effets.sql` | Verrouiller un objet sur une cible, et le faire agir |

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

#### Pourquoi le renouvellement n'est pas automatisé

Regénérer une clé de développement demande de se connecter au portail Riot avec
le mot de passe du compte et de passer leur protection anti-robot. Un programme
qui ferait ça irait contre les conditions d'utilisation de Riot et mettrait le
compte en danger : le projet ne le fait pas, et ne le fera pas.

Ce qui est automatisé, c'est tout le reste : **savoir** que la clé est morte à la
minute où elle meurt (alerte Discord ci-dessous), et avoir les deux liens du
remplacement sous la main dans la console. Le geste manuel se réduit à
regénérer / copier / coller, une trentaine de secondes.

La vraie sortie reste la **clé personnelle**, qui n'expire pas.

### L'alerte Discord quand la clé meurt

Sans elle, le suivi s'arrête en silence et personne ne le voit avant le soir.

1. Discord → **réglages du salon** → **Intégrations** → **Webhooks** → *Nouveau webhook*,
   choisis le salon, puis **Copier l'URL du webhook**.
2. Supabase → **Edge Functions** → **Secrets** → nouveau secret :

```
DISCORD_WEBHOOK = https://discord.com/api/webhooks/...
```

3. Lance `supabase/alerte-cle.sql`.

Le secret est **facultatif** : sans lui tout fonctionne comme avant, il n'y a
simplement personne pour prévenir. Le message n'annonce que l'état de la clé,
jamais sa valeur — il est lu par tout le salon. Une panne n'est annoncée qu'une
fois par heure, et le retour une seule fois.

Dans la console admin, un bloc rouge apparaît alors avec les deux liens du
remplacement et un bouton de vérification.

### Ce qui arrive aux parties jouées pendant une panne

Elles ne sont pas perdues. Le relevé compare des rangs, pas des parties : au
premier relevé qui refonctionne, l'écart complet est rattrapé. Le **total de LP
est exact** ; la répartition partie par partie devient une estimation, marquée
« ≈ » sur le site.

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

## Le bouton « Actualiser »

Dans la barre du haut du site, pour tout le monde, connecté ou non. Il demande
un relevé immédiat au lieu d'attendre le prochain passage automatique.

Deux garde-fous, et c'est le serveur qui tranche :

- `riot_try_start_sync` refuse un relevé lancé moins de **90 s** après le
  précédent. Le bouton affiche alors le temps restant et reste inactif.
- Un seul relevé tourne à la fois (`running_until`), peu importe le nombre de
  clics simultanés.

Le quota tient largement : un relevé coûte 8 appels Riot en régime normal, une
clé de développement en autorise 100 par 2 minutes.

Si tu changes la valeur, change-la **aux deux endroits** : `interval '90 seconds'`
dans `sync-cadence.sql` et `ATTENTE_RELEVE` dans `app.js`. Le site ne fait
qu'afficher l'attente, c'est le serveur qui l'applique.

---

## Les objets : du butin à l'effet

### Le cycle

1. **Looter** — gagner une partie en duo avec un coéquipier fait tomber un objet.
   C'est la seule source.
2. **Verrouiller** — sur le site, onglet des objets : *Verrouiller*, puis choisir la
   cible. Un **bonus** ne se pose que sur soi, un **malus** que sur un adversaire.
   La base refuse le reste, pas seulement la page.
3. **Jouer** — l'objet agit sur la **prochaine partie de la personne visée**, que sa
   condition soit remplie ou non. Tant qu'aucune partie n'a eu lieu, on peut annuler.

Seuls les objets verrouillés **avant le début** de la partie comptent : sinon on
armerait en connaissant déjà le résultat.

### Les plafonds

Deux plafonds différents, qu'il ne faut pas confondre :

- **À l'armement** : un joueur ne peut avoir que **1 bonus et 3 malus** verrouillés
  en même temps. Au-delà, le bouton *Verrouiller* s'éteint et dit pourquoi.
- **À la résolution** : sur une même partie, **1 bonus et 3 malus** font effet au
  maximum. Le premier verrouillé est le premier servi ; les objets en trop restent
  en réserve, non consommés.

Le site grise les boutons, mais c'est `lock_item` qui refuse : une requête forgée
depuis la console du navigateur se heurte au même mur.

Les chiffres vivent à **deux endroits** — `PLAFOND_ARME` dans `app.js` et les tests
de `lock_item` dans `objets-effets.sql`. Si tu en changes un, change l'autre.

### Pourquoi on ne peut pas annuler quand on veut

Une annulation libre serait une triche ouverte : il suffirait d'attendre la fin de
la partie et de reprendre l'objet s'il allait être gaspillé. Un objet ne se reprend
donc que dans les **2 minutes** qui suivent son verrouillage — le temps de corriger
un mauvais clic. Passé ce délai, le bouton devient « Verrouillé ».

L'administrateur n'est pas tenu par la fenêtre : il lui faut pouvoir défaire un
essai dans le bac à sable.

### La mémoire des choix

Chaque verrouillage et chaque annulation laisse une ligne dans **`item_locks_log`** :
qui, quel objet, sur qui, quand. La table est en lecture publique et **aucune policy
ne permet d'y écrire ni d'en effacer** depuis le navigateur ; seules les fonctions
`lock_item` et `unlock_item` y ajoutent.

C'est ce qui rend la triche visible plutôt qu'impossible à prouver : quelqu'un qui
armerait et désarmerait en boucle en attendant le bon moment laisse la trace de
chacun de ses essais, datée à la seconde.

```sql
-- Qui a armé quoi, et sur qui, ces dernieres 24 h
select at, player_id, item_key, action, target_id
  from public.item_locks_log
 where at > now() - interval '24 hours'
 order by at desc;
```

### Les deux totaux — à ne pas confondre

| Colonne | Ce que c'est | À quoi ça sert |
|---|---|---|
| `games.lp` | le LP net rendu par Riot | **le classement général, et rien d'autre** |
| `games.lp_items` | ce que les objets ont ajouté ou retiré | l'affichage de la partie |

Le récap montre le **total** en gros (net + objets : ce que le joueur a ressenti) et
le **net** en petit. Le classement, lui, ne bouge jamais des LP nets : c'est la règle
d'origine du challenge, et les objets ne la touchent pas.

### Où vivent les effets

Les 14 effets sont des fonctions dans `EFFETS`, dans
`supabase/functions/riot/index.ts`, à l'intérieur du bloc **LOGIQUE PURE** — donc
testables en l'extrayant entre ses marqueurs. Le texte affiché pour chaque objet
vit, lui, dans la colonne `items.effect`, posée par `objets-effets.sql`.

**Les deux doivent dire la même chose.** Si tu changes un effet, change-le aux deux
endroits : c'est le code qui calcule, mais c'est le texte que les joueurs lisent.

Une donnée manquante ne déclenche jamais un malus : un objet qui dépend du nombre
de morts ou du score de vision ne fait rien si Riot ne les a pas donnés.

---

## Le bac à sable

Console admin → **Bac à sable**. Pour essayer les objets sans attendre une vraie
partie classée :

- **Donner un objet** à n'importe quel joueur, choisi ou tiré au sort selon les
  raretés réelles ;
- **Simuler une partie** avec les LP, le résultat, le type de duo, et de quoi
  déclencher les conditions : champion, durée, morts, score de vision. Une victoire
  *avec un coéquipier* fait tomber un objet, exactement comme le relevé réel ;
- **Verrouiller un objet** à la place d'un joueur, pour essayer un effet sans avoir
  à se connecter avec son compte ;
- **Effacer tout le simulé** d'un bouton.

La simulation passe par l'action `sim` de la fonction « riot », pas par du SQL :
c'est elle qui porte le moteur d'effets, et on veut que le bac à sable donne
exactement ce que donnera le relevé réel.

Tout ce qui sort d'ici porte un `match_id` et un `source_match` commençant par
`sim-`. C'est ce qui permet de tout retirer sans toucher à une seule vraie
partie — et c'est aussi pourquoi le relevé réel ne peut jamais entrer en
collision avec, un identifiant Riot ressemblant à `EUW1_7391...`.

Les écritures passent par trois fonctions SQL `security definer` réservées à
l'administrateur : le navigateur, lui, reste incapable d'écrire une partie.
C'est la garantie que personne ne peut s'inventer des LP, et elle ne bouge pas.

**À faire avant le vrai départ :** un passage par *Effacer tout le simulé*.

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

# Jour 2 : REST, MCP et IA en streaming

Une application, deux interfaces d'accès. Les contrôleurs REST et les outils MCP
appellent les mêmes opérations applicatives. TanStack AI utilise le serveur MCP par
HTTP et diffuse sa réponse via une route Hono `/chat` distincte.

## Lancer le projet en local

Bun et Docker Compose sont nécessaires. Depuis ce dossier :

```sh
cp .env.example .env
bun install
docker compose up -d --wait
bun run dev
```

L'API écoute sur http://127.0.0.1:3000. PostgreSQL est accessible sur localhost:55432.
Si nécessaire, modifiez ensemble `POSTGRES_PORT` et `DATABASE_URL`. `ADMINER_PORT`
configure l'interface web de la base de données. Si vous modifiez `PORT`, l'URL MCP
interne par défaut s'adapte. `MCP_URL` remplace l'URL de confiance utilisée par le
client IA ; cette URL ne peut pas être définie par un paramètre de requête.

Ajoutez votre clé OpenRouter dans `.env` :

```dotenv
OPENROUTER_API_KEY=your-key
OPENROUTER_MODEL=z-ai/glm-5.3-flash
```

L'adaptateur réel utilise le point de terminaison Chat Completions d'OpenRouter,
compatible avec l'API OpenAI : `https://openrouter.ai/api/v1`. Le modèle par défaut
est `z-ai/glm-5.3-flash` ; la variable `OPENROUTER_MODEL` permet de le remplacer.
REST, MCP et les tests n'ont pas besoin de clé d'API de modèle. Sans clé, `/chat`
renvoie le statut 503.

Les appels au modèle réel peuvent entraîner des frais. Chaque requête de chat est
limitée à cinq itérations de boucle d'outils et à une durée maximale de 60 secondes.
Le chat fonctionne sur un seul tour et ne stocke pas l'historique des conversations.

### Interface web de la base de données

Ouvrez http://localhost:8080 et choisissez PostgreSQL :

| Champ          | Valeur     |
| -------------- | ---------- |
| Serveur        | `postgres` |
| Nom d'utilisateur | `events` |
| Mot de passe   | `events`   |
| Base de données | `events`  |

Dans Adminer, `postgres` est le nom du service Compose, pas `localhost`.
Utilisez la commande SQL pour interroger la base ou l'option d'importation pour
charger `sql/init.sql`. Ces services écoutent uniquement en local et utilisent des
identifiants de démonstration.

### SQL et migration vers UUID v7

`sql/init.sql` crée les tables `users`, `venues`, `events` et `reservations`, puis
insère des données de démonstration. Compose exécute ce fichier automatiquement
uniquement lorsque le volume de la base est vide. Pour le lancer manuellement sur le
schéma courant :

```sh
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U events -d events < sql/init.sql
```

Le nouveau domaine exige des identifiants UUID v7 en minuscules. Les anciennes
données de démonstration en UUID v4 ne sont pas compatibles. Relancer le fichier
d'initialisation ne migre pas les anciennes lignes. Pour des données de cours
jetables, réinitialisez explicitement le volume ; cela supprime toutes les données
locales :

```sh
docker compose down -v
docker compose up -d --wait
```

Pour conserver les données existantes, sauvegardez la base et exécutez plutôt la
migration qui préserve les données :

```sh
docker compose exec -T postgres pg_dump -U events -d events > /tmp/events-before-uuid-v7.sql
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U events -d events < sql/migrate-uuid-v7.sql
```

Cette migration convertit les anciens identifiants et leurs clés étrangères dans une
transaction, tout en préservant les réservations et leur propriétaire. Elle affiche
la correspondance entre anciens et nouveaux identifiants afin de mettre à jour les
références externes. Si un nouvel identifiant existe déjà, la transaction est annulée
plutôt que de perdre des données. Relancer la migration ne modifie pas les
identifiants UUID v7 déjà présents. Sur une ancienne base, exécutez-la avant de
relancer le fichier d'initialisation. Aucune réinitialisation ni migration n'est
effectuée automatiquement.

Si l'outil MCP `list_events` renvoie `INTERNAL_ERROR` et que la route REST `/events`
renvoie aussi le statut 500, consultez les journaux du serveur : les anciennes lignes
en UUID v4 ne peuvent pas être décodées par le mapper UUID v7 du domaine. La migration
résout ce problème ; modifier la requête du client ou ajouter une identité ne le
résout pas.

| Enregistrement | UUID v7                                |
| -------------- | -------------------------------------- |
| Alice          | `01900000-0000-7000-8000-000000000001` |
| Bob            | `01900000-0000-7000-8000-000000000002` |
| Lieu           | `01900000-0000-7000-8000-000000000003` |
| Événement jeux | `01900000-0000-7000-8000-000000000004` |

## Architecture

```text
REST /events, /reservations ──> Contrôleur REST ──┐
                                                ├─> Opérations applicatives ─> Dépôt
MCP /mcp ────────────────────> Gestionnaires d'outils ┘
          ↑
TanStack AI /chat ────────────> Client HTTP MCP
```

```text
src/
  bootstrap.ts          Assemblage de l'application et serveur HTTP local
  app.ts                Configuration Hono et conversion des erreurs HTTP
  routes/               Routes REST et validation des requêtes
  controllers/          Traduction REST et appel des opérations applicatives
  mcp/                  Outils, schémas, résultats et transport HTTP MCP
  chat/                 Boucle IA TanStack et réponses AG-UI en SSE
  application/          Cas d'usage, lectures, identité et interface de dépôt
  domain/               Règles des événements/réservations et UUID v7 typés
  shared-kernel/        Option et Result, sans dépendance envers un framework
  infrastructure/       Petit ORM Bun.SQL, dépôts et mappings d'entités
  presentation/         Schémas DTO Valibot et conversion domaine-vers-DTO
  validation.ts         Schémas de requête Valibot et conversion des ID typés
sql/init.sql            Schéma PostgreSQL et données initiales
```

Les imports utilisent l'alias `#/*`, configuré dans `package.json` et `tsconfig.json`
comme dans `hono-deep`. Les couches domaine et application ne dépendent ni de Hono,
ni de MCP, TanStack AI ou Valibot. REST et MCP valident les entrées et les sorties à
l'exécution. Les schémas JSON MCP, destinés à la découverte des outils, sont générés
depuis les schémas d'entrée Valibot avant les transformations de dates et d'ID typés.
Valibot continue d'exécuter ses contrôles personnalisés et le nettoyage des espaces,
même lorsque JSON Schema ne peut pas les exprimer.

### Erreurs représentées comme valeurs et absence

Les échecs métier attendus sont des valeurs `Result<Value, Error>` avec `_tag:
'Success'` ou `_tag: 'Failure'`. La création d'événements, les contrôles de capacité,
les modifications, les réservations et les annulations renvoient des résultats au
lieu de lever une exception pour ces échecs attendus.

`Option<Value>` représente une valeur éventuellement absente avec `None` et `Some`.
Les lectures du dépôt renvoient `Option<Event>`. Dans le domaine, `cancelledAt` et,
dans l'entité de persistance, `cancelled_at` utilisent `Option<Date>`. Le décodage
d'une ligne SQL convertit `NULL` en `None` ; l'écriture SQL reconvertit cette valeur
à la frontière du pilote uniquement. Les réponses JSON exposent une date ou `null`,
selon le contrat d'échange.

Les adaptateurs d'accès inspectent directement les `Result` et transforment leurs
échecs en codes de statut REST ou en erreurs d'outil MCP, sans lever d'exception pour
les échecs attendus. Les erreurs d'infrastructure inattendues continuent d'être
levées. Un DTO de réponse invalide ou des données stockées corrompues constituent
une erreur serveur, pas une erreur de requête client.

### Persistance

`EventData` représente l'état du domaine en camelCase. `EventEntity` représente la
ligne PostgreSQL. Les entités de réservation convertissent les valeurs absentes de la
base en `Option`. Des mappers explicites séparent ces représentations des DTO publics.

Le petit `Orm` intégré au projet utilise des mappings fixes de tables et de colonnes,
et des valeurs paramétrées pour construire des requêtes `SELECT`, `INSERT`, `UPDATE`
et `SUM`. Il repose sur le pilote SQL de Bun, et non sur une bibliothèque ORM externe.
Il ne génère pas le schéma et ne charge pas automatiquement les relations ; le schéma
SQL reste défini dans `sql/init.sql`.

`PostgresEventRepository` verrouille la ligne de l'événement avant de compter les
réservations actives et d'enregistrer une réservation ou un changement de capacité.
Les deux opérations utilisent le même verrou pour éviter les réservations au-delà de
la capacité. Si la fonction de modification renvoie `Failure`, aucune écriture n'est
effectuée. L'annulation verrouille la réservation, vérifie son propriétaire et
enregistre la date d'annulation au lieu de supprimer la ligne.

`InMemoryEventRepository` implémente la même interface pour accélérer les tests
backend. Fournissez-lui des ensembles contenant les ID connus des utilisateurs et des
lieux, puis transmettez-le à `createServices`. Aucun `await` artificiel ne sépare le
contrôle de capacité de l'écriture : chaque mutation s'exécute dans un seul tour de
boucle d'événements JavaScript. C'est un faux dépôt de test ; il ne prouve pas le
fonctionnement des transactions PostgreSQL. Le serveur par défaut utilise toujours
PostgreSQL.

## REST et MCP côte à côte

Chaque outil MCP est appelé par `POST /mcp` avec la méthode JSON-RPC `tools/call`.

| Point de terminaison REST                       | Outil MCP              | Arguments                                         |
| ----------------------------------------------- | ---------------------- | ------------------------------------------------- |
| `GET /events?category=gaming&after=...`         | `list_events`          | `category` et `after` facultatifs                 |
| `POST /events`                                  | `create_event`         | `title`, `category`, `startsAt`, `capacity`, `venueId` |
| `GET /events/{eventId}`                        | `get_event`            | `eventId`                                         |
| `PATCH /events/{eventId}`                      | `update_event`         | `eventId`, `patch` non vide                       |
| `POST /events/{eventId}/reservations`          | `reserve_event`        | `eventId`, `quantity`                             |
| `GET /me/reservations`                         | `list_my_reservations` | Objet vide                                       |
| `POST /reservations/{reservationId}/cancellation` | `cancel_reservation` | `reservationId`                                  |

La création d'un événement et une réservation REST renvoient le statut 201. Les
autres opérations réussies renvoient 200. La création d'un événement fournit un
en-tête `Location`. Les listes REST sont des tableaux. Les résultats des outils MCP
encapsulent les tableaux dans `{ events: [...] }` ou `{ reservations: [...] }`, car
les sorties structurées des outils sont des objets. Les autres outils renvoient le
même DTO que REST en cas de succès.

Les requêtes refusent les champs inconnus. Les dates doivent comporter un fuseau
horaire. `after` filtre les événements dont la date de début est strictement
postérieure à la valeur fournie ; ce n'est pas un curseur de pagination. Les listes
sont triées par date puis par ID. Il n'y a pas de pagination. Les événements doivent
avoir lieu dans le futur ; capacité et quantité doivent être des entiers positifs
sur 32 bits ; la capacité ne peut pas être inférieure au nombre de réservations
actives. Un utilisateur peut effectuer plusieurs réservations. Une réservation peut
être annulée même après le début de l'événement, uniquement par son propriétaire et
une seule fois.

### Exemple de deux requêtes équivalentes

```sh
curl -i http://127.0.0.1:3000/events/01900000-0000-7000-8000-000000000004/reservations \
  -H 'Content-Type: application/json' \
  -H 'X-User-Id: 01900000-0000-7000-8000-000000000001' \
  -d '{"quantity":2}'

curl -N http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-11-25' \
  -H 'X-User-Id: 01900000-0000-7000-8000-000000000001' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"reserve_event","arguments":{"eventId":"01900000-0000-7000-8000-000000000004","quantity":2}}}'
```

Chaque requête crée une réservation distincte. Exécuter les deux réserve quatre
places, pas deux. Un client MCP normal commence par `initialize`, puis
`notifications/initialized` ; la collection ci-dessous contient ces deux requêtes.
Le serveur est sans état : aucun en-tête d'identifiant de session n'est nécessaire.

### Contrats d'erreur

Les erreurs REST utilisent un `ErrorDto` validé à l'exécution :

```json
{ "error": { "code": "CONFLICT", "message": "Not enough seats" } }
```

REST renvoie le statut 400 pour une entrée invalide, 401 pour une identité de
démonstration absente ou inconnue, 404 pour une ressource absente, 409 pour un conflit
métier et 500 pour une erreur inattendue.

Un appel MCP valide qui échoue pour une raison métier renvoie un résultat contenant
`isError: true` et un DTO d'erreur encodé en texte, généralement dans une réponse HTTP
200. Le `McpServer` du SDK signale également les arguments d'outil invalides et les
noms d'outils inconnus avec `isError: true`, mais le texte fourni par le SDK ne suit pas le
format du DTO d'erreur de l'application. Les enveloppes JSON-RPC mal formées
produisent toujours des erreurs de protocole ; les échecs du transport HTTP restent
des erreurs de transport. Ne considérez pas un statut HTTP 200 comme la preuve qu'un
outil a réussi.

Les outils utilisent `McpServer.registerTool`. Valibot est la source de vérité des
schémas ; ses schémas JSON générés sont adaptés à Zod uniquement parce que le SDK
MCP installé exige Zod pour l'enregistrement. La validation UUID utilise un seul
motif UUID v7 en minuscules, évitant le `allOf` produit par plusieurs contrôles UUID
et préservant la compatibilité avec le mode strict. Les filtres de lecture MCP
facultatifs acceptent `null` comme absence ; les ID obligatoires et les champs
d'écriture ne l'acceptent pas.

### Identité de démonstration et sécurité

Les opérations de réservation et `/chat` utilisent l'en-tête `X-User-Id`. Les
arguments des outils MCP ne permettent pas de choisir un utilisateur : l'identité
vient de l'en-tête de la requête, que TanStack transmet à MCP. Cet en-tête ne constitue
pas une authentification. N'importe qui peut usurper l'identité d'un utilisateur
initialisé. Pour cet exercice, la création et la modification des événements restent
publiques. Avant de déployer un agent IA en dehors de cette démonstration, ajoutez une
authentification, des permissions d'organisateur, des limites de débit et une
approbation explicite des écritures. Les annotations des outils et les instructions
du système ne remplacent ni les autorisations ni les contrôles d'approbation.

Le serveur écoute uniquement sur l'interface locale. MCP refuse les origines de
navigateur autres que celles des ports locaux 3000. Yaak et les requêtes en ligne de
commande omettent normalement l'en-tête `Origin`. Aucune interface web inter-origines
n'est configurée. Les écritures ne sont pas idempotentes : ne relancez pas
automatiquement une réservation après un délai d'attente.

## Démonstration avec Yaak

Importez `demo/yaak.postman_collection.json` avec l'importateur Postman de Yaak. Ce
fichier d'échange Postman v2.1 n'est pas un espace de travail Yaak natif. Les requêtes
utilisent des URL locales explicites et l'en-tête `X-User-Id` d'Alice, y compris pour
la découverte et les lectures publiques. Vous pouvez ainsi inspecter chaque requête
sans configurer d'environnement. Il n'y a pas de session de connexion : l'en-tête
définit explicitement l'identité de démonstration de chaque requête.
Le fichier est généré par `bun run demo:export`.

1. Ouvrez le dossier `0. MCP handshake and discovery`. Envoyez `initialize`, puis
   `initialized`, puis `tools/list`.
2. Pour chaque scénario, comparez la requête REST à la requête MCP du même dossier.
3. Réservez des places par une interface et lisez les réservations par l'autre.
4. Comparez le statut REST 409 à `isError: true` côté MCP lorsqu'il n'y a plus de places.
5. Comparez le statut REST 400 au résultat MCP `isError: true` pour une entrée invalide.
6. Copiez l'ID d'une réservation dans les deux requêtes d'annulation. Si votre
   importateur ne reprend pas les variables de la collection, remplacez le texte
   littéral `{{reservationId}}`.
7. Avec une clé de fournisseur configurée, envoyez la requête `/chat` et inspectez
   ses événements SSE.

MCP Streamable HTTP et le flux SSE du chat sont différents. MCP émet des messages
JSON-RPC ; le chat émet des événements AG-UI tels que `RUN_STARTED`,
`TOOL_CALL_START`, `TOOL_CALL_RESULT`, `TEXT_MESSAGE_CONTENT` et `RUN_FINISHED`.
Après l'envoi des en-têtes de streaming, les échecs apparaissent sous forme
d'événements `RUN_ERROR` plutôt que par un changement du statut HTTP. Le client
normal doit gérer les erreurs HTTP avant le début du flux et celles émises pendant
le flux.

L'affichage SSE varie selon les versions de Yaak. Les tests du SDK et les clients
en ligne de commande ci-dessous vérifient le protocole ; importer une collection ne
remplace pas ces vérifications.

## Lire les flux

Le client MCP en ligne de commande utilise le SDK officiel, qui gère l'initialisation
et l'analyse SSE :

```sh
bun run demo:mcp
bun run demo:mcp list_events '{"category":"gaming"}'
bun run demo:mcp list_my_reservations '{}'
```

Le client de chat en ligne de commande utilise un analyseur SSE, pas une séparation
faite à la main des blocs reçus sur le réseau :

```sh
bun run demo:chat 'List upcoming gaming events'
bun run demo:chat 'Show my reservations using your tools'
```

Il affiche les fragments de texte et les événements des outils, vérifie que le flux
se termine correctement et signale les erreurs HTTP ou celles du flux. Définissez
`API_URL` et `DEMO_USER_ID` pour remplacer les valeurs locales par défaut.
Ctrl-C interrompt la requête. Le serveur ferme le client MCP de chaque requête après
son succès, son échec ou son annulation. Il ne partage jamais la connexion MCP d'un
utilisateur avec une autre requête.

## Vérifications et tests backend

```sh
bun run format
bun run lint:fix
bun run check
bun run test
bun run test:transports
```

Oxfmt limite les lignes à 80 colonnes, sauf pour les chaînes impossibles à couper.
Oxlint exige des accolades autour des conditions et des boucles. La commande `check`
vérifie le formatage, les règles de lint et les types.

Tous les tests utilisent `InMemoryEventRepository`. Ils n'ont besoin ni de Docker, ni
d'une base de données, ni d'une clé d'API, et ne touchent jamais à la base de
démonstration. `test` lance toute la suite ; `test:transports` sélectionne les tests
des transports REST, MCP et chat. Les tests couvrent notamment :

- Les `Result` du domaine, l'analyse des UUID v7, les modifications immuables et
  l'état d'annulation `Option`.
- L'initialisation du vrai SDK MCP, la découverte, la validation des schémas et les
  sept scénarios d'utilisation des outils.
- Le partage de l'état entre REST et MCP via un serveur HTTP local éphémère.
- Les réservations concurrentes de la dernière place, le contrôle de capacité, la
  propriété des réservations et les annulations répétées.
- La validation REST, les statuts renvoyés et la conservation des dates d'annulation
  en mémoire.
- L'appel d'outils MCP par TanStack AI avec l'identité de la requête ; un adaptateur
  scripté remplace uniquement le LLM externe.
- L'analyse du flux navigateur, les événements intermédiaires de fin d'appel d'outil,
  les filtres de lecture pouvant être nuls, la réponse finale, les erreurs, les
  annulations et la fermeture de MCP après un arrêt anticipé.

Les tests utilisent des étapes Given/When/Then :
`given(setup).when(action).then(assertion)` transmet des données typées entre elles.
Ils vérifient les `Result` d'erreur renvoyés et le comportement précis des transports,
plutôt que d'accepter n'importe quelle exception.

Ces tests ne vérifient ni les transactions PostgreSQL, ni les verrous de lignes, ni
les migrations. Le dépôt de production et la migration SQL restent disponibles pour
l'application exécutée. Le comportement réel d'OpenRouter et du modèle doit aussi
être vérifié manuellement : un adaptateur déterministe ne garantit pas qu'un vrai
modèle choisira le bon outil.

`test/orm.test.ts` vérifie le SQL généré et les valeurs de paramètres sans se
connecter à PostgreSQL.

### Références

- Transport Hono MCP : https://github.com/honojs/middleware/tree/main/packages/mcp
- Spécification MCP : https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- TanStack AI : https://tanstack.com/ai/latest/docs/overview
- API MCP de TanStack AI installée : `node_modules/@tanstack/ai-mcp/README.md`

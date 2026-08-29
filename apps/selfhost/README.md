# SelfTune Self-Host

SelfTune Self-Host is the customer-operated host for SelfTune's non-commerce
collaboration journeys. It runs the canonical local dashboard and Remote
Library in one container. SQLite, immutable skill objects, Skill Sets, users,
private shares, consented contributor signals, device manifests, updates, and
audit records live in one `/data` volume. Raw prompts, transcripts, sessions,
local paths, evaluations, and improvements never sync.

A deployment belongs to one customer trust boundary. It may have multiple
users, roles, and workspaces. PragSys billing, trials, invoices, public signup,
cross-customer SaaS operations, and vendor fleet administration exist only in
the optional managed service and are not required to operate SelfTune.

## Start

```bash
cd apps/selfhost
cp .env.example .env
openssl rand -hex 32
# Put the generated token in SELFTUNE_AUTH_TOKEN, then:
chmod 600 .env
docker compose up -d
```

Open `http://localhost:8787` and sign in with `SELFTUNE_AUTH_TOKEN`. For an internet-facing host, terminate TLS with Caddy, Traefik, or another reverse proxy and set `SELFTUNE_PUBLIC_URL` to its exact HTTPS origin.

## Connect SelfTune

Configure a desktop or CLI installation with an account token, then sync its immutable library:

```bash
selftune library configure --url https://selftune.example.com --api-key "$SELFTUNE_ACCOUNT_TOKEN"
selftune library preview
selftune library sync
selftune library status
```

The admin token can upload objects, commit snapshots, create shares, and revoke shares. Optional accounts in `SELFTUNE_SELFHOST_USERS_JSON` may use `member` or `viewer` roles. Accounts are closed by default: changing the JSON and restarting the container is the only way to activate or deactivate them. Tokens are SHA-256 hashed in SQLite; the `.env` file remains the credential source and must stay private.

## Back Up

The named volume contains both SQLite and immutable objects. Stop writes before archiving it:

```bash
docker compose stop selftune
docker run --rm -v selftune-data:/data:ro -v "$PWD":/backup alpine \
  tar -czf /backup/selftune-backup.tgz -C /data .
docker compose start selftune
```

Restore into an empty `selftune-data` volume while the service is stopped. Never back up only `selftune-selfhost.db`; a usable backup requires the database and `objects/` together.

## Data Layout

```text
/data/
├── selftune-selfhost.db       # users, heads, snapshots, shares, audit
├── selftune-selfhost.db-wal
├── objects/<org>/<sha256>     # immutable skill and Skill Set content
└── runtime/                   # canonical dashboard/control-plane state
```

`GET /healthz` is an unauthenticated process-liveness probe. `GET /readyz` verifies SQLite initialization and every configured organization's referenced immutable objects; it returns `503` when storage is unavailable or integrity is degraded. The container health check uses `/readyz`. Neither probe returns tenant data. Every `/api/v1/remote-library/*` operation requires a bearer token and is scoped to its persisted organization.

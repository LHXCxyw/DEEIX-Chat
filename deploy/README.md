# Deployment

Docker deployment assets that stay separate from the application source. The compose file itself lives at
the repository root; this directory holds the configuration template, the optional document services, and
the desktop rollout assets.

```
deploy/
├── config.example.yaml           Template for the root config.yaml (Database and Redis defaults already
│                                 point at the postgres / redis services of the root compose stack)
├── services/                     Optional document extraction / OCR services
├── secrets/                      Signing keys for desktop releases; see secrets/README.md
└── windows/                      Desktop client rollout on managed Windows (MSI, portable, Group Policy)
```

Rolling out the desktop client to managed Windows machines is covered separately in
[`windows/README.md`](windows/README.md).

## Run

There is one deployment workflow, defined by [`../docker-compose.yml`](../docker-compose.yml). From the
repository root:

```bash
cp deploy/config.example.yaml config.yaml   # first run only
docker compose up -d --build
```

Compose builds the image locally from this source tree and starts the application together with
PostgreSQL and Redis. Every stateful path is bound to `./data` in the project root
(`storage`, `app`, `postgres`, `redis`), which matches the layout used by earlier versions, so an
existing `./data` directory can be reused as-is. The app is exposed on `http://localhost:3700`, and the
root `config.yaml` is mounted read-only at `/app/config.yaml`.

The full guide — configuration, persistence paths, data migration, and common operations — is in the
[root README](../README.md#docker-deployment).

## Optional services

Each service under `services/` is self-contained (its own build context) and attaches to
`deeix-chat-network`, so start the root compose stack first. Run these from inside `deploy/`:

```bash
docker compose -f services/tika/docker-compose.yml up -d
docker compose -f services/tesseract/docker-compose.yml up -d --build
docker compose -f services/docling/docker-compose.yml up -d --build
```

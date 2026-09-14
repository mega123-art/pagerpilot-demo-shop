# demo-shop

Small order-taking shop: `frontend` (gateway) -> `orders` (API) -> Postgres.

- `frontend/`, `orders/`: Express services, one `package.json` each
- `_shared/`: logging and metrics used by both
- `db/migrations/`: SQL applied to Postgres by hand, in order
- `deploy/`: runtime config for the frontend
- `Dockerfile`: `docker build -f Dockerfile --build-arg SERVICE=orders .`

Releases are tagged per service, e.g. `orders-v1.0.2`.

CREATE TABLE orders (
  id          bigserial PRIMARY KEY,
  customer_id integer     NOT NULL,
  status      text        NOT NULL,
  total_cents integer     NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_orders_customer_id ON orders (customer_id);

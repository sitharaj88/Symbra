-- Application schema.
-- Owned by the platform team.

CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped');

-- People who can sign in.
CREATE TABLE "public"."users" (
    id          BIGSERIAL PRIMARY KEY,
    email       VARCHAR(255) NOT NULL UNIQUE,
    full_name   TEXT,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE orders (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    status      order_status NOT NULL DEFAULT 'pending',
    total_cents NUMERIC(12, 2) NOT NULL,
    CONSTRAINT orders_total_positive CHECK (total_cents > 0)
);

CREATE TABLE order_items (
    id       BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL,
    sku      TEXT NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders (id)
);

CREATE INDEX idx_orders_user ON orders (user_id);

-- Orders with their customer email.
CREATE VIEW order_summary AS
SELECT o.id, u.email, o.total_cents
  FROM orders o
  JOIN users u ON u.id = o.user_id
 WHERE o.status <> 'pending';

CREATE OR REPLACE FUNCTION total_for_user(p_user_id BIGINT)
RETURNS NUMERIC AS $$
BEGIN
    -- semicolons in here must not split the statement
    RETURN (SELECT COALESCE(SUM(total_cents), 0) FROM orders WHERE user_id = p_user_id);
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION audit_order() RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO audit_log (message) VALUES ('order changed');
    PERFORM total_for_user(NEW.user_id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orders_audit
AFTER INSERT OR UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION audit_order();

ALTER TABLE order_items ADD CONSTRAINT order_items_sku_fk FOREIGN KEY (sku) REFERENCES products (sku);

COMMENT ON TABLE orders IS 'One row per customer order.';
COMMENT ON COLUMN orders.total_cents IS 'Total in minor units.';

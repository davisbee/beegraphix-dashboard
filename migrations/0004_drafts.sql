-- New video drafts: a video someone is still working on (say, waiting on footage), saved so anyone on the
-- brand can open it from any computer. data is the New video screen's form, as JSON.
CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  brand TEXT NOT NULL,
  title TEXT NOT NULL,
  template TEXT NOT NULL,
  data TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX drafts_brand_updated ON drafts (brand, updated_at);

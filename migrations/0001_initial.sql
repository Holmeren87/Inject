-- Inject.dk initial production schema
-- Migration: 0001_initial.sql

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name TEXT,
  contact_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  vat_number TEXT,
  country_code TEXT DEFAULT 'DK',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
CREATE INDEX IF NOT EXISTS idx_customers_company ON customers(company_name);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL,

  description TEXT NOT NULL,
  quantity INTEGER,
  quantity_bucket TEXT,
  annual_quantity INTEGER,

  material TEXT,
  material_other TEXT,
  color TEXT,

  delivery_bucket TEXT,
  delivery_date TEXT,

  current_process TEXT,
  current_unit_price REAL,

  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','reviewing','quoted','won','lost','closed')),

  source TEXT,
  landing_page TEXT,
  referrer TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_term TEXT,
  utm_content TEXT,
  gclid TEXT,

  first_response_at TEXT,
  quote_sent_at TEXT,
  quote_amount REAL,
  won_at TEXT,
  lost_at TEXT,
  lost_reason TEXT,

  assigned_to TEXT,
  internal_note TEXT,

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_requests_case_number ON requests(case_number);
CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_quantity_bucket ON requests(quantity_bucket);
CREATE INDEX IF NOT EXISTS idx_requests_material ON requests(material);
CREATE INDEX IF NOT EXISTS idx_requests_delivery_bucket ON requests(delivery_bucket);
CREATE INDEX IF NOT EXISTS idx_requests_source ON requests(source);
CREATE INDEX IF NOT EXISTS idx_requests_customer_id ON requests(customer_id);

CREATE TABLE IF NOT EXISTS request_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  original_name TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  mime_type TEXT,
  extension TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_request_files_request_id ON request_files(request_id);
CREATE INDEX IF NOT EXISTS idx_request_files_extension ON request_files(extension);

CREATE TABLE IF NOT EXISTS request_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER,
  event_name TEXT NOT NULL,
  event_value TEXT,
  session_id TEXT,
  page_url TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_request_events_request_id ON request_events(request_id);
CREATE INDEX IF NOT EXISTS idx_request_events_name ON request_events(event_name);
CREATE INDEX IF NOT EXISTS idx_request_events_created_at ON request_events(created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  field_name TEXT,
  old_value TEXT,
  new_value TEXT,
  ip_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_request_id ON audit_log(request_id);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO counters(name, value) VALUES ('request_sequence_2026', 0);

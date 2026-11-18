// Migrationen werden in Reihenfolge ausgeführt; der Index + 1 entspricht PRAGMA user_version.
// Bestehende Migrationen niemals verändern – nur neue anhängen.

export const MIGRATIONS: string[] = [
  /* 1: Grundschema */ `
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_opened_at INTEGER,
  output_dir TEXT,
  work_mode TEXT NOT NULL DEFAULT 'collect' CHECK (work_mode IN ('collect','instant')),
  operation TEXT NOT NULL DEFAULT 'copy' CHECK (operation IN ('copy','move')),
  conflict_policy TEXT NOT NULL DEFAULT 'rename' CHECK (conflict_policy IN ('rename','skip')),
  recovery_dir TEXT,
  ui_state TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  real_path TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  last_scan_at INTEGER,
  scan_status TEXT NOT NULL DEFAULT 'idle' CHECK (scan_status IN ('idle','scanning','error','unavailable')),
  scan_error TEXT,
  file_count INTEGER NOT NULL DEFAULT 0,
  skipped_links INTEGER NOT NULL DEFAULT 0,
  excluded_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE (project_id, real_path)
);

CREATE TABLE media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  original_path TEXT NOT NULL,
  path_key TEXT NOT NULL,
  current_path TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT 'source' CHECK (location IN ('source','recovery','missing')),
  rel_dir TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL,
  ext TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image','raw','video')),
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  sha256 TEXT,
  hashed_at INTEGER,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  codec TEXT,
  captured_at INTEGER,
  meta_status TEXT NOT NULL DEFAULT 'none' CHECK (meta_status IN ('none','ok','error')),
  thumb_status TEXT NOT NULL DEFAULT 'none' CHECK (thumb_status IN ('none','ok','error')),
  thumb_error TEXT,
  dup_group TEXT,
  imported_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, path_key)
);
CREATE INDEX idx_media_project ON media(project_id);
CREATE INDEX idx_media_project_size ON media(project_id, size);
CREATE INDEX idx_media_sha ON media(project_id, sha256);
CREATE INDEX idx_media_source ON media(source_id);

CREATE TABLE packages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  shortcut INTEGER CHECK (shortcut IS NULL OR (shortcut BETWEEN 1 AND 9)),
  target_dir TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, name)
);
CREATE UNIQUE INDEX idx_packages_shortcut ON packages(project_id, shortcut) WHERE shortcut IS NOT NULL;

CREATE TABLE media_packages (
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  assigned_at INTEGER NOT NULL,
  PRIMARY KEY (media_id, package_id)
) WITHOUT ROWID;
CREATE INDEX idx_mp_package ON media_packages(package_id);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('export','restore')),
  mode TEXT NOT NULL CHECK (mode IN ('collect','instant')),
  operation TEXT NOT NULL CHECK (operation IN ('copy','move')),
  conflict_policy TEXT NOT NULL CHECK (conflict_policy IN ('rename','skip')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','paused','completed','completed_with_errors','cancelled')),
  label TEXT NOT NULL DEFAULT '',
  plan_json TEXT NOT NULL DEFAULT '{}',
  interrupted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_jobs_project ON jobs(project_id, created_at);

CREATE TABLE job_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('copy','release_source','restore')),
  media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  package_id TEXT REFERENCES packages(id) ON DELETE SET NULL,
  package_name TEXT,
  recovery_item_id TEXT,
  idempotency_key TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  file_name TEXT NOT NULL,
  src_path TEXT NOT NULL,
  src_size INTEGER NOT NULL,
  src_mtime_ms INTEGER NOT NULL,
  src_sha256 TEXT,
  dest_dir TEXT,
  dest_name TEXT,
  final_path TEXT,
  tmp_path TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','copying','verifying','committing','waiting','recovery_copying','recovery_committed','source_removing','done','skipped','failed','cancelled')),
  result_sha256 TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  retry_at INTEGER,
  error_code TEXT,
  error_message TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_items_job ON job_items(job_id, seq);
CREATE INDEX idx_items_media ON job_items(media_id);
CREATE INDEX idx_items_status ON job_items(status);
-- Idempotenz: pro Medium/Paket/Dateiversion höchstens ein aktiver Auftragseintrag
CREATE UNIQUE INDEX idx_items_idem_active ON job_items(idempotency_key) WHERE active = 1;

CREATE TABLE job_item_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL REFERENCES job_items(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT
);
CREATE INDEX idx_item_events_item ON job_item_events(item_id);

CREATE TABLE transfer_destinations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  package_id TEXT REFERENCES packages(id) ON DELETE SET NULL,
  package_name TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('exported','identical_existing')),
  job_item_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_dest_media_pkg ON transfer_destinations(media_id, package_id);
CREATE INDEX idx_dest_project ON transfer_destinations(project_id);

CREATE TABLE recovery_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  file_name TEXT NOT NULL,
  original_path TEXT NOT NULL,
  recovery_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staging','held','released','restored','purged','discarded')),
  job_item_id TEXT,
  moved_at INTEGER NOT NULL,
  released_at INTEGER,
  retain_until INTEGER,
  restored_at INTEGER,
  restored_to TEXT,
  purged_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_recovery_project ON recovery_items(project_id, status);
CREATE INDEX idx_recovery_media ON recovery_items(media_id);

CREATE TABLE operation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info','warn','error')),
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  details TEXT
);
CREATE INDEX idx_oplog_project ON operation_log(project_id, ts);
`,
  /* 2: Index für effiziente Warteschlangenabfragen */ `
CREATE INDEX idx_items_job_status_seq ON job_items(job_id, status, seq);
`,
  /* 3: Sidecars, RAW+JPEG-Paare, Bewertungen, Ähnlichkeit, Reihenfolge in Paketen, Startverzögerung */ `
ALTER TABLE media ADD COLUMN role TEXT NOT NULL DEFAULT 'main' CHECK (role IN ('main','sidecar'));
ALTER TABLE media ADD COLUMN parent_id INTEGER REFERENCES media(id) ON DELETE CASCADE;
ALTER TABLE media ADD COLUMN pair_id INTEGER;
ALTER TABLE media ADD COLUMN rating INTEGER NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5);
ALTER TABLE media ADD COLUMN color_label TEXT CHECK (color_label IS NULL OR color_label IN ('red','yellow','green','blue','purple'));
ALTER TABLE media ADD COLUMN phash TEXT;
ALTER TABLE media ADD COLUMN sim_group INTEGER;
CREATE INDEX idx_media_parent ON media(parent_id);
ALTER TABLE media_packages ADD COLUMN position REAL NOT NULL DEFAULT 0;
UPDATE media_packages SET position = assigned_at;
CREATE INDEX idx_mp_pkg_pos ON media_packages(package_id, position);
ALTER TABLE jobs ADD COLUMN start_after INTEGER;
`
]

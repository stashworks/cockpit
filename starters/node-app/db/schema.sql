-- {{TITLE}}: one MySQL 8 database per environment ({{NAME}}_dev, {{NAME}}). Every module's tables live
-- here, prefixed with the module name (tasks_items, health_readings ...), so a module can be
-- removed by prefix and nothing else is touched (deletion sweeps satellites). Changes after the
-- first release go in db\migrations\ as dated files, applied in order and recorded below.
CREATE TABLE IF NOT EXISTS {{NAME}}_migrations (
  name        VARCHAR(120) PRIMARY KEY,
  applied_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS {{NAME}}_meta (
  k           VARCHAR(80) PRIMARY KEY,
  v           TEXT,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
INSERT INTO {{NAME}}_meta (k, v) VALUES ('schema', '0.1.0') ON DUPLICATE KEY UPDATE v = VALUES(v);

-- Radarly MySQL Schema Migration
-- Run this after creating the database on Hostinger hPanel

CREATE TABLE IF NOT EXISTS users (
  id                 CHAR(36)     NOT NULL DEFAULT (UUID()),
  name               VARCHAR(255) DEFAULT NULL,
  phone              VARCHAR(20)  NOT NULL DEFAULT '',
  email              VARCHAR(255) DEFAULT NULL,
  is_verified        TINYINT(1)   NOT NULL DEFAULT 0,
  session_token      CHAR(36)     DEFAULT NULL,
  session_expires_at DATETIME     DEFAULT NULL,
  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_users_session (session_token),
  INDEX idx_users_phone (phone),
  INDEX idx_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS phone_otps (
  phone      VARCHAR(20) NOT NULL,
  otp_code   VARCHAR(10) NOT NULL,
  expires_at DATETIME    NOT NULL,
  PRIMARY KEY (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stocks_master (
  symbol           VARCHAR(30)   NOT NULL,
  company_name     VARCHAR(255)  DEFAULT NULL,
  exchange         VARCHAR(10)   DEFAULT NULL,
  sector           VARCHAR(100)  DEFAULT NULL,
  industry         VARCHAR(100)  DEFAULT NULL,
  last_price       DECIMAL(12,2) DEFAULT NULL,
  price_updated_at DATETIME      DEFAULT NULL,
  is_active        TINYINT(1)    NOT NULL DEFAULT 1,
  PRIMARY KEY (symbol),
  INDEX idx_sm_sector (sector),
  INDEX idx_sm_exchange (exchange),
  INDEX idx_sm_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_stocks (
  user_id  CHAR(36)    NOT NULL,
  symbol   VARCHAR(30) NOT NULL,
  added_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, symbol),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (symbol)  REFERENCES stocks_master(symbol) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS corporate_actions (
  symbol       VARCHAR(30) NOT NULL,
  action_type  VARCHAR(30) NOT NULL,
  ex_date      DATE        NOT NULL,
  record_date  DATE        DEFAULT NULL,
  details      JSON        DEFAULT NULL,
  announced_at DATETIME    DEFAULT NULL,
  last_fetched DATETIME    DEFAULT NULL,
  PRIMARY KEY (symbol, action_type, ex_date),
  FOREIGN KEY (symbol) REFERENCES stocks_master(symbol) ON DELETE CASCADE,
  INDEX idx_ca_type (action_type),
  INDEX idx_ca_exdate (ex_date),
  INDEX idx_ca_fetched (last_fetched)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS alert_types (
  code        VARCHAR(30)  NOT NULL,
  name        VARCHAR(100) DEFAULT NULL,
  description VARCHAR(500) DEFAULT NULL,
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_alert_preferences (
  user_id    CHAR(36)    NOT NULL,
  alert_type VARCHAR(30) NOT NULL,
  scope      VARCHAR(30) NOT NULL DEFAULT 'all_stocks',
  is_enabled TINYINT(1)  NOT NULL DEFAULT 1,
  updated_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, alert_type),
  FOREIGN KEY (user_id)    REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (alert_type) REFERENCES alert_types(code) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS alert_log (
  user_id    CHAR(36)    NOT NULL,
  symbol     VARCHAR(30) NOT NULL,
  alert_type VARCHAR(30) NOT NULL,
  event_date DATE        NOT NULL,
  status     VARCHAR(20) NOT NULL DEFAULT 'sent',
  sent_at    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, symbol, alert_type, event_date),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_al_sent (sent_at),
  INDEX idx_al_symbol (symbol)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed alert types
INSERT INTO alert_types (code, name, description, is_active) VALUES
  ('DIVIDEND', 'Dividend Alert',  'Notifies when a stock has an upcoming ex-dividend date', 1),
  ('BONUS',    'Bonus Issue',     'Notifies when a stock has an upcoming bonus issue',      0),
  ('SPLIT',    'Stock Split',     'Notifies when a stock has an upcoming stock split',      0),
  ('BUYBACK',  'Buyback',         'Notifies when a stock has an upcoming buyback',          0);

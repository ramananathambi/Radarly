-- ──────────────────────────────────────────────────────────────────────────────
-- Radarly: Activate Bonus, Split, Buyback alert types
-- Run this on your existing Hostinger database via hPanel > phpMyAdmin
-- ──────────────────────────────────────────────────────────────────────────────

-- Step 1: Enable Bonus, Split and Buyback alert types
UPDATE alert_types
SET is_active = 1
WHERE code IN ('BONUS', 'SPLIT', 'BUYBACK');

-- Step 2: Add BONUS preference for existing users who don't have it yet
INSERT IGNORE INTO user_alert_preferences (user_id, alert_type, scope, is_enabled)
SELECT u.id, 'BONUS', 'all_stocks', 1
FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM user_alert_preferences uap
  WHERE uap.user_id = u.id AND uap.alert_type = 'BONUS'
);

-- Step 3: Add SPLIT preference for existing users
INSERT IGNORE INTO user_alert_preferences (user_id, alert_type, scope, is_enabled)
SELECT u.id, 'SPLIT', 'all_stocks', 1
FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM user_alert_preferences uap
  WHERE uap.user_id = u.id AND uap.alert_type = 'SPLIT'
);

-- Step 4: Add BUYBACK preference for existing users
INSERT IGNORE INTO user_alert_preferences (user_id, alert_type, scope, is_enabled)
SELECT u.id, 'BUYBACK', 'all_stocks', 1
FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM user_alert_preferences uap
  WHERE uap.user_id = u.id AND uap.alert_type = 'BUYBACK'
);

-- Verify: check active alert types
SELECT code, name, is_active FROM alert_types ORDER BY code;

-- Verify: check preference counts per type
SELECT alert_type, COUNT(*) AS user_count FROM user_alert_preferences GROUP BY alert_type;

-- ──────────────────────────────────────────────────────────────────────────────
-- Radarly: Activate Bonus, Split, Buyback alert types
-- Run each query one at a time in phpMyAdmin
-- ──────────────────────────────────────────────────────────────────────────────

-- Query 1: Enable Bonus, Split, Buyback alert types
UPDATE alert_types
SET is_active = 1
WHERE code IN ('BONUS', 'SPLIT', 'BUYBACK');

-- Query 2: Add BONUS preference for all existing users
-- INSERT IGNORE skips duplicates automatically (no NOT EXISTS needed)
INSERT IGNORE INTO user_alert_preferences (user_id, alert_type, scope, is_enabled)
SELECT id, 'BONUS', 'all_stocks', 1 FROM users;

-- Query 3: Add SPLIT preference for all existing users
INSERT IGNORE INTO user_alert_preferences (user_id, alert_type, scope, is_enabled)
SELECT id, 'SPLIT', 'all_stocks', 1 FROM users;

-- Query 4: Add BUYBACK preference for all existing users
INSERT IGNORE INTO user_alert_preferences (user_id, alert_type, scope, is_enabled)
SELECT id, 'BUYBACK', 'all_stocks', 1 FROM users;

-- Query 5: Verify results
SELECT alert_type, COUNT(*) AS user_count FROM user_alert_preferences GROUP BY alert_type;

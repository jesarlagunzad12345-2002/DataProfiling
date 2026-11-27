USE data_profiling_platform;

SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'profiling_records' AND COLUMN_NAME = 'normalized_values') = 0,
  'ALTER TABLE profiling_records ADD COLUMN normalized_values JSON NULL',
  'SELECT 1'
);
PREPARE phase8_statement FROM @sql;
EXECUTE phase8_statement;
DEALLOCATE PREPARE phase8_statement;

SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'profiling_records' AND COLUMN_NAME = 'normalized_company_hash') = 0,
  'ALTER TABLE profiling_records ADD COLUMN normalized_company_hash CHAR(64) NULL',
  'SELECT 1'
);
PREPARE phase8_statement FROM @sql;
EXECUTE phase8_statement;
DEALLOCATE PREPARE phase8_statement;

SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'profiling_records' AND COLUMN_NAME = 'normalized_name_hash') = 0,
  'ALTER TABLE profiling_records ADD COLUMN normalized_name_hash CHAR(64) NULL',
  'SELECT 1'
);
PREPARE phase8_statement FROM @sql;
EXECUTE phase8_statement;
DEALLOCATE PREPARE phase8_statement;

SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'profiling_records' AND COLUMN_NAME = 'normalized_address_hash') = 0,
  'ALTER TABLE profiling_records ADD COLUMN normalized_address_hash CHAR(64) NULL',
  'SELECT 1'
);
PREPARE phase8_statement FROM @sql;
EXECUTE phase8_statement;
DEALLOCATE PREPARE phase8_statement;

SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'profiling_records' AND INDEX_NAME = 'idx_profile_records_company') = 0,
  'ALTER TABLE profiling_records ADD INDEX idx_profile_records_company (run_id, normalized_company_hash)',
  'SELECT 1'
);
PREPARE phase8_statement FROM @sql;
EXECUTE phase8_statement;
DEALLOCATE PREPARE phase8_statement;

SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'profiling_records' AND INDEX_NAME = 'idx_profile_records_name') = 0,
  'ALTER TABLE profiling_records ADD INDEX idx_profile_records_name (run_id, normalized_name_hash)',
  'SELECT 1'
);
PREPARE phase8_statement FROM @sql;
EXECUTE phase8_statement;
DEALLOCATE PREPARE phase8_statement;

SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'profiling_records' AND INDEX_NAME = 'idx_profile_records_address') = 0,
  'ALTER TABLE profiling_records ADD INDEX idx_profile_records_address (run_id, normalized_address_hash)',
  'SELECT 1'
);
PREPARE phase8_statement FROM @sql;
EXECUTE phase8_statement;
DEALLOCATE PREPARE phase8_statement;

ALTER TABLE profiling_duplicate_groups
  MODIFY duplicate_type ENUM('exact', 'phone', 'email', 'near', 'company', 'contact', 'address', 'spelling', 'combined') NOT NULL,
  MODIFY fingerprint VARCHAR(128) NOT NULL;

SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'profiling_duplicate_groups' AND COLUMN_NAME = 'confidence_score') = 0,
  'ALTER TABLE profiling_duplicate_groups ADD COLUMN confidence_score DECIMAL(5,2) NOT NULL DEFAULT 0.00',
  'SELECT 1'
);
PREPARE phase8_statement FROM @sql;
EXECUTE phase8_statement;
DEALLOCATE PREPARE phase8_statement;

SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'profiling_duplicate_groups' AND COLUMN_NAME = 'confidence_label') = 0,
  'ALTER TABLE profiling_duplicate_groups ADD COLUMN confidence_label ENUM(''Exact Match'', ''High Confidence'', ''Medium Confidence'', ''Low Confidence'') NOT NULL DEFAULT ''Low Confidence''',
  'SELECT 1'
);
PREPARE phase8_statement FROM @sql;
EXECUTE phase8_statement;
DEALLOCATE PREPARE phase8_statement;

SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'profiling_duplicate_groups' AND COLUMN_NAME = 'matching_fields') = 0,
  'ALTER TABLE profiling_duplicate_groups ADD COLUMN matching_fields JSON NULL',
  'SELECT 1'
);
PREPARE phase8_statement FROM @sql;
EXECUTE phase8_statement;
DEALLOCATE PREPARE phase8_statement;

SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'profiling_duplicate_groups' AND COLUMN_NAME = 'different_fields') = 0,
  'ALTER TABLE profiling_duplicate_groups ADD COLUMN different_fields JSON NULL',
  'SELECT 1'
);
PREPARE phase8_statement FROM @sql;
EXECUTE phase8_statement;
DEALLOCATE PREPARE phase8_statement;

SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'profiling_duplicate_groups' AND COLUMN_NAME = 'reasons') = 0,
  'ALTER TABLE profiling_duplicate_groups ADD COLUMN reasons JSON NULL',
  'SELECT 1'
);
PREPARE phase8_statement FROM @sql;
EXECUTE phase8_statement;
DEALLOCATE PREPARE phase8_statement;

SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'profiling_duplicate_groups' AND COLUMN_NAME = 'status') = 0,
  'ALTER TABLE profiling_duplicate_groups ADD COLUMN status ENUM(''pending'', ''confirmed'', ''not_duplicate'', ''keep_both'') NOT NULL DEFAULT ''pending''',
  'SELECT 1'
);
PREPARE phase8_statement FROM @sql;
EXECUTE phase8_statement;
DEALLOCATE PREPARE phase8_statement;

SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'profiling_duplicate_groups' AND COLUMN_NAME = 'preferred_record_id') = 0,
  'ALTER TABLE profiling_duplicate_groups ADD COLUMN preferred_record_id BIGINT UNSIGNED NULL',
  'SELECT 1'
);
PREPARE phase8_statement FROM @sql;
EXECUTE phase8_statement;
DEALLOCATE PREPARE phase8_statement;

SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'profiling_duplicate_groups' AND COLUMN_NAME = 'reviewed_by') = 0,
  'ALTER TABLE profiling_duplicate_groups ADD COLUMN reviewed_by BIGINT UNSIGNED NULL',
  'SELECT 1'
);
PREPARE phase8_statement FROM @sql;
EXECUTE phase8_statement;
DEALLOCATE PREPARE phase8_statement;

SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'profiling_duplicate_groups' AND COLUMN_NAME = 'reviewed_at') = 0,
  'ALTER TABLE profiling_duplicate_groups ADD COLUMN reviewed_at TIMESTAMP NULL',
  'SELECT 1'
);
PREPARE phase8_statement FROM @sql;
EXECUTE phase8_statement;
DEALLOCATE PREPARE phase8_statement;

SET @sql = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'profiling_duplicate_groups' AND INDEX_NAME = 'idx_profile_duplicate_groups_status') = 0,
  'ALTER TABLE profiling_duplicate_groups ADD INDEX idx_profile_duplicate_groups_status (run_id, status)',
  'SELECT 1'
);
PREPARE phase8_statement FROM @sql;
EXECUTE phase8_statement;
DEALLOCATE PREPARE phase8_statement;

CREATE TABLE IF NOT EXISTS profiling_duplicate_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  group_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  action ENUM('confirmed', 'not_duplicate', 'keep_both', 'preferred_master') NOT NULL,
  preferred_record_id BIGINT UNSIGNED NULL,
  details_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_duplicate_audit_group_created (group_id, created_at),
  KEY idx_duplicate_audit_user_created (user_id, created_at),
  KEY idx_duplicate_audit_preferred (preferred_record_id)
) ENGINE=InnoDB;

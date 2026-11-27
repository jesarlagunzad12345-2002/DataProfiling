CREATE DATABASE IF NOT EXISTS data_profiling_platform
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

USE data_profiling_platform;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(50) NOT NULL,
  email VARCHAR(254) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS uploads (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  stored_name VARCHAR(41) NOT NULL,
  file_extension ENUM('xlsx', 'xls') NOT NULL,
  file_size BIGINT UNSIGNED NOT NULL,
  uploaded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_uploads_stored_name (stored_name),
  KEY idx_uploads_user_uploaded (user_id, uploaded_at),
  CONSTRAINT fk_uploads_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS worksheets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  upload_id BIGINT UNSIGNED NOT NULL,
  worksheet_index INT UNSIGNED NOT NULL,
  worksheet_name VARCHAR(255) NOT NULL,
  row_count INT UNSIGNED NOT NULL DEFAULT 0,
  column_count INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_worksheets_upload_index (upload_id, worksheet_index),
  CONSTRAINT fk_worksheets_upload FOREIGN KEY (upload_id) REFERENCES uploads (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS profiling_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  upload_id BIGINT UNSIGNED NOT NULL,
  worksheet_index INT UNSIGNED NOT NULL,
  status ENUM('queued', 'processing', 'completed', 'failed') NOT NULL DEFAULT 'queued',
  options_json JSON NOT NULL,
  total_records BIGINT UNSIGNED NOT NULL DEFAULT 0,
  complete_records BIGINT UNSIGNED NOT NULL DEFAULT 0,
  incomplete_records BIGINT UNSIGNED NOT NULL DEFAULT 0,
  missing_values BIGINT UNSIGNED NOT NULL DEFAULT 0,
  invalid_phone_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  suspicious_phone_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  duplicate_record_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  address_issue_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  country_inconsistency_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  column_count INT UNSIGNED NOT NULL DEFAULT 0,
  overall_completeness DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  processed_records BIGINT UNSIGNED NOT NULL DEFAULT 0,
  error_message VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP NULL,
  finished_at TIMESTAMP NULL,
  PRIMARY KEY (id),
  KEY idx_profile_runs_user_created (user_id, created_at),
  KEY idx_profile_runs_user_status_source (user_id, status, upload_id, worksheet_index, id),
  KEY idx_profile_runs_upload_sheet (upload_id, worksheet_index, created_at),
  CONSTRAINT fk_profile_runs_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_profile_runs_worksheet
    FOREIGN KEY (upload_id, worksheet_index)
    REFERENCES worksheets (upload_id, worksheet_index) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS profiling_columns (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id BIGINT UNSIGNED NOT NULL,
  column_index INT UNSIGNED NOT NULL,
  column_name VARCHAR(255) NOT NULL,
  missing_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  value_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  completeness_percent DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  PRIMARY KEY (id),
  UNIQUE KEY uq_profiling_columns_run_index (run_id, column_index),
  CONSTRAINT fk_profiling_columns_run FOREIGN KEY (run_id) REFERENCES profiling_runs (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS profiling_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id BIGINT UNSIGNED NOT NULL,
  excel_row_number INT UNSIGNED NOT NULL,
  original_values JSON NOT NULL,
  suggestions JSON NOT NULL,
  issues JSON NOT NULL,
  missing_count INT UNSIGNED NOT NULL DEFAULT 0,
  invalid_phone BOOLEAN NOT NULL DEFAULT FALSE,
  suspicious_phone BOOLEAN NOT NULL DEFAULT FALSE,
  address_issue BOOLEAN NOT NULL DEFAULT FALSE,
  country_inconsistent BOOLEAN NOT NULL DEFAULT FALSE,
  duplicate_exact BOOLEAN NOT NULL DEFAULT FALSE,
  duplicate_phone BOOLEAN NOT NULL DEFAULT FALSE,
  duplicate_email BOOLEAN NOT NULL DEFAULT FALSE,
  normalized_values JSON NULL,
  normalized_company_hash CHAR(64) NULL,
  normalized_name_hash CHAR(64) NULL,
  normalized_address_hash CHAR(64) NULL,
  exact_duplicate_hash CHAR(64) NULL,
  phone_duplicate_hash CHAR(64) NULL,
  email_duplicate_hash CHAR(64) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_profiling_records_run_row (run_id, excel_row_number),
  KEY idx_profile_records_exact (run_id, exact_duplicate_hash),
  KEY idx_profile_records_phone (run_id, phone_duplicate_hash),
  KEY idx_profile_records_email (run_id, email_duplicate_hash),
  KEY idx_profile_records_company (run_id, normalized_company_hash),
  KEY idx_profile_records_name (run_id, normalized_name_hash),
  KEY idx_profile_records_address (run_id, normalized_address_hash),
  CONSTRAINT fk_profiling_records_run FOREIGN KEY (run_id) REFERENCES profiling_runs (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS profiling_duplicate_groups (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id BIGINT UNSIGNED NOT NULL,
  duplicate_type ENUM('exact', 'phone', 'email', 'near', 'company', 'contact', 'address', 'spelling', 'combined') NOT NULL,
  fingerprint VARCHAR(128) NOT NULL,
  member_count BIGINT UNSIGNED NOT NULL,
  confidence_score DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  confidence_label ENUM('Exact Match', 'High Confidence', 'Medium Confidence', 'Low Confidence') NOT NULL DEFAULT 'Low Confidence',
  matching_fields JSON NULL,
  different_fields JSON NULL,
  reasons JSON NULL,
  status ENUM('pending', 'confirmed', 'not_duplicate', 'keep_both') NOT NULL DEFAULT 'pending',
  preferred_record_id BIGINT UNSIGNED NULL,
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at TIMESTAMP NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_profile_duplicate_group (run_id, duplicate_type, fingerprint),
  KEY idx_profile_duplicate_groups_run_type (run_id, duplicate_type),
  KEY idx_profile_duplicate_groups_status (run_id, status),
  CONSTRAINT fk_profile_duplicate_groups_run FOREIGN KEY (run_id) REFERENCES profiling_runs (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS profiling_duplicate_members (
  group_id BIGINT UNSIGNED NOT NULL,
  record_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (group_id, record_id),
  KEY idx_profile_duplicate_members_record (record_id),
  CONSTRAINT fk_profile_duplicate_members_group
    FOREIGN KEY (group_id) REFERENCES profiling_duplicate_groups (id) ON DELETE CASCADE,
  CONSTRAINT fk_profile_duplicate_members_record
    FOREIGN KEY (record_id) REFERENCES profiling_records (id) ON DELETE CASCADE
) ENGINE=InnoDB;

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

CREATE TABLE IF NOT EXISTS manipulation_jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  upload_id BIGINT UNSIGNED NOT NULL,
  working_name VARCHAR(41) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_manipulation_jobs_upload (upload_id),
  UNIQUE KEY uq_manipulation_jobs_working_name (working_name),
  KEY idx_manipulation_jobs_user_updated (user_id, updated_at),
  CONSTRAINT fk_manipulation_jobs_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_manipulation_jobs_upload FOREIGN KEY (upload_id) REFERENCES uploads (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS manipulation_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  worksheet_index INT UNSIGNED NOT NULL,
  operation VARCHAR(40) NOT NULL,
  parameters_json JSON NOT NULL,
  change_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  revision_before BIGINT UNSIGNED NOT NULL,
  revision_after BIGINT UNSIGNED NOT NULL,
  status ENUM('applied', 'undone') NOT NULL DEFAULT 'applied',
  undo_of_history_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_manipulation_history_user_created (user_id, created_at),
  KEY idx_manipulation_history_job_created (job_id, id),
  CONSTRAINT fk_manipulation_history_job FOREIGN KEY (job_id) REFERENCES manipulation_jobs (id) ON DELETE CASCADE,
  CONSTRAINT fk_manipulation_history_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_manipulation_history_undo
    FOREIGN KEY (undo_of_history_id) REFERENCES manipulation_history (id) ON DELETE SET NULL
) ENGINE=InnoDB;

ALTER TABLE manipulation_history
  MODIFY status ENUM('pending', 'partial', 'applied', 'undone') NOT NULL DEFAULT 'applied';

CREATE TABLE IF NOT EXISTS manipulation_cell_changes (
  history_id BIGINT UNSIGNED NOT NULL,
  cell_reference VARCHAR(16) NOT NULL,
  excel_row_number INT UNSIGNED NOT NULL,
  column_index INT UNSIGNED NOT NULL,
  original_value JSON NOT NULL,
  modified_value JSON NOT NULL,
  PRIMARY KEY (history_id, cell_reference),
  KEY idx_manipulation_changes_row_column (excel_row_number, column_index),
  CONSTRAINT fk_manipulation_changes_history
    FOREIGN KEY (history_id) REFERENCES manipulation_history (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS review_changes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  upload_id BIGINT UNSIGNED NOT NULL,
  worksheet_index INT UNSIGNED NOT NULL,
  cell_reference VARCHAR(16) NULL,
  excel_row_number INT UNSIGNED NOT NULL,
  column_index INT UNSIGNED NULL,
  column_name VARCHAR(255) NULL,
  original_value JSON NULL,
  proposed_value JSON NULL,
  details_json JSON NULL,
  reason VARCHAR(500) NOT NULL,
  source_type ENUM('profiling', 'word-manipulation') NOT NULL,
  source_key VARCHAR(180) NOT NULL,
  source_run_id BIGINT UNSIGNED NULL,
  source_record_id BIGINT UNSIGNED NULL,
  source_history_id BIGINT UNSIGNED NULL,
  is_actionable BOOLEAN NOT NULL DEFAULT TRUE,
  status ENUM('pending', 'requires_review', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_review_changes_source (user_id, upload_id, source_key),
  KEY idx_review_changes_user_status (user_id, status, created_at),
  KEY idx_review_changes_upload_status (user_id, upload_id, status, excel_row_number),
  KEY idx_review_changes_history (source_history_id),
  CONSTRAINT fk_review_changes_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_review_changes_upload FOREIGN KEY (upload_id) REFERENCES uploads (id) ON DELETE CASCADE,
  CONSTRAINT fk_review_changes_reviewer FOREIGN KEY (reviewed_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_review_changes_run FOREIGN KEY (source_run_id) REFERENCES profiling_runs (id) ON DELETE CASCADE,
  CONSTRAINT fk_review_changes_record FOREIGN KEY (source_record_id) REFERENCES profiling_records (id) ON DELETE CASCADE,
  CONSTRAINT fk_review_changes_history FOREIGN KEY (source_history_id) REFERENCES manipulation_history (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS review_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  review_change_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  upload_id BIGINT UNSIGNED NOT NULL,
  worksheet_index INT UNSIGNED NOT NULL,
  cell_reference VARCHAR(16) NULL,
  original_value JSON NULL,
  previous_proposed_value JSON NULL,
  proposed_value JSON NULL,
  previous_status ENUM('pending', 'requires_review', 'approved', 'rejected') NOT NULL,
  new_status ENUM('pending', 'requires_review', 'approved', 'rejected') NOT NULL,
  action ENUM('edited', 'approved', 'rejected') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_review_audit_change_created (review_change_id, created_at),
  KEY idx_review_audit_user_created (user_id, created_at),
  KEY idx_review_audit_upload_created (upload_id, created_at),
  CONSTRAINT fk_review_audit_change FOREIGN KEY (review_change_id) REFERENCES review_changes (id) ON DELETE CASCADE,
  CONSTRAINT fk_review_audit_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_review_audit_upload FOREIGN KEY (upload_id) REFERENCES uploads (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS excel_exports (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  upload_id BIGINT UNSIGNED NOT NULL,
  export_type ENUM('complete', 'incomplete', 'cleaned', 'original') NOT NULL,
  record_filter ENUM('all', 'complete', 'incomplete') NOT NULL DEFAULT 'all',
  stored_name VARCHAR(41) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  record_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  complete_count BIGINT UNSIGNED NULL,
  incomplete_count BIGINT UNSIGNED NULL,
  approved_change_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  rejected_change_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  worksheet_count INT UNSIGNED NOT NULL DEFAULT 0,
  column_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  file_deleted_at TIMESTAMP NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_excel_exports_stored_name (stored_name),
  KEY idx_excel_exports_user_created (user_id, created_at),
  KEY idx_excel_exports_expiry (expires_at),
  CONSTRAINT fk_excel_exports_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_excel_exports_upload FOREIGN KEY (upload_id) REFERENCES uploads (id) ON DELETE CASCADE
) ENGINE=InnoDB;
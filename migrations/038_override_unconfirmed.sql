ALTER TABLE altphones_migration_records ADD CONSTRAINT altphones_migration_records_override_classification_check
  CHECK (override_classification IN ('COMPLETED','CURRENT','IN_ARREARS','NOT_STARTED','CANCELLED','UNCONFIRMED'));

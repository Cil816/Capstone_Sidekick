-- Admin settings, API usage tracking, and the archive of deleted records.
-- Adds three new tables; existing tables and rows are not changed.
-- Safe to run more than once. Run manually in SSMS against sidekick_db
-- (local SQL Server Express and the AWS RDS database).
--
--   dbo.app_settings      Settings changed from the admin website (maintenance
--                         mode, turning AI or Maps features off, the monthly
--                         API budget). The server falls back to backend/.env
--                         values while this table is missing.
--   dbo.api_usage_daily   Calls to paid APIs (Gemini, Google Maps, email
--                         validation) counted per day, with an estimated cost,
--                         for the admin API usage page.
--   dbo.deleted_records   A copy of everything a user or an administrator
--                         deletes, kept for the number of days set in the admin
--                         settings (30 by default) and then removed for good.
USE [sidekick_db];
GO

IF OBJECT_ID(N'dbo.app_settings', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.app_settings (
    setting_key varchar(64) NOT NULL
      CONSTRAINT PK_app_settings PRIMARY KEY,
    setting_value nvarchar(1000) NOT NULL,
    updated_at datetime2(7) NOT NULL
      CONSTRAINT DF_app_settings_updated_at DEFAULT SYSUTCDATETIME(),
    updated_by nvarchar(128) NULL
  );
  PRINT 'dbo.app_settings was created.';
END
ELSE
  PRINT 'dbo.app_settings already exists; no changes were made.';
GO

IF OBJECT_ID(N'dbo.api_usage_daily', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.api_usage_daily (
    usage_date date NOT NULL,
    api_key varchar(40) NOT NULL,
    call_count int NOT NULL CONSTRAINT DF_api_usage_daily_calls DEFAULT 0,
    blocked_count int NOT NULL CONSTRAINT DF_api_usage_daily_blocked DEFAULT 0,
    input_tokens bigint NOT NULL CONSTRAINT DF_api_usage_daily_input DEFAULT 0,
    output_tokens bigint NOT NULL CONSTRAINT DF_api_usage_daily_output DEFAULT 0,
    est_cost_usd decimal(14, 6) NOT NULL CONSTRAINT DF_api_usage_daily_cost DEFAULT 0,
    CONSTRAINT PK_api_usage_daily PRIMARY KEY (usage_date, api_key)
  );
  PRINT 'dbo.api_usage_daily was created.';
END
ELSE
  PRINT 'dbo.api_usage_daily already exists; no changes were made.';
GO

IF OBJECT_ID(N'dbo.deleted_records', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.deleted_records (
    archive_id bigint IDENTITY(1,1) NOT NULL
      CONSTRAINT PK_deleted_records PRIMARY KEY,
    source_table varchar(64) NOT NULL,
    source_id nvarchar(128) NOT NULL,
    user_id int NULL,
    deleted_by_type varchar(16) NOT NULL,      -- 'user' or 'admin'
    deleted_by nvarchar(255) NULL,             -- user email or admin username
    reason nvarchar(255) NULL,
    record_json nvarchar(max) NOT NULL,        -- the full row as JSON (passwords removed)
    deleted_at datetime2(7) NOT NULL
      CONSTRAINT DF_deleted_records_deleted_at DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_deleted_records_by_type CHECK (deleted_by_type IN ('user', 'admin'))
  );
  CREATE INDEX IX_deleted_records_deleted_at ON dbo.deleted_records (deleted_at);
  CREATE INDEX IX_deleted_records_source ON dbo.deleted_records (source_table, deleted_at);
  PRINT 'dbo.deleted_records was created.';
END
ELSE
  PRINT 'dbo.deleted_records already exists; no changes were made.';
GO

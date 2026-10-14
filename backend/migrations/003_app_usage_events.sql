-- Records user sign-ins and chatbot messages for the admin Dashboard and Reports.
-- Stores only who, what kind of event, and when. Chat message text is never stored.
-- Safe to run more than once. Run manually in SSMS against sidekick_db.
USE [sidekick_db];
GO

IF OBJECT_ID(N'dbo.users', N'U') IS NULL
  THROW 50020, 'dbo.users does not exist in sidekick_db; app_usage_events was not created.', 1;

IF NOT EXISTS (
  SELECT 1
  FROM sys.columns c
  WHERE c.object_id = OBJECT_ID(N'dbo.users')
    AND c.name = N'user_id'
    AND c.system_type_id = TYPE_ID(N'int')
)
  THROW 50021, 'dbo.users.user_id is not int as expected by the backend; app_usage_events was not created.', 1;
GO

IF OBJECT_ID(N'dbo.app_usage_events', N'U') IS NOT NULL
BEGIN
  PRINT 'dbo.app_usage_events already exists; no changes were made.';
END
ELSE
BEGIN
  CREATE TABLE dbo.app_usage_events (
    event_id bigint IDENTITY(1,1) NOT NULL
      CONSTRAINT PK_app_usage_events PRIMARY KEY,
    user_id int NOT NULL,
    event_type varchar(32) NOT NULL,
    created_at datetime2(7) NOT NULL
      CONSTRAINT DF_app_usage_events_created_at DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_app_usage_events_type
      CHECK (event_type IN ('sign_in', 'chat_message')),
    -- Deleting an account removes its usage events too.
    CONSTRAINT FK_app_usage_events_users
      FOREIGN KEY (user_id) REFERENCES dbo.users(user_id) ON DELETE CASCADE
  );

  -- Dashboard totals and daily graphs.
  CREATE INDEX IX_app_usage_events_type_created
    ON dbo.app_usage_events (event_type, created_at)
    INCLUDE (user_id);

  -- Per-user counts on the Reports page.
  CREATE INDEX IX_app_usage_events_user_type_created
    ON dbo.app_usage_events (user_id, event_type, created_at);

  PRINT 'dbo.app_usage_events was created. Sign-ins and chatbot messages are recorded from now on; earlier history is not available.';
END;
GO

SELECT
  c.column_id,
  c.name AS column_name,
  TYPE_NAME(c.user_type_id) AS data_type,
  c.is_nullable
FROM sys.columns c
WHERE c.object_id = OBJECT_ID(N'dbo.app_usage_events')
ORDER BY c.column_id;
GO

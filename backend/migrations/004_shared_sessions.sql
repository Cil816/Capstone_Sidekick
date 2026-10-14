-- Stores login sessions in SQL Server so every backend server (for example, several
-- EC2 instances behind a load balancer) recognises the same logins.
-- Only a SHA-256 hash of each session token is stored, never the token itself.
-- Safe to run more than once. Run manually in SSMS against sidekick_db.
USE [sidekick_db];
GO

IF OBJECT_ID(N'dbo.users', N'U') IS NULL
  THROW 50030, 'dbo.users does not exist in sidekick_db; session tables were not created.', 1;

IF NOT EXISTS (
  SELECT 1
  FROM sys.columns c
  WHERE c.object_id = OBJECT_ID(N'dbo.users')
    AND c.name = N'user_id'
    AND c.system_type_id = TYPE_ID(N'int')
)
  THROW 50031, 'dbo.users.user_id is not int as expected by the backend; session tables were not created.', 1;
GO

-- Mobile app sessions (30-day logins).
IF OBJECT_ID(N'dbo.app_sessions', N'U') IS NOT NULL
BEGIN
  PRINT 'dbo.app_sessions already exists; no changes were made.';
END
ELSE
BEGIN
  CREATE TABLE dbo.app_sessions (
    token_hash char(64) NOT NULL
      CONSTRAINT PK_app_sessions PRIMARY KEY,
    user_id int NOT NULL,
    email nvarchar(255) NOT NULL,
    name nvarchar(150) NOT NULL
      CONSTRAINT DF_app_sessions_name DEFAULT N'',
    created_at datetime2(7) NOT NULL
      CONSTRAINT DF_app_sessions_created_at DEFAULT SYSUTCDATETIME(),
    expires_at datetime2(7) NOT NULL,
    -- Deleting an account signs it out everywhere.
    CONSTRAINT FK_app_sessions_users
      FOREIGN KEY (user_id) REFERENCES dbo.users(user_id) ON DELETE CASCADE
  );

  CREATE INDEX IX_app_sessions_user_id ON dbo.app_sessions (user_id);
  CREATE INDEX IX_app_sessions_expires_at ON dbo.app_sessions (expires_at);

  PRINT 'dbo.app_sessions was created.';
END;
GO

-- Admin website sessions (8-hour logins). Separate from dbo.admin_sessions in
-- database/admin, which belongs to an unused admin-accounts design.
IF OBJECT_ID(N'dbo.admin_api_sessions', N'U') IS NOT NULL
BEGIN
  PRINT 'dbo.admin_api_sessions already exists; no changes were made.';
END
ELSE
BEGIN
  CREATE TABLE dbo.admin_api_sessions (
    token_hash char(64) NOT NULL
      CONSTRAINT PK_admin_api_sessions PRIMARY KEY,
    username nvarchar(128) NOT NULL,
    role nvarchar(32) NOT NULL,
    created_at datetime2(7) NOT NULL
      CONSTRAINT DF_admin_api_sessions_created_at DEFAULT SYSUTCDATETIME(),
    expires_at datetime2(7) NOT NULL
  );

  CREATE INDEX IX_admin_api_sessions_expires_at ON dbo.admin_api_sessions (expires_at);

  PRINT 'dbo.admin_api_sessions was created.';
END;
GO

SELECT t.name AS table_name, c.name AS column_name, TYPE_NAME(c.user_type_id) AS data_type, c.is_nullable
FROM sys.tables t
JOIN sys.columns c ON c.object_id = t.object_id
WHERE t.name IN (N'app_sessions', N'admin_api_sessions')
ORDER BY t.name, c.column_id;
GO

USE [sidekick_db];
GO

IF OBJECT_ID(N'dbo.users', N'U') IS NULL
  THROW 50010, 'dbo.users does not exist in sidekick_db; last-active tracking was not added.', 1;

IF COL_LENGTH(N'dbo.users', N'user_id') IS NULL
  THROW 50011, 'dbo.users.user_id does not exist; last-active tracking was not added.', 1;

IF COL_LENGTH(N'dbo.users', N'last_active_at') IS NULL
BEGIN
  ALTER TABLE dbo.users
    ADD last_active_at datetime2(7) NOT NULL
      CONSTRAINT DF_users_last_active_at DEFAULT SYSUTCDATETIME();

  PRINT 'dbo.users.last_active_at was added. Existing users begin tracking from migration time; historical activity is not available.';
END
ELSE
BEGIN
  PRINT 'dbo.users.last_active_at already exists; no changes were made.';
END;
GO

SELECT user_id, last_active_at
FROM dbo.users
ORDER BY last_active_at DESC;
GO

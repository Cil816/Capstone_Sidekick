-- Creates a limited database login for the Sidekick backend, so the app does not
-- connect as "sa" (or the RDS master user), which can do anything on the server.
-- The new login can only read and write data in sidekick_db: no dropping tables,
-- no changing structure, no access to other databases.
--
-- 1. Replace CHANGE_ME_... below with a long random password (20+ characters).
-- 2. Run in SSMS as sa / the RDS master user, AFTER migrations 001-004.
-- 3. Set DB_USERNAME=sidekick_app and DB_PASSWORD=<that password> for the backend.
-- Keep using sa / the master user only for running future migration scripts.
-- Safe to run more than once.

DECLARE @password nvarchar(128) = N'CHANGE_ME_to_a_long_random_password';

IF @password LIKE N'CHANGE_ME%'
  THROW 50040, 'Set a real password in this script before running it.', 1;

IF LEN(@password) < 20
  THROW 50041, 'Use a password of at least 20 characters.', 1;

USE [master];

IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'sidekick_app')
BEGIN
  DECLARE @createLogin nvarchar(max) =
    N'CREATE LOGIN [sidekick_app] WITH PASSWORD = ' + QUOTENAME(@password, N'''') + N', CHECK_POLICY = ON, DEFAULT_DATABASE = [sidekick_db];';
  EXEC (@createLogin);
  PRINT 'Login sidekick_app was created.';
END
ELSE
BEGIN
  PRINT 'Login sidekick_app already exists; its password was not changed.';
END;

USE [sidekick_db];

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'sidekick_app')
BEGIN
  CREATE USER [sidekick_app] FOR LOGIN [sidekick_app];
  PRINT 'Database user sidekick_app was created.';
END;

-- Read and write rows only.
IF IS_ROLEMEMBER(N'db_datareader', N'sidekick_app') = 0
  ALTER ROLE db_datareader ADD MEMBER [sidekick_app];
IF IS_ROLEMEMBER(N'db_datawriter', N'sidekick_app') = 0
  ALTER ROLE db_datawriter ADD MEMBER [sidekick_app];

SELECT dp.name AS database_user, r.name AS role_name
FROM sys.database_role_members rm
JOIN sys.database_principals r ON r.principal_id = rm.role_principal_id
JOIN sys.database_principals dp ON dp.principal_id = rm.member_principal_id
WHERE dp.name = N'sidekick_app';
GO

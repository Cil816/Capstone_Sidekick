USE [sidekick_db];
GO

IF OBJECT_ID(N'dbo.app_reviews', N'U') IS NOT NULL
BEGIN
  PRINT 'dbo.app_reviews already exists; no changes were made.';
END
ELSE
BEGIN
  IF OBJECT_ID(N'dbo.users', N'U') IS NULL
    THROW 50001, 'dbo.users does not exist in sidekick_db; app_reviews was not created.', 1;

  IF COL_LENGTH(N'dbo.users', N'user_id') IS NULL
    THROW 50002, 'dbo.users.user_id does not exist; app_reviews was not created.', 1;

  IF NOT EXISTS (
    SELECT 1
    FROM sys.columns c
    WHERE c.object_id = OBJECT_ID(N'dbo.users')
      AND c.name = N'user_id'
      AND c.system_type_id = TYPE_ID(N'int')
  )
    THROW 50003, 'dbo.users.user_id is not int as expected by the current backend schema; app_reviews was not created.', 1;

  CREATE TABLE dbo.app_reviews (
    review_id int IDENTITY(1,1) NOT NULL
      CONSTRAINT PK_app_reviews PRIMARY KEY,
    user_id int NOT NULL,
    rating tinyint NOT NULL,
    review_text nvarchar(2000) NULL,
    created_at datetime2(7) NOT NULL
      CONSTRAINT DF_app_reviews_created_at DEFAULT SYSUTCDATETIME(),
    updated_at datetime2(7) NOT NULL
      CONSTRAINT DF_app_reviews_updated_at DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_app_reviews_rating CHECK (rating BETWEEN 1 AND 5),
    CONSTRAINT UQ_app_reviews_user_id UNIQUE (user_id),
    CONSTRAINT FK_app_reviews_users
      FOREIGN KEY (user_id) REFERENCES dbo.users(user_id)
  );

  PRINT 'dbo.app_reviews was created.';
END;
GO

SELECT
  s.name AS schema_name,
  t.name AS table_name,
  c.column_id,
  c.name AS column_name,
  TYPE_NAME(c.user_type_id) AS data_type,
  c.max_length,
  c.is_nullable,
  c.is_identity
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.columns c ON c.object_id = t.object_id
WHERE s.name = N'dbo'
  AND t.name = N'app_reviews'
ORDER BY c.column_id;
GO

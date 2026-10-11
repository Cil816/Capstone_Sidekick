USE sidekick_db;
GO

IF OBJECT_ID(N'dbo.admin_audit_log', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.admin_audit_log (
        audit_id BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_admin_audit_log PRIMARY KEY,
        admin_id INT NULL CONSTRAINT FK_admin_audit_admin_users FOREIGN KEY REFERENCES dbo.admin_users(admin_id),
        action_type NVARCHAR(80) NOT NULL,
        entity_type NVARCHAR(80) NULL,
        entity_id NVARCHAR(128) NULL,
        description NVARCHAR(4000) NULL,
        result NVARCHAR(32) NOT NULL CONSTRAINT DF_admin_audit_result DEFAULT 'success',
        reason NVARCHAR(4000) NULL,
        created_at DATETIME2 NOT NULL CONSTRAINT DF_admin_audit_created DEFAULT SYSUTCDATETIME(),
        ip_address NVARCHAR(64) NULL,
        user_agent NVARCHAR(512) NULL
    );
END;
GO

IF OBJECT_ID(N'dbo.admin_activity_log', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.admin_activity_log (
        activity_id BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_admin_activity_log PRIMARY KEY,
        admin_id INT NULL CONSTRAINT FK_admin_activity_admin_users FOREIGN KEY REFERENCES dbo.admin_users(admin_id),
        user_id INT NULL,
        trip_id INT NULL,
        event_type NVARCHAR(80) NOT NULL,
        details NVARCHAR(4000) NULL,
        created_at DATETIME2 NOT NULL CONSTRAINT DF_admin_activity_created DEFAULT SYSUTCDATETIME()
    );
END;
GO

IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes i
    WHERE i.object_id = OBJECT_ID(N'dbo.admin_audit_log')
      AND i.name = N'IX_admin_audit_log_created_at'
)
BEGIN
    CREATE INDEX IX_admin_audit_log_created_at
        ON dbo.admin_audit_log (created_at DESC);
END;
GO

IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes i
    WHERE i.object_id = OBJECT_ID(N'dbo.admin_activity_log')
      AND i.name = N'IX_admin_activity_log_created_at'
)
BEGIN
    CREATE INDEX IX_admin_activity_log_created_at
        ON dbo.admin_activity_log (created_at DESC);
END;
GO

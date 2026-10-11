USE sidekick_db;
GO

IF OBJECT_ID(N'dbo.admin_auth_audit_log', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.admin_auth_audit_log (
        audit_id BIGINT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_admin_auth_audit_log PRIMARY KEY,
        actor_username NVARCHAR(128) NULL,
        event_type NVARCHAR(80) NOT NULL,
        outcome NVARCHAR(32) NOT NULL,
        ip_address NVARCHAR(64) NULL,
        created_at DATETIME2(7) NOT NULL
            CONSTRAINT DF_admin_auth_audit_log_created_at DEFAULT SYSUTCDATETIME()
    );

    CREATE INDEX IX_admin_auth_audit_log_created_at
        ON dbo.admin_auth_audit_log (created_at DESC);
END;.
GO

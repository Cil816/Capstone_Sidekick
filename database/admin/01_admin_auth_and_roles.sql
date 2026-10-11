USE sidekick_db;
GO

IF OBJECT_ID(N'dbo.admin_users', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.admin_users (
        admin_id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_admin_users PRIMARY KEY,
        username NVARCHAR(64) NOT NULL,
        password_hash NVARCHAR(255) NOT NULL,
        full_name NVARCHAR(120) NULL,
        role NVARCHAR(32) NOT NULL CONSTRAINT DF_admin_users_role DEFAULT 'support',
        is_active BIT NOT NULL CONSTRAINT DF_admin_users_active DEFAULT 1,
        created_at DATETIME2 NOT NULL CONSTRAINT DF_admin_users_created DEFAULT SYSUTCDATETIME(),
        last_login_at DATETIME2 NULL,
        last_login_ip NVARCHAR(64) NULL,
        CONSTRAINT UQ_admin_users_username UNIQUE (username)
    );
END;
GO

IF OBJECT_ID(N'dbo.admin_sessions', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.admin_sessions (
        session_id UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_admin_sessions_session_id DEFAULT NEWID() CONSTRAINT PK_admin_sessions PRIMARY KEY,
        admin_id INT NOT NULL CONSTRAINT FK_admin_sessions_admin_users FOREIGN KEY REFERENCES dbo.admin_users(admin_id),
        token_hash NVARCHAR(255) NOT NULL,
        issued_at DATETIME2 NOT NULL CONSTRAINT DF_admin_sessions_issued_at DEFAULT SYSUTCDATETIME(),
        expires_at DATETIME2 NOT NULL,
        user_agent NVARCHAR(512) NULL,
        ip_address NVARCHAR(64) NULL
    );
END;
GO

IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes i
    WHERE i.object_id = OBJECT_ID(N'dbo.admin_sessions')
      AND i.name = N'IX_admin_sessions_admin_id_expires'
)
BEGIN
    CREATE INDEX IX_admin_sessions_admin_id_expires
        ON dbo.admin_sessions (admin_id, expires_at);
END;
GO

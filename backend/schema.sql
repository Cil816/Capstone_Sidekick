-- Run once against sidekick_db before starting the verification-enabled backend.

IF COL_LENGTH('dbo.users', 'is_verified') IS NULL
  ALTER TABLE dbo.users ADD is_verified bit NOT NULL CONSTRAINT DF_users_is_verified DEFAULT 0;

IF COL_LENGTH('dbo.users', 'terms_accepted') IS NULL
  ALTER TABLE dbo.users ADD terms_accepted bit NOT NULL CONSTRAINT DF_users_terms_accepted DEFAULT 0;

IF COL_LENGTH('dbo.users', 'terms_accepted_at') IS NULL
  ALTER TABLE dbo.users ADD terms_accepted_at datetime2(7) NULL;

IF COL_LENGTH('dbo.users', 'created_at') IS NULL
  ALTER TABLE dbo.users ADD created_at datetime2(7) NOT NULL CONSTRAINT DF_users_created_at DEFAULT SYSUTCDATETIME();

IF OBJECT_ID('dbo.otp_verifications', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.otp_verifications (
    otp_id int IDENTITY(1,1) NOT NULL PRIMARY KEY,
    user_id int NOT NULL,
    otp_code_hash varchar(64) NOT NULL,
    expires_at datetime2(7) NOT NULL,
    is_used bit NOT NULL CONSTRAINT DF_otp_is_used DEFAULT 0,
    created_at datetime2(7) NOT NULL CONSTRAINT DF_otp_created_at DEFAULT SYSUTCDATETIME(),
    resend_count int NOT NULL CONSTRAINT DF_otp_resend_count DEFAULT 0,
    verification_attempts int NOT NULL CONSTRAINT DF_otp_verification_attempts DEFAULT 0,
    CONSTRAINT FK_otp_verifications_users FOREIGN KEY (user_id) REFERENCES dbo.users(user_id)
  );

  CREATE INDEX IX_otp_verifications_user_id ON dbo.otp_verifications(user_id, created_at DESC);
END;
GO

-- Existing verified users should remain able to log in after this migration.
UPDATE dbo.users SET is_verified = 1 WHERE is_verified = 0 AND created_at < SYSUTCDATETIME();
GO

IF OBJECT_ID('dbo.app_reviews', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.app_reviews (
    review_id int IDENTITY(1,1) NOT NULL PRIMARY KEY,
    user_id int NOT NULL,
    rating tinyint NOT NULL,
    review_text nvarchar(2000) NULL,
    created_at datetime2(7) NOT NULL CONSTRAINT DF_app_reviews_created_at DEFAULT SYSUTCDATETIME(),
    updated_at datetime2(7) NOT NULL CONSTRAINT DF_app_reviews_updated_at DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_app_reviews_rating CHECK (rating BETWEEN 1 AND 5),
    CONSTRAINT UQ_app_reviews_user_id UNIQUE (user_id),
    CONSTRAINT FK_app_reviews_users FOREIGN KEY (user_id) REFERENCES dbo.users(user_id)
  );
END;
GO

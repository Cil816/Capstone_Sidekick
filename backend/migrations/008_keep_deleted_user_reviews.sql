-- 008: keep app ratings when a traveler deletes their own account.
-- The rating stays in the app's overall rating and on the admin Ratings page as
-- "Deleted user": its user_id is cleared, so it no longer points to any account.
-- Each account can still have only one rating (unique when user_id is set).
-- Safe to run more than once. Run on the local database and on AWS RDS (SSMS).
SET XACT_ABORT ON;
BEGIN TRANSACTION;

-- The old one-rating-per-account rule (a UNIQUE constraint or a unique index).
IF EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = N'UQ_app_reviews_user_id' AND parent_object_id = OBJECT_ID(N'dbo.app_reviews'))
    ALTER TABLE dbo.app_reviews DROP CONSTRAINT UQ_app_reviews_user_id;
ELSE IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UQ_app_reviews_user_id' AND object_id = OBJECT_ID(N'dbo.app_reviews') AND has_filter = 0)
    DROP INDEX UQ_app_reviews_user_id ON dbo.app_reviews;

-- A rating may now have no account (its author deleted their account).
IF COLUMNPROPERTY(OBJECT_ID(N'dbo.app_reviews'), N'user_id', 'AllowsNull') = 0
    ALTER TABLE dbo.app_reviews ALTER COLUMN user_id int NULL;

-- Still one rating per existing account.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UQ_app_reviews_user_id' AND object_id = OBJECT_ID(N'dbo.app_reviews'))
    EXEC(N'CREATE UNIQUE INDEX UQ_app_reviews_user_id ON dbo.app_reviews (user_id) WHERE user_id IS NOT NULL;');

COMMIT TRANSACTION;

SELECT COLUMNPROPERTY(OBJECT_ID(N'dbo.app_reviews'), N'user_id', 'AllowsNull') AS user_id_allows_null,
       (SELECT COUNT(*) FROM dbo.app_reviews) AS reviews;

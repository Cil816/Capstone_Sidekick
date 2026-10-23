-- 009: how often each place is used in travelers' saved trips, for Home's
-- "Popular destinations" (most-used first). Kept permanently: rows stay when trips
-- expire or are deleted. One place_usage row per place per trip, so editing and
-- re-saving a trip never counts a place twice.
-- Safe to run more than once. Run on the local database and on AWS RDS (SSMS).

IF OBJECT_ID(N'dbo.popular_places', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.popular_places (
        place_key      nvarchar(200) NOT NULL CONSTRAINT PK_popular_places PRIMARY KEY, -- 'id:' + Google place ID
        place_id       nvarchar(180) NULL,
        name           nvarchar(200) NOT NULL,
        address        nvarchar(300) NULL,
        latitude       decimal(9, 6) NULL,
        longitude      decimal(9, 6) NULL,
        photo_resource nvarchar(400) NULL,
        first_used_at  datetime2 NOT NULL CONSTRAINT DF_popular_places_first_used DEFAULT SYSUTCDATETIME(),
        last_used_at   datetime2 NOT NULL CONSTRAINT DF_popular_places_last_used DEFAULT SYSUTCDATETIME()
    );
END;

IF OBJECT_ID(N'dbo.place_usage', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.place_usage (
        place_key nvarchar(200) NOT NULL,
        trip_id   int NOT NULL,
        user_id   int NOT NULL,
        used_at   datetime2 NOT NULL CONSTRAINT DF_place_usage_used_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_place_usage PRIMARY KEY (place_key, trip_id)
    );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_place_usage_place_user' AND object_id = OBJECT_ID(N'dbo.place_usage'))
    CREATE INDEX IX_place_usage_place_user ON dbo.place_usage (place_key, user_id);

SELECT CASE WHEN OBJECT_ID(N'dbo.popular_places', N'U') IS NULL THEN 0 ELSE 1 END AS popular_places_ready,
       CASE WHEN OBJECT_ID(N'dbo.place_usage', N'U') IS NULL THEN 0 ELSE 1 END AS place_usage_ready;

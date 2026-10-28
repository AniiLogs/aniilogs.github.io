-- A public profile is listed for search engines (in the profiles sitemap, without "noindex") unless its owner turns
-- that off. A private profile is never listed.
ALTER TABLE profiles ADD COLUMN listed_in_search INTEGER NOT NULL DEFAULT 1;

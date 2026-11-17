-- Migration: 20261117_add_book_ownership.sql
-- Description: Adds is_owned boolean flag and partial index to user_books table

-- 1. Add the boolean ownership flag to user_books (defaults to false for existing records)
ALTER TABLE public.user_books 
ADD COLUMN IF NOT EXISTS is_owned BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Partial index for sub-millisecond filtering on owned books
CREATE INDEX IF NOT EXISTS idx_user_books_user_owned 
ON public.user_books (user_id) 
WHERE is_owned = TRUE;

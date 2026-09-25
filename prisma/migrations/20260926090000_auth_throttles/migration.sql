-- Limits on password and customer-link guessing.
--
--   A. auth_throttles: failed attempts per key — a staff sign-in name, a
--      customer link, or a network address — each stored only as a
--      SHA-256 hash, never as the email, phone or IP itself.
--   B. record_auth_failure(): counts one failure and, once a key reaches
--      its limit inside the window, locks it for a while. One statement
--      under the row lock, so parallel guesses can't slip past the count.
--
-- Additive: no existing table, column or row changes. Rows are temporary;
-- the function sweeps out anything idle for a day.

CREATE TABLE "auth_throttles" (
    "key" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "window_started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "locked_until" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "auth_throttles_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "auth_throttles_failures_check" CHECK ("failures" >= 0)
);

CREATE INDEX "auth_throttles_updated_at_idx" ON "auth_throttles"("updated_at");

-- Returns when the key is locked until, if this failure locked it; else NULL.
CREATE FUNCTION record_auth_failure(
    p_key TEXT,
    p_max_failures INTEGER,
    p_window INTERVAL,
    p_lockout INTERVAL
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
AS $$
DECLARE
    v_failures INTEGER;
    v_locked_until TIMESTAMPTZ;
BEGIN
    INSERT INTO auth_throttles AS t ("key", failures, window_started_at, updated_at)
    VALUES (p_key, 1, now(), now())
    ON CONFLICT ("key") DO UPDATE SET
        -- A window that has run out starts counting again from this failure.
        failures = CASE WHEN t.window_started_at < now() - p_window THEN 1 ELSE t.failures + 1 END,
        window_started_at = CASE WHEN t.window_started_at < now() - p_window THEN now() ELSE t.window_started_at END,
        updated_at = now()
    RETURNING failures INTO v_failures;

    IF v_failures >= p_max_failures THEN
        -- Locked, and the count starts afresh for when the lock lifts.
        UPDATE auth_throttles
        SET locked_until = now() + p_lockout, failures = 0, window_started_at = now()
        WHERE "key" = p_key
        RETURNING locked_until INTO v_locked_until;
    END IF;

    DELETE FROM auth_throttles
    WHERE updated_at < now() - INTERVAL '1 day'
      AND (locked_until IS NULL OR locked_until < now());

    RETURN v_locked_until;
END;
$$;

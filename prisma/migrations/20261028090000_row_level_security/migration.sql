-- Row-level security on every table.
--
-- The app connects as the tables' owner (postgres), which bypasses RLS, so
-- nothing it does changes. What changes is Supabase's public data API
-- (PostgREST): with RLS on and no policies, the anon and authenticated
-- roles can read and change nothing — before, every table without RLS was
-- open to anyone holding the project's public (anon) key.
--
-- No FORCE: forcing would apply RLS to the owner too and stop the app.
-- Tables added later get RLS from the event trigger below where the
-- database allows event triggers; tests/security.test.ts checks every table
-- either way.

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
  END LOOP;
END $$;

-- New tables in public get RLS the moment they are created.
CREATE OR REPLACE FUNCTION public.enable_rls_on_new_tables()
RETURNS event_trigger
LANGUAGE plpgsql
AS $$
DECLARE
  command record;
BEGIN
  FOR command IN
    SELECT * FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND schema_name = 'public'
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', command.object_identity);
  END LOOP;
END $$;

-- Creating an event trigger needs rights the hosted database may not give:
-- then the test is the safeguard.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'enable_rls_on_new_tables') THEN
    CREATE EVENT TRIGGER enable_rls_on_new_tables
      ON ddl_command_end
      WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      EXECUTE FUNCTION public.enable_rls_on_new_tables();
  END IF;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Event trigger not created (no permission); new tables need ENABLE ROW LEVEL SECURITY in their migration.';
END $$;

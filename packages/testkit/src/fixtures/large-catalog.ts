/**
 * The synthetic plan-guard catalog ([postgres-adapter.md §4](../../../../exponetdb-docs/03-database-model/postgres-adapter.md#4-introspection),
 * [schema-fingerprints.md §7](../../../../exponetdb-docs/03-database-model/schema-fingerprints.md#7-performance)):
 * at least 2,000 tables with indexes and row security, 1,000 policies,
 * 1,000 triggers,
 * partitioned tables, pgvector HNSW indexes, views and many functions, in
 * one schema. The idea is adopted from the pg-meta test suite of the
 * reference (gate record G4 §2.2); the generator is written here.
 *
 * Test setup only (run as a superuser; the DO blocks are fixture code, never
 * product SQL).
 */
export const LARGE_SCHEMA = 'big'

export interface LargeCatalogShape {
  readonly tables: number
  readonly partitionedParents: number
  readonly partitionsPerParent: number
  readonly vectorTables: number
  readonly views: number
  readonly functionsEvery: number
}

export const LARGE_CATALOG: LargeCatalogShape = {
  tables: 2000,
  partitionedParents: 20,
  partitionsPerParent: 10,
  vectorTables: 20,
  views: 100,
  functionsEvery: 10,
}

export function largeCatalogStatements(shape: LargeCatalogShape = LARGE_CATALOG): string[] {
  return [
    'CREATE EXTENSION IF NOT EXISTS vector',
    `CREATE SCHEMA ${LARGE_SCHEMA}`,
    `CREATE FUNCTION ${LARGE_SCHEMA}.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
    `DO $do$ DECLARE i int; BEGIN
       FOR i IN 1..${shape.tables} LOOP
         EXECUTE format('CREATE TABLE ${LARGE_SCHEMA}.t%s (id bigint PRIMARY KEY, tenant_id uuid NOT NULL, name text, payload jsonb, created_at timestamptz DEFAULT now())', i);
         EXECUTE format('CREATE INDEX t%s_tenant ON ${LARGE_SCHEMA}.t%s (tenant_id)', i, i);
         IF i % 2 = 0 THEN
           EXECUTE format('ALTER TABLE ${LARGE_SCHEMA}.t%s ENABLE ROW LEVEL SECURITY', i);
           EXECUTE format('CREATE POLICY p%s ON ${LARGE_SCHEMA}.t%s USING (tenant_id IS NOT NULL)', i, i);
         ELSE
           EXECUTE format('CREATE TRIGGER touch%s BEFORE UPDATE ON ${LARGE_SCHEMA}.t%s FOR EACH ROW EXECUTE FUNCTION ${LARGE_SCHEMA}.touch()', i, i);
         END IF;
         IF i % ${shape.functionsEvery} = 0 THEN
           EXECUTE format('CREATE FUNCTION ${LARGE_SCHEMA}.f%s(a integer) RETURNS integer LANGUAGE sql IMMUTABLE AS %L', i, 'SELECT a + ' || i);
         END IF;
       END LOOP;
     END $do$`,
    `DO $do$ DECLARE p int; c int; BEGIN
       FOR p IN 1..${shape.partitionedParents} LOOP
         EXECUTE format('CREATE TABLE ${LARGE_SCHEMA}.events%s (id bigint, at date NOT NULL, kind text) PARTITION BY RANGE (at)', p);
         FOR c IN 1..${shape.partitionsPerParent} LOOP
           EXECUTE format('CREATE TABLE ${LARGE_SCHEMA}.events%s_%s PARTITION OF ${LARGE_SCHEMA}.events%s FOR VALUES FROM (%L) TO (%L)',
             p, c, p, (date '2020-01-01' + (c - 1) * 30)::text, (date '2020-01-01' + c * 30)::text);
         END LOOP;
       END LOOP;
     END $do$`,
    `DO $do$ DECLARE v int; BEGIN
       FOR v IN 1..${shape.vectorTables} LOOP
         EXECUTE format('CREATE TABLE ${LARGE_SCHEMA}.vec%s (id bigint PRIMARY KEY, embedding vector(1024))', v);
         EXECUTE format('CREATE INDEX vec%s_hnsw ON ${LARGE_SCHEMA}.vec%s USING hnsw (embedding vector_cosine_ops)', v, v);
       END LOOP;
     END $do$`,
    `DO $do$ DECLARE v int; BEGIN
       FOR v IN 1..${shape.views} LOOP
         EXECUTE format('CREATE VIEW ${LARGE_SCHEMA}.view%s AS SELECT id, name FROM ${LARGE_SCHEMA}.t%s WHERE tenant_id IS NOT NULL', v, v);
       END LOOP;
     END $do$`,
    'ANALYZE',
  ]
}

/**
 * A schema of the size the fingerprint budget is set for
 * ([schema-fingerprints.md §7](../../../../exponetdb-docs/03-database-model/schema-fingerprints.md#7-performance):
 * about 400 tables, 380 policies, 1,400 indexes, 110 functions), with
 * foreign keys, triggers, views and grants, in one schema. Synthetic; the
 * numbers are the only thing taken from the consumer.
 */
export const CONSUMER_SCHEMA = 'sized'

export const CONSUMER_SIZED = {
  tables: 400,
  /** Tables with row security and two policies each (380 policies). */
  rowSecurityTables: 190,
  /** Three indexes per table plus a partial unique index on every second one (1,400). */
  indexes: 1400,
  /** SQL functions plus PL/pgSQL trigger functions (110). */
  functions: 110,
  views: 20,
} as const

export function consumerSizedStatements(): string[] {
  const s = CONSUMER_SCHEMA
  const c = CONSUMER_SIZED
  return [
    `CREATE SCHEMA ${s}`,
    `DO $do$ DECLARE i int; BEGIN
       FOR i IN 1..${c.tables} LOOP
         EXECUTE format('CREATE TABLE ${s}.t%s (id bigint PRIMARY KEY, tenant_id uuid NOT NULL, owner_id bigint, name text NOT NULL, status text NOT NULL DEFAULT %L, payload jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz)', i, 'active');
         EXECUTE format('CREATE INDEX t%s_tenant ON ${s}.t%s (tenant_id)', i, i);
         EXECUTE format('CREATE INDEX t%s_created ON ${s}.t%s (created_at DESC)', i, i);
         IF i % 2 = 0 THEN
           EXECUTE format('CREATE UNIQUE INDEX t%s_name ON ${s}.t%s (tenant_id, name) WHERE status <> %L', i, i, 'deleted');
         END IF;
         IF i % 4 = 0 THEN
           EXECUTE format('ALTER TABLE ${s}.t%s ADD CONSTRAINT t%s_owner FOREIGN KEY (owner_id) REFERENCES ${s}.t%s (id)', i, i, i - 1);
         END IF;
         IF i <= ${c.rowSecurityTables} THEN
           EXECUTE format('ALTER TABLE ${s}.t%s ENABLE ROW LEVEL SECURITY', i);
           EXECUTE format('CREATE POLICY t%s_read ON ${s}.t%s FOR SELECT USING (tenant_id = current_setting(%L, true)::uuid)', i, i, 'app.tenant_id');
           EXECUTE format('CREATE POLICY t%s_write ON ${s}.t%s FOR UPDATE USING (tenant_id = current_setting(%L, true)::uuid) WITH CHECK (status <> %L)', i, i, 'app.tenant_id', 'deleted');
         END IF;
       END LOOP;
     END $do$`,
    `DO $do$ DECLARE i int; BEGIN
       FOR i IN 1..100 LOOP
         EXECUTE format('CREATE FUNCTION ${s}.f%s(a bigint) RETURNS bigint LANGUAGE sql STABLE AS %L', i, 'SELECT a + ' || i);
       END LOOP;
       FOR i IN 1..10 LOOP
         EXECUTE format('CREATE FUNCTION ${s}.touch%s() RETURNS trigger LANGUAGE plpgsql AS %L', i, 'BEGIN NEW.updated_at := now(); RETURN NEW; END');
       END LOOP;
       FOR i IN 1..100 LOOP
         EXECUTE format('CREATE TRIGGER touch BEFORE UPDATE ON ${s}.t%s FOR EACH ROW EXECUTE FUNCTION ${s}.touch%s()', i * 4, 1 + i % 10);
       END LOOP;
       FOR i IN 1..${c.views} LOOP
         EXECUTE format('CREATE VIEW ${s}.v%s WITH (security_invoker = true) AS SELECT id, name FROM ${s}.t%s WHERE status = %L', i, i, 'active');
       END LOOP;
     END $do$`,
    `GRANT USAGE ON SCHEMA ${s} TO PUBLIC`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO PUBLIC`,
    'ANALYZE',
  ]
}

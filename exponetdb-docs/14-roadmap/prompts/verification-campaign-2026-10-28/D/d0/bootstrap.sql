-- D0 exploratory harness: mirrors packages/control-store/src/bootstrap-sql.ts (T d51da5d0) for a throwaway
-- PostgreSQL 17.11 container (d0-pg). Roles have no passwords: the harness connects through the container's
-- unix socket (docker exec ... psql -U <role>), never over the network.
\set ON_ERROR_STOP on
CREATE ROLE exdb_migrate; CREATE ROLE exdb_serve; CREATE ROLE exdb_worker; CREATE ROLE exdb_gateway; CREATE ROLE exdb_audit_maint;
ALTER ROLE exdb_migrate     WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE exdb_serve       WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE exdb_worker      WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE exdb_gateway     WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE exdb_audit_maint WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE DATABASE "exponetdb_control" WITH TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C';
REVOKE ALL ON DATABASE "exponetdb_control" FROM PUBLIC;
GRANT CONNECT, CREATE ON DATABASE "exponetdb_control" TO exdb_migrate;
GRANT CONNECT ON DATABASE "exponetdb_control" TO exdb_serve, exdb_worker, exdb_gateway, exdb_audit_maint;
ALTER ROLE exdb_migrate     IN DATABASE "exponetdb_control" SET search_path = '';
ALTER ROLE exdb_serve       IN DATABASE "exponetdb_control" SET search_path = '';
ALTER ROLE exdb_worker      IN DATABASE "exponetdb_control" SET search_path = '';
ALTER ROLE exdb_gateway     IN DATABASE "exponetdb_control" SET search_path = '';
ALTER ROLE exdb_audit_maint IN DATABASE "exponetdb_control" SET search_path = '';
\connect "exponetdb_control"
DROP SCHEMA IF EXISTS public;

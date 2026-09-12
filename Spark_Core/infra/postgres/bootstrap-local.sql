\set ON_ERROR_STOP on

select 'create role spark_owner nologin nosuperuser nocreatedb nocreaterole noinherit'
where not exists (select 1 from pg_roles where rolname = 'spark_owner')
\gexec

alter role spark_owner nologin nosuperuser nobypassrls nocreatedb nocreaterole noinherit noreplication;
alter role spark_owner reset all;

select format(
  'create role spark_migrator login password %L nosuperuser nocreatedb nocreaterole inherit',
  :'migrator_password'
)
where not exists (select 1 from pg_roles where rolname = 'spark_migrator')
\gexec

alter role spark_migrator login password :'migrator_password'
  nosuperuser nobypassrls nocreatedb nocreaterole inherit noreplication;
alter role spark_migrator reset all;

select format(
  'create role spark_app login password %L nosuperuser nocreatedb nocreaterole noinherit',
  :'app_password'
)
where not exists (select 1 from pg_roles where rolname = 'spark_app')
\gexec

alter role spark_app login password :'app_password'
  nosuperuser nobypassrls nocreatedb nocreaterole noinherit noreplication;
alter role spark_app reset all;
alter role spark_app set statement_timeout = '5s';
alter role spark_app set lock_timeout = '2s';
alter role spark_app set idle_in_transaction_session_timeout = '30s';

select format('revoke %I from %I', granted_role.rolname, member_role.rolname)
from pg_auth_members memberships
join pg_roles granted_role on granted_role.oid = memberships.roleid
join pg_roles member_role on member_role.oid = memberships.member
where
  (granted_role.rolname in ('spark_owner', 'spark_migrator', 'spark_app')
    or member_role.rolname in ('spark_owner', 'spark_migrator', 'spark_app'))
  and not (
    granted_role.rolname = 'spark_owner'
    and member_role.rolname = 'spark_migrator'
  )
\gexec

grant spark_owner to spark_migrator;

select 'create database spark owner spark_owner template template0 encoding ''UTF8'''
where not exists (select 1 from pg_database where datname = 'spark')
\gexec

alter database spark owner to spark_owner;

revoke all on database spark from public;
revoke all on database spark from spark_app, spark_migrator;
grant connect on database spark to spark_app, spark_migrator;

\connect spark

revoke create on schema public from public;
revoke all on schema public from spark_app, spark_migrator;
grant usage on schema public to spark_app;
grant usage, create on schema public to spark_migrator;

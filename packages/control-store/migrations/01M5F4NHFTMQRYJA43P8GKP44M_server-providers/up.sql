-- Where a server runs (owner decision of 2026-10-21; domain-model.md §3.2).
-- The list of the contract (`SERVER_PROVIDERS`, packages/contracts) grows
-- additively: the four values of the frozen registry bundle keep their
-- meaning, eighteen more are accepted. Only the CHECK changes; the rows that
-- exist already satisfy it.
ALTER TABLE registry.servers
  DROP CONSTRAINT servers_provider_check,
  ADD CONSTRAINT servers_provider_check
    CHECK (provider IN ('hetzner_cloud', 'hetzner_robot', 'other', 'unknown',
                        'aws', 'google_cloud', 'azure', 'oracle_cloud', 'ibm_cloud',
                        'alibaba_cloud', 'digitalocean', 'akamai_linode', 'vultr',
                        'upcloud', 'scaleway', 'exoscale', 'stackit', 'ovhcloud',
                        'ionos', 'netcup', 'contabo', 'on_premises'));

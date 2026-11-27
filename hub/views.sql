-- Views, recreated by ingest.py after the columns are migrated, in one transaction so readers never miss one.
BEGIN;
DROP VIEW IF EXISTS agent_cost;
DROP VIEW IF EXISTS run_summary;
DROP VIEW IF EXISTS role_value;

CREATE VIEW agent_cost AS
SELECT a.*, p.name AS project,
       round((a.input * pr.input + a.cache_write * pr.cache_write
            + a.cache_read * pr.cache_read + a.output * pr.output) / 1e6, 4) AS usd
FROM agent_run a
LEFT JOIN project p ON p.id = a.project_id
LEFT JOIN price pr ON pr.model = a.model;

CREATE VIEW run_summary AS
SELECT r.id, p.name AS project, r.task, r.title, r.started, date(r.started) AS day, r.outcome, r.rounds,
       (SELECT count(*) FROM finding f WHERE f.run_id = r.id AND f.blocking) AS blocking,
       (SELECT count(*) FROM finding f WHERE f.run_id = r.id AND NOT f.blocking) AS nits,
       (SELECT count(*) FROM gate_run g WHERE g.run_id = r.id AND NOT g.passed) AS gate_failures,
       (SELECT round(sum(usd), 2) FROM agent_cost c WHERE c.run_id = r.id) AS usd,
       (SELECT sum(input + cache_write + cache_read + output) FROM agent_run a WHERE a.run_id = r.id) AS tokens,
       (SELECT count(*) FROM finding f WHERE f.run_id = r.id AND f.blocking AND f.duplicate_of IS NOT NULL) AS duplicates,
       (SELECT count(*) FROM finding f WHERE f.run_id = r.id AND f.blocking AND f.evidence IS NOT NULL
                                             AND f.evidence <> '') AS with_evidence,
       (SELECT count(*) FROM gate_run g WHERE g.run_id = r.id AND g.round = 0 AND NOT g.passed) = 0 AS gate_first_pass,
       (SELECT count(*) FROM incident i WHERE i.run_id = r.id) AS incidents,
       round((julianday(r.ended) - julianday(r.started)) * 1440, 1) AS minutes,
       r.loop_version, r.mutation_score, r.mutation_survived, r.scan_findings, r.weakening_hits, r.parent, r.split,
       pm.merged, pm.drift_lines, pm.class AS post_merge_class
FROM run r
JOIN project p ON p.id = r.project_id
LEFT JOIN post_merge pm ON pm.run_id = r.id;

CREATE VIEW role_value AS
SELECT p.name AS project, f.role,
       count(*) FILTER (WHERE f.blocking) AS blocking,
       count(*) FILTER (WHERE f.outcome = 'fixed') AS fixed,
       count(*) FILTER (WHERE f.outcome = 'rejected-upheld') AS false_positive,
       count(*) FILTER (WHERE f.duplicate_of IS NOT NULL) AS duplicate,
       count(*) FILTER (WHERE NOT f.blocking) AS nits
FROM finding f
JOIN run r ON r.id = f.run_id
JOIN project p ON p.id = r.project_id
GROUP BY p.name, f.role;

COMMIT;

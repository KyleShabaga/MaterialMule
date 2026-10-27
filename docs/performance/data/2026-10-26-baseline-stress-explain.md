# EXPLAIN (ANALYZE, BUFFERS): materialmule_test_t19

Seed 20261025, 5 draws per request kind, run 2026-10-26T21:51:43.808Z.
Database execution time per request (all statements of the endpoint), warm cache.

| Request kind                             | median ms | max ms |
| ---------------------------------------- | --------: | -----: |
| inventory: search two words              |     111.3 |  232.1 |
| inventory: search test hole              |      12.2 |   86.0 |
| inventory: search ID fragment            |      59.2 |   80.1 |
| inventory: search one common word        |      21.2 |   27.8 |
| inventory: filter type + status          |       9.5 |   12.1 |
| inventory: all statuses by ID, deep page |       6.3 |    6.9 |
| inventory: search + type + dates         |       5.4 |    6.2 |
| inventory: default view, later page      |       5.2 |    5.6 |
| inventory: default view                  |       5.4 |    5.6 |
| inventory: search project number         |       1.5 |    1.8 |
| inventory: filter location               |       0.6 |    0.9 |
| inventory: filter received dates         |       0.4 |    0.5 |
| inventory: filter project                |       0.4 |    0.4 |
| inventory: filter project + test hole    |       0.2 |    0.3 |
| detail: storage unit                     |       0.1 |    0.2 |
| detail: print history                    |       0.1 |    0.1 |
| detail: history page 1                   |       0.1 |    0.1 |
| lookup: scan storage unit ID             |       0.0 |    0.0 |

## inventory: search two words (slowest draw)

```sql
SELECT count(*)::int AS total FROM storage_unit su JOIN storage_unit_search s ON s.storage_unit_id = su.id WHERE s.document LIKE $1 AND s.document LIKE $2 AND su.status <> 'disposed'
```

```text
Aggregate  (cost=5507.69..5507.71 rows=1 width=4) (actual time=12.124..12.128 rows=1 loops=1)
  Buffers: shared hit=2827
  ->  Hash Join  (cost=1741.50..5506.83 rows=346 width=0) (actual time=1.624..12.109 rows=368 loops=1)
        Hash Cond: (su.id = s.storage_unit_id)
        Buffers: shared hit=2827
        ->  Seq Scan on storage_unit su  (cost=0.00..3638.06 rows=48482 width=16) (actual time=0.008..8.467 rows=48449 loops=1)
              Filter: (status <> 'disposed'::text)
              Rows Removed by Filter: 51556
              Buffers: shared hit=2388
        ->  Hash  (cost=1732.58..1732.58 rows=714 width=16) (actual time=1.607..1.609 rows=840 loops=1)
              Buckets: 1024  Batches: 1  Memory Usage: 48kB
              Buffers: shared hit=439
              ->  Bitmap Heap Scan on storage_unit_search s  (cost=130.98..1732.58 rows=714 width=16) (actual time=1.135..1.561 rows=840 loops=1)
                    Recheck Cond: ((document ~~ '%tamarack%'::text) AND (document ~~ '%hill%'::text))
                    Heap Blocks: exact=330
                    Buffers: shared hit=439
                    ->  Bitmap Index Scan on storage_unit_search_document_trgm_idx  (cost=0.00..130.80 rows=714 width=0) (actual time=1.109..1.109 rows=840 loops=1)
                          Index Cond: ((document ~~ '%tamarack%'::text) AND (document ~~ '%hill%'::text))
                          Buffers: shared hit=109
Planning:
  Buffers: shared hit=18
Planning Time: 0.274 ms
Execution Time: 12.210 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name FROM (SELECT su.id FROM storage_unit su JOIN storage_unit_search s ON s.storage_unit_id = su.id WHERE s.document LIKE $1 AND s.document LIKE $2 AND su.status <> 'disposed' ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC LIMIT $3 OFFSET $4) page JOIN storage_unit su ON su.id = page.id JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC
```

```text
Sort  (cost=3022.23..3022.29 rows=25 width=247) (actual time=212.633..219.546 rows=25 loops=1)
  Sort Key: su.received_date DESC, su.readable_id COLLATE "C" DESC
  Sort Method: quicksort  Memory: 30kB
  Buffers: shared hit=166137
  ->  Hash Join  (cost=1072.73..3021.65 rows=25 width=247) (actual time=212.499..219.533 rows=25 loops=1)
        Hash Cond: (su.current_location_id = l.id)
        Buffers: shared hit=166137
        ->  Nested Loop  (cost=1070.81..3019.53 rows=25 width=155) (actual time=212.471..219.495 rows=25 loops=1)
              Buffers: shared hit=166136
              ->  Nested Loop  (cost=1070.53..3011.89 rows=25 width=84) (actual time=212.463..219.454 rows=25 loops=1)
                    Buffers: shared hit=166061
                    ->  Limit  (cost=1070.11..2800.77 rows=25 width=52) (actual time=212.450..219.361 rows=25 loops=1)
                          Buffers: shared hit=165961
                          ->  Incremental Sort  (cost=1070.11..25022.38 rows=346 width=52) (actual time=212.449..219.358 rows=25 loops=1)
                                Sort Key: su_1.received_date DESC, ((su_1.readable_id)::text) COLLATE "C" DESC
                                Presorted Key: su_1.received_date
                                Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 26kB  Peak Memory: 26kB
                                Buffers: shared hit=165961
                                ->  Gather Merge  (cost=1000.72..25006.81 rows=346 width=52) (actual time=211.684..219.342 rows=28 loops=1)
                                      Workers Planned: 1
                                      Workers Launched: 1
                                      Buffers: shared hit=165961
                                      ->  Nested Loop  (cost=0.71..23967.87 rows=204 width=52) (actual time=1.502..41.277 rows=133 loops=2)
                                            Buffers: shared hit=165961
                                            ->  Parallel Index Scan Backward using storage_unit_received_date_idx on storage_unit su_1  (cost=0.29..4012.41 rows=28519 width=35) (actual time=0.024..9.160 rows=20170 loops=2)
                                                  Filter: (status <> 'disposed'::text)
                                                  Rows Removed by Filter: 18340
                                                  Buffers: shared hit=4600
                                            ->  Index Scan using storage_unit_search_pkey on storage_unit_search s  (cost=0.42..0.70 rows=1 width=16) (actual time=0.002..0.002 rows=0 loops=40340)
                                                  Index Cond: (storage_unit_id = su_1.id)
                                                  Filter: ((document ~~ '%tamarack%'::text) AND (document ~~ '%hill%'::text))
                                                  Rows Removed by Filter: 1
                                                  Buffers: shared hit=161361
                    ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.42..8.44 rows=1 width=84) (actual time=0.003..0.003 rows=1 loops=25)
                          Index Cond: (id = su_1.id)
                          Buffers: shared hit=100
              ->  Index Scan using project_pkey on project p  (cost=0.28..0.31 rows=1 width=87) (actual time=0.001..0.001 rows=1 loops=25)
                    Index Cond: (id = su.project_id)
                    Buffers: shared hit=75
        ->  Hash  (cost=1.41..1.41 rows=41 width=44) (actual time=0.019..0.020 rows=41 loops=1)
              Buckets: 1024  Batches: 1  Memory Usage: 12kB
              Buffers: shared hit=1
              ->  Seq Scan on location l  (cost=0.00..1.41 rows=41 width=44) (actual time=0.009..0.012 rows=41 loops=1)
                    Buffers: shared hit=1
Planning:
  Buffers: shared hit=39
Planning Time: 0.548 ms
Execution Time: 219.598 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=552.66..552.76 rows=41 width=125) (actual time=0.218..0.220 rows=37 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 29kB
  Buffers: shared hit=195
  ->  Nested Loop  (cost=111.23..551.56 rows=41 width=125) (actual time=0.108..0.175 rows=37 loops=1)
        Buffers: shared hit=195
        ->  Bitmap Heap Scan on storage_unit_hole_summary h  (cost=110.95..259.15 rows=41 width=93) (actual time=0.096..0.107 rows=37 loops=1)
              Recheck Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
              Heap Blocks: exact=9
              Buffers: shared hit=84
              ->  Bitmap Index Scan on summary_one_per_hole_key  (cost=0.00..110.88 rows=41 width=0) (actual time=0.083..0.084 rows=37 loops=1)
                    Index Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
                    Buffers: shared hit=75
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..7.13 rows=1 width=32) (actual time=0.001..0.001 rows=1 loops=37)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=111
Planning:
  Buffers: shared hit=12
Planning Time: 0.274 ms
Execution Time: 0.252 ms
```

## inventory: search test hole (slowest draw)

```sql
SELECT count(*)::int AS total FROM storage_unit su JOIN storage_unit_search s ON s.storage_unit_id = su.id WHERE s.document LIKE $1 AND su.status <> 'disposed'
```

```text
Aggregate  (cost=5820.06..5820.07 rows=1 width=4) (actual time=19.095..19.099 rows=1 loops=1)
  Buffers: shared hit=2895
  ->  Hash Join  (cost=2053.50..5818.83 rows=490 width=0) (actual time=10.119..19.064 rows=652 loops=1)
        Hash Cond: (su.id = s.storage_unit_id)
        Buffers: shared hit=2895
        ->  Seq Scan on storage_unit su  (cost=0.00..3638.06 rows=48482 width=16) (actual time=0.044..13.655 rows=48449 loops=1)
              Filter: (status <> 'disposed'::text)
              Rows Removed by Filter: 51556
              Buffers: shared hit=2388
        ->  Hash  (cost=2040.88..2040.88 rows=1010 width=16) (actual time=2.234..2.237 rows=1835 loops=1)
              Buckets: 2048 (originally 1024)  Batches: 1 (originally 1)  Memory Usage: 103kB
              Buffers: shared hit=507
              ->  Bitmap Heap Scan on storage_unit_search s  (cost=85.84..2040.88 rows=1010 width=16) (actual time=0.836..2.063 rows=1835 loops=1)
                    Recheck Cond: (document ~~ '%tp22-01%'::text)
                    Rows Removed by Index Recheck: 208
                    Heap Blocks: exact=463
                    Buffers: shared hit=507
                    ->  Bitmap Index Scan on storage_unit_search_document_trgm_idx  (cost=0.00..85.59 rows=1010 width=0) (actual time=0.786..0.786 rows=2043 loops=1)
                          Index Cond: (document ~~ '%tp22-01%'::text)
                          Buffers: shared hit=44
Planning:
  Buffers: shared hit=18
Planning Time: 0.602 ms
Execution Time: 19.222 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name FROM (SELECT su.id FROM storage_unit su JOIN storage_unit_search s ON s.storage_unit_id = su.id WHERE s.document LIKE $1 AND su.status <> 'disposed' ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC LIMIT $2 OFFSET $3) page JOIN storage_unit su ON su.id = page.id JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC
```

```text
Sort  (cost=2255.04..2255.11 rows=25 width=247) (actual time=66.405..66.408 rows=25 loops=1)
  Sort Key: su.received_date DESC, su.readable_id COLLATE "C" DESC
  Sort Method: quicksort  Memory: 30kB
  Buffers: shared hit=98146
  ->  Nested Loop  (cost=79.78..2254.46 rows=25 width=247) (actual time=66.215..66.372 rows=25 loops=1)
        Buffers: shared hit=98146
        ->  Nested Loop  (cost=79.64..2250.41 rows=25 width=155) (actual time=66.205..66.341 rows=25 loops=1)
              Buffers: shared hit=98096
              ->  Nested Loop  (cost=79.36..2242.78 rows=25 width=84) (actual time=66.192..66.277 rows=25 loops=1)
                    Buffers: shared hit=98021
                    ->  Limit  (cost=78.94..2031.65 rows=25 width=52) (actual time=66.178..66.181 rows=25 loops=1)
                          Buffers: shared hit=97921
                          ->  Incremental Sort  (cost=78.94..38352.06 rows=490 width=52) (actual time=66.177..66.178 rows=25 loops=1)
                                Sort Key: su_1.received_date DESC, ((su_1.readable_id)::text) COLLATE "C" DESC
                                Presorted Key: su_1.received_date
                                Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 26kB  Peak Memory: 26kB
                                Buffers: shared hit=97921
                                ->  Nested Loop  (cost=0.71..38330.01 rows=490 width=52) (actual time=65.597..66.158 rows=26 loops=1)
                                      Buffers: shared hit=97921
                                      ->  Index Scan Backward using storage_unit_received_date_idx on storage_unit su_1  (cost=0.29..4527.14 rows=48482 width=35) (actual time=0.012..9.580 rows=24027 loops=1)
                                            Filter: (status <> 'disposed'::text)
                                            Rows Removed by Filter: 6632
                                            Buffers: shared hit=1813
                                      ->  Index Scan using storage_unit_search_pkey on storage_unit_search s  (cost=0.42..0.70 rows=1 width=16) (actual time=0.002..0.002 rows=0 loops=24027)
                                            Index Cond: (storage_unit_id = su_1.id)
                                            Filter: (document ~~ '%tp22-01%'::text)
                                            Rows Removed by Filter: 1
                                            Buffers: shared hit=96108
                    ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.42..8.44 rows=1 width=84) (actual time=0.003..0.003 rows=1 loops=25)
                          Index Cond: (id = su_1.id)
                          Buffers: shared hit=100
              ->  Index Scan using project_pkey on project p  (cost=0.28..0.31 rows=1 width=87) (actual time=0.002..0.002 rows=1 loops=25)
                    Index Cond: (id = su.project_id)
                    Buffers: shared hit=75
        ->  Index Scan using location_pkey on location l  (cost=0.14..0.16 rows=1 width=44) (actual time=0.001..0.001 rows=1 loops=25)
              Index Cond: (id = su.current_location_id)
              Buffers: shared hit=50
Planning:
  Buffers: shared hit=39
Planning Time: 0.787 ms
Execution Time: 66.465 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=552.66..552.76 rows=41 width=125) (actual time=0.265..0.267 rows=40 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 29kB
  Buffers: shared hit=205
  ->  Nested Loop  (cost=111.23..551.56 rows=41 width=125) (actual time=0.117..0.219 rows=40 loops=1)
        Buffers: shared hit=205
        ->  Bitmap Heap Scan on storage_unit_hole_summary h  (cost=110.95..259.15 rows=41 width=93) (actual time=0.108..0.124 rows=40 loops=1)
              Recheck Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
              Heap Blocks: exact=13
              Buffers: shared hit=85
              ->  Bitmap Index Scan on summary_one_per_hole_key  (cost=0.00..110.88 rows=41 width=0) (actual time=0.091..0.091 rows=40 loops=1)
                    Index Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
                    Buffers: shared hit=72
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..7.13 rows=1 width=32) (actual time=0.002..0.002 rows=1 loops=40)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=120
Planning:
  Buffers: shared hit=12
Planning Time: 0.282 ms
Execution Time: 0.302 ms
```

## inventory: search ID fragment (slowest draw)

```sql
SELECT count(*)::int AS total FROM storage_unit su JOIN storage_unit_search s ON s.storage_unit_id = su.id WHERE s.document LIKE $1 AND su.status <> 'disposed'
```

```text
Aggregate  (cost=6553.04..6553.05 rows=1 width=4) (actual time=13.054..13.057 rows=1 loops=1)
  Buffers: shared hit=2742
  ->  Hash Join  (cost=2785.26..6550.59 rows=979 width=0) (actual time=6.214..13.042 rows=376 loops=1)
        Hash Cond: (su.id = s.storage_unit_id)
        Buffers: shared hit=2742
        ->  Seq Scan on storage_unit su  (cost=0.00..3638.06 rows=48482 width=16) (actual time=0.008..7.464 rows=48449 loops=1)
              Filter: (status <> 'disposed'::text)
              Rows Removed by Filter: 51556
              Buffers: shared hit=2388
        ->  Hash  (cost=2760.01..2760.01 rows=2020 width=16) (actual time=3.812..3.813 rows=1000 loops=1)
              Buckets: 2048  Batches: 1  Memory Usage: 63kB
              Buffers: shared hit=354
              ->  Bitmap Heap Scan on storage_unit_search s  (cost=167.56..2760.01 rows=2020 width=16) (actual time=3.589..3.737 rows=1000 loops=1)
                    Recheck Cond: (document ~~ '%bkt-2019-004%'::text)
                    Rows Removed by Index Recheck: 243
                    Heap Blocks: exact=122
                    Buffers: shared hit=354
                    ->  Bitmap Index Scan on storage_unit_search_document_trgm_idx  (cost=0.00..167.05 rows=2020 width=0) (actual time=3.477..3.477 rows=1243 loops=1)
                          Index Cond: (document ~~ '%bkt-2019-004%'::text)
                          Buffers: shared hit=232
Planning:
  Buffers: shared hit=18
Planning Time: 0.247 ms
Execution Time: 13.148 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name FROM (SELECT su.id FROM storage_unit su JOIN storage_unit_search s ON s.storage_unit_id = su.id WHERE s.document LIKE $1 AND su.status <> 'disposed' ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC LIMIT $2 OFFSET $3) page JOIN storage_unit su ON su.id = page.id JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC
```

```text
Sort  (cost=1242.17..1242.24 rows=25 width=247) (actual time=66.701..66.703 rows=25 loops=1)
  Sort Key: su.received_date DESC, su.readable_id COLLATE "C" DESC
  Sort Method: quicksort  Memory: 30kB
  Buffers: shared hit=160101
  ->  Nested Loop  (cost=40.71..1241.59 rows=25 width=247) (actual time=66.583..66.692 rows=25 loops=1)
        Buffers: shared hit=160101
        ->  Nested Loop  (cost=40.57..1237.54 rows=25 width=155) (actual time=66.574..66.670 rows=25 loops=1)
              Buffers: shared hit=160051
              ->  Nested Loop  (cost=40.29..1229.91 rows=25 width=84) (actual time=66.566..66.622 rows=25 loops=1)
                    Buffers: shared hit=159976
                    ->  Limit  (cost=39.87..1018.78 rows=25 width=52) (actual time=66.552..66.555 rows=25 loops=1)
                          Buffers: shared hit=159876
                          ->  Incremental Sort  (cost=39.87..38374.07 rows=979 width=52) (actual time=66.551..66.552 rows=25 loops=1)
                                Sort Key: su_1.received_date DESC, ((su_1.readable_id)::text) COLLATE "C" DESC
                                Presorted Key: su_1.received_date
                                Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 26kB  Peak Memory: 26kB
                                Buffers: shared hit=159876
                                ->  Nested Loop  (cost=0.71..38330.01 rows=979 width=52) (actual time=66.477..66.538 rows=26 loops=1)
                                      Buffers: shared hit=159876
                                      ->  Index Scan Backward using storage_unit_received_date_idx on storage_unit su_1  (cost=0.29..4527.14 rows=48482 width=35) (actual time=0.006..13.560 rows=38880 loops=1)
                                            Filter: (status <> 'disposed'::text)
                                            Rows Removed by Filter: 34088
                                            Buffers: shared hit=4356
                                      ->  Index Scan using storage_unit_search_pkey on storage_unit_search s  (cost=0.42..0.70 rows=1 width=16) (actual time=0.001..0.001 rows=0 loops=38880)
                                            Index Cond: (storage_unit_id = su_1.id)
                                            Filter: (document ~~ '%bkt-2019-004%'::text)
                                            Rows Removed by Filter: 1
                                            Buffers: shared hit=155520
                    ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.42..8.44 rows=1 width=84) (actual time=0.002..0.002 rows=1 loops=25)
                          Index Cond: (id = su_1.id)
                          Buffers: shared hit=100
              ->  Index Scan using project_pkey on project p  (cost=0.28..0.31 rows=1 width=87) (actual time=0.002..0.002 rows=1 loops=25)
                    Index Cond: (id = su.project_id)
                    Buffers: shared hit=75
        ->  Index Scan using location_pkey on location l  (cost=0.14..0.16 rows=1 width=44) (actual time=0.001..0.001 rows=1 loops=25)
              Index Cond: (id = su.current_location_id)
              Buffers: shared hit=50
Planning:
  Buffers: shared hit=39
Planning Time: 0.545 ms
Execution Time: 66.742 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=552.66..552.76 rows=41 width=125) (actual time=0.172..0.173 rows=36 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 29kB
  Buffers: shared hit=182
  ->  Nested Loop  (cost=111.23..551.56 rows=41 width=125) (actual time=0.073..0.140 rows=36 loops=1)
        Buffers: shared hit=182
        ->  Bitmap Heap Scan on storage_unit_hole_summary h  (cost=110.95..259.15 rows=41 width=93) (actual time=0.069..0.072 rows=36 loops=1)
              Recheck Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
              Heap Blocks: exact=2
              Buffers: shared hit=74
              ->  Bitmap Index Scan on summary_one_per_hole_key  (cost=0.00..110.88 rows=41 width=0) (actual time=0.062..0.062 rows=36 loops=1)
                    Index Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
                    Buffers: shared hit=72
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..7.13 rows=1 width=32) (actual time=0.002..0.002 rows=1 loops=36)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=108
Planning:
  Buffers: shared hit=12
Planning Time: 0.207 ms
Execution Time: 0.196 ms
```

## inventory: search one common word (slowest draw)

```sql
SELECT count(*)::int AS total FROM storage_unit su JOIN storage_unit_search s ON s.storage_unit_id = su.id WHERE s.document LIKE $1 AND su.status <> 'disposed'
```

```text
Aggregate  (cost=6793.50..6793.51 rows=1 width=4) (actual time=25.948..25.952 rows=1 loops=1)
  Buffers: shared hit=4385
  ->  Hash Join  (cost=3015.93..6781.26 rows=4897 width=0) (actual time=6.646..25.792 rows=3831 loops=1)
        Hash Cond: (su.id = s.storage_unit_id)
        Buffers: shared hit=4385
        ->  Seq Scan on storage_unit su  (cost=0.00..3638.06 rows=48482 width=16) (actual time=0.007..13.992 rows=48449 loops=1)
              Filter: (status <> 'disposed'::text)
              Rows Removed by Filter: 51556
              Buffers: shared hit=2388
        ->  Hash  (cost=2889.65..2889.65 rows=10102 width=16) (actual time=6.598..6.601 rows=8171 loops=1)
              Buckets: 16384  Batches: 1  Memory Usage: 512kB
              Buffers: shared hit=1997
              ->  Bitmap Heap Scan on storage_unit_search s  (cost=146.38..2889.65 rows=10102 width=16) (actual time=1.448..5.823 rows=8171 loops=1)
                    Recheck Cond: (document ~~ '%tamarack%'::text)
                    Heap Blocks: exact=1905
                    Buffers: shared hit=1997
                    ->  Bitmap Index Scan on storage_unit_search_document_trgm_idx  (cost=0.00..143.85 rows=10102 width=0) (actual time=1.319..1.319 rows=8171 loops=1)
                          Index Cond: (document ~~ '%tamarack%'::text)
                          Buffers: shared hit=92
Planning:
  Buffers: shared hit=18
Planning Time: 0.218 ms
Execution Time: 26.120 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name FROM (SELECT su.id FROM storage_unit su JOIN storage_unit_search s ON s.storage_unit_id = su.id WHERE s.document LIKE $1 AND su.status <> 'disposed' ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC LIMIT $2 OFFSET $3) page JOIN storage_unit su ON su.id = page.id JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC
```

```text
Sort  (cost=431.33..431.39 rows=25 width=247) (actual time=1.318..1.320 rows=25 loops=1)
  Sort Key: su.received_date DESC, su.readable_id COLLATE "C" DESC
  Sort Method: quicksort  Memory: 30kB
  Buffers: shared hit=1628
  ->  Nested Loop  (cost=12.27..430.75 rows=25 width=247) (actual time=1.151..1.299 rows=25 loops=1)
        Buffers: shared hit=1628
        ->  Nested Loop  (cost=12.13..426.70 rows=25 width=155) (actual time=1.142..1.269 rows=25 loops=1)
              Buffers: shared hit=1578
              ->  Nested Loop  (cost=11.85..419.07 rows=25 width=84) (actual time=1.131..1.215 rows=25 loops=1)
                    Buffers: shared hit=1503
                    ->  Limit  (cost=11.43..207.94 rows=25 width=52) (actual time=1.118..1.121 rows=25 loops=1)
                          Buffers: shared hit=1403
                          ->  Incremental Sort  (cost=11.43..38504.25 rows=4897 width=52) (actual time=1.117..1.119 rows=25 loops=1)
                                Sort Key: su_1.received_date DESC, ((su_1.readable_id)::text) COLLATE "C" DESC
                                Presorted Key: su_1.received_date
                                Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 26kB  Peak Memory: 26kB
                                Buffers: shared hit=1403
                                ->  Nested Loop  (cost=0.71..38330.01 rows=4897 width=52) (actual time=0.202..1.100 rows=29 loops=1)
                                      Buffers: shared hit=1403
                                      ->  Index Scan Backward using storage_unit_received_date_idx on storage_unit su_1  (cost=0.29..4527.14 rows=48482 width=35) (actual time=0.009..0.115 rows=346 loops=1)
                                            Filter: (status <> 'disposed'::text)
                                            Buffers: shared hit=19
                                      ->  Index Scan using storage_unit_search_pkey on storage_unit_search s  (cost=0.42..0.70 rows=1 width=16) (actual time=0.003..0.003 rows=0 loops=346)
                                            Index Cond: (storage_unit_id = su_1.id)
                                            Filter: (document ~~ '%tamarack%'::text)
                                            Rows Removed by Filter: 1
                                            Buffers: shared hit=1384
                    ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.42..8.44 rows=1 width=84) (actual time=0.003..0.003 rows=1 loops=25)
                          Index Cond: (id = su_1.id)
                          Buffers: shared hit=100
              ->  Index Scan using project_pkey on project p  (cost=0.28..0.31 rows=1 width=87) (actual time=0.002..0.002 rows=1 loops=25)
                    Index Cond: (id = su.project_id)
                    Buffers: shared hit=75
        ->  Index Scan using location_pkey on location l  (cost=0.14..0.16 rows=1 width=44) (actual time=0.001..0.001 rows=1 loops=25)
              Index Cond: (id = su.current_location_id)
              Buffers: shared hit=50
Planning:
  Buffers: shared hit=39
Planning Time: 0.605 ms
Execution Time: 1.367 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=552.66..552.76 rows=41 width=125) (actual time=0.261..0.263 rows=39 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 29kB
  Buffers: shared hit=196
  ->  Nested Loop  (cost=111.23..551.56 rows=41 width=125) (actual time=0.116..0.214 rows=39 loops=1)
        Buffers: shared hit=196
        ->  Bitmap Heap Scan on storage_unit_hole_summary h  (cost=110.95..259.15 rows=41 width=93) (actual time=0.108..0.116 rows=39 loops=1)
              Recheck Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
              Heap Blocks: exact=4
              Buffers: shared hit=79
              ->  Bitmap Index Scan on summary_one_per_hole_key  (cost=0.00..110.88 rows=41 width=0) (actual time=0.090..0.090 rows=39 loops=1)
                    Index Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
                    Buffers: shared hit=75
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..7.13 rows=1 width=32) (actual time=0.002..0.002 rows=1 loops=39)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=117
Planning:
  Buffers: shared hit=12
Planning Time: 0.369 ms
Execution Time: 0.296 ms
```

## inventory: filter type + status (slowest draw)

```sql
SELECT count(*)::int AS total FROM storage_unit su WHERE su.unit_type = $1 AND su.status = $2
```

```text
Aggregate  (cost=3977.78..3977.80 rows=1 width=4) (actual time=10.413..10.413 rows=1 loops=1)
  Buffers: shared hit=2388
  ->  Seq Scan on storage_unit su  (cost=0.00..3888.07 rows=35884 width=0) (actual time=0.011..9.485 rows=36091 loops=1)
        Filter: ((unit_type = 'bucket'::text) AND (status = 'disposed'::text))
        Rows Removed by Filter: 63914
        Buffers: shared hit=2388
Planning Time: 0.129 ms
Execution Time: 10.435 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name FROM (SELECT su.id FROM storage_unit su WHERE su.unit_type = $1 AND su.status = $2 ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC LIMIT $3 OFFSET $4) page JOIN storage_unit su ON su.id = page.id JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC
```

```text
Sort  (cost=229.29..229.35 rows=25 width=247) (actual time=0.990..0.992 rows=25 loops=1)
  Sort Key: su.received_date DESC, su.readable_id COLLATE "C" DESC
  Sort Method: quicksort  Memory: 30kB
  Buffers: shared hit=481
  ->  Nested Loop  (cost=2.63..228.71 rows=25 width=247) (actual time=0.824..0.977 rows=25 loops=1)
        Buffers: shared hit=481
        ->  Nested Loop  (cost=2.49..224.66 rows=25 width=155) (actual time=0.814..0.946 rows=25 loops=1)
              Buffers: shared hit=431
              ->  Nested Loop  (cost=2.21..217.02 rows=25 width=84) (actual time=0.807..0.882 rows=25 loops=1)
                    Buffers: shared hit=356
                    ->  Limit  (cost=1.79..5.90 rows=25 width=52) (actual time=0.792..0.794 rows=25 loops=1)
                          Buffers: shared hit=256
                          ->  Incremental Sort  (cost=1.79..5893.98 rows=35884 width=52) (actual time=0.790..0.792 rows=25 loops=1)
                                Sort Key: su_1.received_date DESC, ((su_1.readable_id)::text) COLLATE "C" DESC
                                Presorted Key: su_1.received_date
                                Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 26kB  Peak Memory: 26kB
                                Buffers: shared hit=256
                                ->  Index Scan Backward using storage_unit_received_date_idx on storage_unit su_1  (cost=0.29..4777.15 rows=35884 width=52) (actual time=0.647..0.773 rows=27 loops=1)
                                      Filter: ((unit_type = 'bucket'::text) AND (status = 'disposed'::text))
                                      Rows Removed by Filter: 4620
                                      Buffers: shared hit=256
                    ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.42..8.44 rows=1 width=84) (actual time=0.003..0.003 rows=1 loops=25)
                          Index Cond: (id = su_1.id)
                          Buffers: shared hit=100
              ->  Index Scan using project_pkey on project p  (cost=0.28..0.31 rows=1 width=87) (actual time=0.002..0.002 rows=1 loops=25)
                    Index Cond: (id = su.project_id)
                    Buffers: shared hit=75
        ->  Index Scan using location_pkey on location l  (cost=0.14..0.16 rows=1 width=44) (actual time=0.001..0.001 rows=1 loops=25)
              Index Cond: (id = su.current_location_id)
              Buffers: shared hit=50
Planning:
  Buffers: shared hit=21
Planning Time: 0.470 ms
Execution Time: 1.033 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=552.66..552.76 rows=41 width=125) (actual time=0.551..0.553 rows=36 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 28kB
  Buffers: shared hit=197
  ->  Nested Loop  (cost=111.23..551.56 rows=41 width=125) (actual time=0.164..0.493 rows=36 loops=1)
        Buffers: shared hit=197
        ->  Bitmap Heap Scan on storage_unit_hole_summary h  (cost=110.95..259.15 rows=41 width=93) (actual time=0.154..0.175 rows=36 loops=1)
              Recheck Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
              Heap Blocks: exact=14
              Buffers: shared hit=89
              ->  Bitmap Index Scan on summary_one_per_hole_key  (cost=0.00..110.88 rows=41 width=0) (actual time=0.141..0.141 rows=36 loops=1)
                    Index Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
                    Buffers: shared hit=75
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..7.13 rows=1 width=32) (actual time=0.008..0.008 rows=1 loops=36)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=108
Planning:
  Buffers: shared hit=12
Planning Time: 0.292 ms
Execution Time: 0.586 ms
```

## inventory: all statuses by ID, deep page (slowest draw)

```sql
SELECT count(*)::int AS total FROM storage_unit su
```

```text
Aggregate  (cost=2134.38..2134.39 rows=1 width=4) (actual time=6.340..6.341 rows=1 loops=1)
  Buffers: shared hit=96
  ->  Index Only Scan using storage_unit_received_date_idx on storage_unit su  (cost=0.29..1884.37 rows=100005 width=0) (actual time=0.005..3.819 rows=100005 loops=1)
        Heap Fetches: 0
        Buffers: shared hit=96
Planning Time: 0.056 ms
Execution Time: 6.356 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name FROM (SELECT su.id FROM storage_unit su ORDER BY su.readable_id COLLATE "C" ASC LIMIT $1 OFFSET $2) page JOIN storage_unit su ON su.id = page.id JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id ORDER BY su.readable_id COLLATE "C" ASC
```

```text
Sort  (cost=429.37..429.44 rows=25 width=243) (actual time=0.361..0.362 rows=25 loops=1)
  Sort Key: su.readable_id COLLATE "C"
  Sort Method: quicksort  Memory: 30kB
  Buffers: shared hit=253
  ->  Hash Join  (cost=207.65..428.79 rows=25 width=243) (actual time=0.256..0.352 rows=25 loops=1)
        Hash Cond: (su.current_location_id = l.id)
        Buffers: shared hit=253
        ->  Nested Loop  (cost=205.73..426.67 rows=25 width=155) (actual time=0.238..0.329 rows=25 loops=1)
              Buffers: shared hit=252
              ->  Nested Loop  (cost=205.44..419.03 rows=25 width=84) (actual time=0.235..0.295 rows=25 loops=1)
                    Buffers: shared hit=177
                    ->  Limit  (cost=205.03..207.91 rows=25 width=48) (actual time=0.229..0.234 rows=25 loops=1)
                          Buffers: shared hit=77
                          ->  Index Scan using storage_unit_readable_id_c_idx on storage_unit su_1  (cost=0.42..11528.25 rows=100005 width=48) (actual time=0.005..0.200 rows=1800 loops=1)
                                Buffers: shared hit=77
                    ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.42..8.44 rows=1 width=84) (actual time=0.002..0.002 rows=1 loops=25)
                          Index Cond: (id = su_1.id)
                          Buffers: shared hit=100
              ->  Index Scan using project_pkey on project p  (cost=0.28..0.31 rows=1 width=87) (actual time=0.001..0.001 rows=1 loops=25)
                    Index Cond: (id = su.project_id)
                    Buffers: shared hit=75
        ->  Hash  (cost=1.41..1.41 rows=41 width=44) (actual time=0.013..0.014 rows=41 loops=1)
              Buckets: 1024  Batches: 1  Memory Usage: 12kB
              Buffers: shared hit=1
              ->  Seq Scan on location l  (cost=0.00..1.41 rows=41 width=44) (actual time=0.007..0.009 rows=41 loops=1)
                    Buffers: shared hit=1
Planning:
  Buffers: shared hit=21
Planning Time: 0.322 ms
Execution Time: 0.384 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=552.66..552.76 rows=41 width=125) (actual time=0.177..0.178 rows=41 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 29kB
  Buffers: shared hit=200
  ->  Nested Loop  (cost=111.23..551.56 rows=41 width=125) (actual time=0.076..0.145 rows=41 loops=1)
        Buffers: shared hit=200
        ->  Bitmap Heap Scan on storage_unit_hole_summary h  (cost=110.95..259.15 rows=41 width=93) (actual time=0.072..0.074 rows=41 loops=1)
              Recheck Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
              Heap Blocks: exact=2
              Buffers: shared hit=77
              ->  Bitmap Index Scan on summary_one_per_hole_key  (cost=0.00..110.88 rows=41 width=0) (actual time=0.065..0.065 rows=41 loops=1)
                    Index Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
                    Buffers: shared hit=75
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..7.13 rows=1 width=32) (actual time=0.002..0.002 rows=1 loops=41)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=123
Planning:
  Buffers: shared hit=12
Planning Time: 0.138 ms
Execution Time: 0.193 ms
```

## inventory: search + type + dates (slowest draw)

```sql
SELECT count(*)::int AS total FROM storage_unit su JOIN storage_unit_search s ON s.storage_unit_id = su.id WHERE s.document LIKE $1 AND su.unit_type = $2 AND su.received_date >= $3::date AND su.received_date <= $4::date
```

```text
Aggregate  (cost=3068.64..3068.65 rows=1 width=4) (actual time=4.769..4.771 rows=1 loops=1)
  Buffers: shared hit=2059
  ->  Hash Join  (cost=298.41..3068.21 rows=172 width=0) (actual time=2.092..4.762 rows=156 loops=1)
        Hash Cond: (s.storage_unit_id = su.id)
        Buffers: shared hit=2059
        ->  Bitmap Heap Scan on storage_unit_search s  (cost=146.38..2889.65 rows=10102 width=16) (actual time=1.471..3.980 rows=8171 loops=1)
              Recheck Cond: (document ~~ '%tamarack%'::text)
              Heap Blocks: exact=1905
              Buffers: shared hit=1997
              ->  Bitmap Index Scan on storage_unit_search_document_trgm_idx  (cost=0.00..143.85 rows=10102 width=0) (actual time=1.346..1.347 rows=8171 loops=1)
                    Index Cond: (document ~~ '%tamarack%'::text)
                    Buffers: shared hit=92
        ->  Hash  (cost=130.79..130.79 rows=1700 width=16) (actual time=0.336..0.336 rows=1655 loops=1)
              Buckets: 2048  Batches: 1  Memory Usage: 94kB
              Buffers: shared hit=62
              ->  Index Scan using storage_unit_received_date_idx on storage_unit su  (cost=0.29..130.79 rows=1700 width=16) (actual time=0.009..0.255 rows=1655 loops=1)
                    Index Cond: ((received_date >= '2017-08-01'::date) AND (received_date <= '2017-10-28'::date))
                    Filter: (unit_type = 'bucket'::text)
                    Rows Removed by Filter: 737
                    Buffers: shared hit=62
Planning:
  Buffers: shared hit=18
Planning Time: 0.218 ms
Execution Time: 4.860 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name FROM (SELECT su.id FROM storage_unit su JOIN storage_unit_search s ON s.storage_unit_id = su.id WHERE s.document LIKE $1 AND su.unit_type = $2 AND su.received_date >= $3::date AND su.received_date <= $4::date ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC LIMIT $5 OFFSET $6) page JOIN storage_unit su ON su.id = page.id JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC
```

```text
Sort  (cost=1447.89..1447.95 rows=25 width=247) (actual time=1.041..1.043 rows=25 loops=1)
  Sort Key: su.received_date DESC, su.readable_id COLLATE "C" DESC
  Sort Method: quicksort  Memory: 30kB
  Buffers: shared hit=1567
  ->  Nested Loop  (cost=48.85..1447.31 rows=25 width=247) (actual time=0.919..1.031 rows=25 loops=1)
        Buffers: shared hit=1567
        ->  Nested Loop  (cost=48.71..1443.26 rows=25 width=155) (actual time=0.912..1.011 rows=25 loops=1)
              Buffers: shared hit=1517
              ->  Nested Loop  (cost=48.43..1435.63 rows=25 width=84) (actual time=0.903..0.968 rows=25 loops=1)
                    Buffers: shared hit=1442
                    ->  Limit  (cost=48.01..1224.50 rows=25 width=52) (actual time=0.894..0.896 rows=25 loops=1)
                          Buffers: shared hit=1342
                          ->  Incremental Sort  (cost=48.01..8142.28 rows=172 width=52) (actual time=0.893..0.894 rows=25 loops=1)
                                Sort Key: su_1.received_date DESC, ((su_1.readable_id)::text) COLLATE "C" DESC
                                Presorted Key: su_1.received_date
                                Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 27kB  Peak Memory: 27kB
                                Buffers: shared hit=1342
                                ->  Nested Loop  (cost=0.71..8134.54 rows=172 width=52) (actual time=0.099..0.876 rows=30 loops=1)
                                      Buffers: shared hit=1342
                                      ->  Index Scan Backward using storage_unit_received_date_idx on storage_unit su_1  (cost=0.29..130.79 rows=1700 width=35) (actual time=0.013..0.097 rows=328 loops=1)
                                            Index Cond: ((received_date >= '2017-08-01'::date) AND (received_date <= '2017-10-28'::date))
                                            Filter: (unit_type = 'bucket'::text)
                                            Rows Removed by Filter: 159
                                            Buffers: shared hit=30
                                      ->  Index Scan using storage_unit_search_pkey on storage_unit_search s  (cost=0.42..4.71 rows=1 width=16) (actual time=0.002..0.002 rows=0 loops=328)
                                            Index Cond: (storage_unit_id = su_1.id)
                                            Filter: (document ~~ '%tamarack%'::text)
                                            Rows Removed by Filter: 1
                                            Buffers: shared hit=1312
                    ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.42..8.44 rows=1 width=84) (actual time=0.003..0.003 rows=1 loops=25)
                          Index Cond: (id = su_1.id)
                          Buffers: shared hit=100
              ->  Index Scan using project_pkey on project p  (cost=0.28..0.31 rows=1 width=87) (actual time=0.002..0.002 rows=1 loops=25)
                    Index Cond: (id = su.project_id)
                    Buffers: shared hit=75
        ->  Index Scan using location_pkey on location l  (cost=0.14..0.16 rows=1 width=44) (actual time=0.001..0.001 rows=1 loops=25)
              Index Cond: (id = su.current_location_id)
              Buffers: shared hit=50
Planning:
  Buffers: shared hit=39
Planning Time: 0.721 ms
Execution Time: 1.085 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=552.66..552.76 rows=41 width=125) (actual time=0.251..0.252 rows=39 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 29kB
  Buffers: shared hit=200
  ->  Nested Loop  (cost=111.23..551.56 rows=41 width=125) (actual time=0.130..0.215 rows=39 loops=1)
        Buffers: shared hit=200
        ->  Bitmap Heap Scan on storage_unit_hole_summary h  (cost=110.95..259.15 rows=41 width=93) (actual time=0.123..0.132 rows=39 loops=1)
              Recheck Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
              Heap Blocks: exact=8
              Buffers: shared hit=83
              ->  Bitmap Index Scan on summary_one_per_hole_key  (cost=0.00..110.88 rows=41 width=0) (actual time=0.116..0.116 rows=39 loops=1)
                    Index Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
                    Buffers: shared hit=75
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..7.13 rows=1 width=32) (actual time=0.002..0.002 rows=1 loops=39)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=117
Planning:
  Buffers: shared hit=12
Planning Time: 0.199 ms
Execution Time: 0.286 ms
```

## inventory: default view, later page (slowest draw)

```sql
SELECT count(*)::int AS total FROM storage_unit su WHERE su.status <> 'disposed'
```

```text
Aggregate  (cost=2407.59..2407.60 rows=1 width=4) (actual time=5.147..5.147 rows=1 loops=1)
  Buffers: shared hit=134
  ->  Index Only Scan using storage_unit_location_idx on storage_unit su  (cost=0.29..2286.38 rows=48482 width=0) (actual time=0.006..4.029 rows=48449 loops=1)
        Filter: (status <> 'disposed'::text)
        Rows Removed by Filter: 51556
        Heap Fetches: 0
        Buffers: shared hit=134
Planning Time: 0.057 ms
Execution Time: 5.159 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name FROM (SELECT su.id FROM storage_unit su WHERE su.status <> 'disposed' ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC LIMIT $1 OFFSET $2) page JOIN storage_unit su ON su.id = page.id JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC
```

```text
Sort  (cost=244.12..244.18 rows=25 width=247) (actual time=0.257..0.258 rows=25 loops=1)
  Sort Key: su.received_date DESC, su.readable_id COLLATE "C" DESC
  Sort Method: quicksort  Memory: 30kB
  Buffers: shared hit=237
  ->  Nested Loop  (cost=18.42..243.54 rows=25 width=247) (actual time=0.101..0.243 rows=25 loops=1)
        Buffers: shared hit=237
        ->  Nested Loop  (cost=18.28..239.49 rows=25 width=155) (actual time=0.095..0.218 rows=25 loops=1)
              Buffers: shared hit=187
              ->  Nested Loop  (cost=17.99..231.85 rows=25 width=84) (actual time=0.090..0.167 rows=25 loops=1)
                    Buffers: shared hit=112
                    ->  Limit  (cost=17.58..20.73 rows=25 width=52) (actual time=0.079..0.090 rows=25 loops=1)
                          Buffers: shared hit=12
                          ->  Incremental Sort  (cost=1.81..6116.16 rows=48482 width=52) (actual time=0.032..0.086 rows=150 loops=1)
                                Sort Key: su_1.received_date DESC, ((su_1.readable_id)::text) COLLATE "C" DESC
                                Presorted Key: su_1.received_date
                                Full-sort Groups: 3  Sort Method: quicksort  Average Memory: 27kB  Peak Memory: 27kB
                                Pre-sorted Groups: 2  Sort Methods: top-N heapsort, quicksort  Average Memory: 27kB  Peak Memory: 27kB
                                Buffers: shared hit=12
                                ->  Index Scan Backward using storage_unit_received_date_idx on storage_unit su_1  (cost=0.29..4527.14 rows=48482 width=52) (actual time=0.013..0.043 rows=175 loops=1)
                                      Filter: (status <> 'disposed'::text)
                                      Buffers: shared hit=12
                    ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.42..8.44 rows=1 width=84) (actual time=0.003..0.003 rows=1 loops=25)
                          Index Cond: (id = su_1.id)
                          Buffers: shared hit=100
              ->  Index Scan using project_pkey on project p  (cost=0.28..0.31 rows=1 width=87) (actual time=0.002..0.002 rows=1 loops=25)
                    Index Cond: (id = su.project_id)
                    Buffers: shared hit=75
        ->  Index Scan using location_pkey on location l  (cost=0.14..0.16 rows=1 width=44) (actual time=0.001..0.001 rows=1 loops=25)
              Index Cond: (id = su.current_location_id)
              Buffers: shared hit=50
Planning:
  Buffers: shared hit=21
Planning Time: 0.418 ms
Execution Time: 0.300 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=552.66..552.76 rows=41 width=125) (actual time=0.166..0.167 rows=38 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 29kB
  Buffers: shared hit=191
  ->  Nested Loop  (cost=111.23..551.56 rows=41 width=125) (actual time=0.076..0.140 rows=38 loops=1)
        Buffers: shared hit=191
        ->  Bitmap Heap Scan on storage_unit_hole_summary h  (cost=110.95..259.15 rows=41 width=93) (actual time=0.069..0.072 rows=38 loops=1)
              Recheck Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
              Heap Blocks: exact=2
              Buffers: shared hit=77
              ->  Bitmap Index Scan on summary_one_per_hole_key  (cost=0.00..110.88 rows=41 width=0) (actual time=0.062..0.062 rows=38 loops=1)
                    Index Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
                    Buffers: shared hit=75
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..7.13 rows=1 width=32) (actual time=0.002..0.002 rows=1 loops=38)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=114
Planning:
  Buffers: shared hit=12
Planning Time: 0.159 ms
Execution Time: 0.183 ms
```

## inventory: default view (slowest draw)

```sql
SELECT count(*)::int AS total FROM storage_unit su WHERE su.status <> 'disposed'
```

```text
Aggregate  (cost=2407.59..2407.60 rows=1 width=4) (actual time=5.232..5.232 rows=1 loops=1)
  Buffers: shared hit=134
  ->  Index Only Scan using storage_unit_location_idx on storage_unit su  (cost=0.29..2286.38 rows=48482 width=0) (actual time=0.005..4.082 rows=48449 loops=1)
        Filter: (status <> 'disposed'::text)
        Rows Removed by Filter: 51556
        Heap Fetches: 0
        Buffers: shared hit=134
Planning Time: 0.045 ms
Execution Time: 5.244 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name FROM (SELECT su.id FROM storage_unit su WHERE su.status <> 'disposed' ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC LIMIT $1 OFFSET $2) page JOIN storage_unit su ON su.id = page.id JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC
```

```text
Sort  (cost=228.35..228.42 rows=25 width=247) (actual time=0.174..0.175 rows=25 loops=1)
  Sort Key: su.received_date DESC, su.readable_id COLLATE "C" DESC
  Sort Method: quicksort  Memory: 30kB
  Buffers: shared hit=229
  ->  Nested Loop  (cost=2.65..227.77 rows=25 width=247) (actual time=0.049..0.163 rows=25 loops=1)
        Buffers: shared hit=229
        ->  Nested Loop  (cost=2.51..223.73 rows=25 width=155) (actual time=0.044..0.144 rows=25 loops=1)
              Buffers: shared hit=179
              ->  Nested Loop  (cost=2.23..216.09 rows=25 width=84) (actual time=0.039..0.099 rows=25 loops=1)
                    Buffers: shared hit=104
                    ->  Limit  (cost=1.81..4.96 rows=25 width=52) (actual time=0.032..0.034 rows=25 loops=1)
                          Buffers: shared hit=4
                          ->  Incremental Sort  (cost=1.81..6116.16 rows=48482 width=52) (actual time=0.031..0.032 rows=25 loops=1)
                                Sort Key: su_1.received_date DESC, ((su_1.readable_id)::text) COLLATE "C" DESC
                                Presorted Key: su_1.received_date
                                Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 27kB  Peak Memory: 27kB
                                Buffers: shared hit=4
                                ->  Index Scan Backward using storage_unit_received_date_idx on storage_unit su_1  (cost=0.29..4527.14 rows=48482 width=52) (actual time=0.010..0.019 rows=40 loops=1)
                                      Filter: (status <> 'disposed'::text)
                                      Buffers: shared hit=4
                    ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.42..8.44 rows=1 width=84) (actual time=0.002..0.002 rows=1 loops=25)
                          Index Cond: (id = su_1.id)
                          Buffers: shared hit=100
              ->  Index Scan using project_pkey on project p  (cost=0.28..0.31 rows=1 width=87) (actual time=0.002..0.002 rows=1 loops=25)
                    Index Cond: (id = su.project_id)
                    Buffers: shared hit=75
        ->  Index Scan using location_pkey on location l  (cost=0.14..0.16 rows=1 width=44) (actual time=0.000..0.000 rows=1 loops=25)
              Index Cond: (id = su.current_location_id)
              Buffers: shared hit=50
Planning:
  Buffers: shared hit=21
Planning Time: 0.407 ms
Execution Time: 0.204 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=552.66..552.76 rows=41 width=125) (actual time=0.163..0.165 rows=35 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 28kB
  Buffers: shared hit=182
  ->  Nested Loop  (cost=111.23..551.56 rows=41 width=125) (actual time=0.079..0.135 rows=35 loops=1)
        Buffers: shared hit=182
        ->  Bitmap Heap Scan on storage_unit_hole_summary h  (cost=110.95..259.15 rows=41 width=93) (actual time=0.072..0.075 rows=35 loops=1)
              Recheck Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
              Heap Blocks: exact=2
              Buffers: shared hit=77
              ->  Bitmap Index Scan on summary_one_per_hole_key  (cost=0.00..110.88 rows=41 width=0) (actual time=0.064..0.064 rows=35 loops=1)
                    Index Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
                    Buffers: shared hit=75
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..7.13 rows=1 width=32) (actual time=0.001..0.001 rows=1 loops=35)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=105
Planning:
  Buffers: shared hit=12
Planning Time: 0.191 ms
Execution Time: 0.183 ms
```

## inventory: search project number (slowest draw)

```sql
SELECT count(*)::int AS total FROM storage_unit su JOIN storage_unit_search s ON s.storage_unit_id = su.id WHERE s.document LIKE $1 AND su.status <> 'disposed'
```

```text
Aggregate  (cost=216.06..216.07 rows=1 width=4) (actual time=0.862..0.863 rows=1 loops=1)
  Buffers: shared hit=212
  ->  Nested Loop  (cost=93.82..216.04 rows=5 width=0) (actual time=0.814..0.860 rows=6 loops=1)
        Buffers: shared hit=212
        ->  Bitmap Heap Scan on storage_unit_search s  (cost=93.40..131.67 rows=10 width=16) (actual time=0.794..0.809 rows=26 loops=1)
              Recheck Cond: (document ~~ '%b21-0138%'::text)
              Rows Removed by Index Recheck: 16
              Heap Blocks: exact=19
              Buffers: shared hit=108
              ->  Bitmap Index Scan on storage_unit_search_document_trgm_idx  (cost=0.00..93.40 rows=10 width=0) (actual time=0.781..0.781 rows=42 loops=1)
                    Index Cond: (document ~~ '%b21-0138%'::text)
                    Buffers: shared hit=89
        ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.42..8.44 rows=1 width=16) (actual time=0.002..0.002 rows=0 loops=26)
              Index Cond: (id = s.storage_unit_id)
              Filter: (status <> 'disposed'::text)
              Rows Removed by Filter: 1
              Buffers: shared hit=104
Planning:
  Buffers: shared hit=18
Planning Time: 0.139 ms
Execution Time: 0.929 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name FROM (SELECT su.id FROM storage_unit su JOIN storage_unit_search s ON s.storage_unit_id = su.id WHERE s.document LIKE $1 AND su.status <> 'disposed' ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC LIMIT $2 OFFSET $3) page JOIN storage_unit su ON su.id = page.id JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC
```

```text
Sort  (cost=260.74..260.75 rows=5 width=247) (actual time=0.733..0.734 rows=6 loops=1)
  Sort Key: su.received_date DESC, su.readable_id COLLATE "C" DESC
  Sort Method: quicksort  Memory: 26kB
  Buffers: shared hit=266
  ->  Nested Loop  (cost=216.94..260.68 rows=5 width=247) (actual time=0.718..0.730 rows=6 loops=1)
        Buffers: shared hit=266
        ->  Nested Loop  (cost=216.80..259.87 rows=5 width=155) (actual time=0.714..0.723 rows=6 loops=1)
              Buffers: shared hit=254
              ->  Nested Loop  (cost=216.52..258.34 rows=5 width=84) (actual time=0.711..0.717 rows=6 loops=1)
                    Buffers: shared hit=236
                    ->  Limit  (cost=216.10..216.11 rows=5 width=52) (actual time=0.710..0.711 rows=6 loops=1)
                          Buffers: shared hit=212
                          ->  Sort  (cost=216.10..216.11 rows=5 width=52) (actual time=0.709..0.710 rows=6 loops=1)
                                Sort Key: su_1.received_date DESC, ((su_1.readable_id)::text) COLLATE "C" DESC
                                Sort Method: quicksort  Memory: 25kB
                                Buffers: shared hit=212
                                ->  Nested Loop  (cost=93.82..216.04 rows=5 width=52) (actual time=0.680..0.707 rows=6 loops=1)
                                      Buffers: shared hit=212
                                      ->  Bitmap Heap Scan on storage_unit_search s  (cost=93.40..131.67 rows=10 width=16) (actual time=0.671..0.680 rows=26 loops=1)
                                            Recheck Cond: (document ~~ '%b21-0138%'::text)
                                            Rows Removed by Index Recheck: 16
                                            Heap Blocks: exact=19
                                            Buffers: shared hit=108
                                            ->  Bitmap Index Scan on storage_unit_search_document_trgm_idx  (cost=0.00..93.40 rows=10 width=0) (actual time=0.663..0.663 rows=42 loops=1)
                                                  Index Cond: (document ~~ '%b21-0138%'::text)
                                                  Buffers: shared hit=89
                                      ->  Index Scan using storage_unit_pkey on storage_unit su_1  (cost=0.42..8.44 rows=1 width=35) (actual time=0.001..0.001 rows=0 loops=26)
                                            Index Cond: (id = s.storage_unit_id)
                                            Filter: (status <> 'disposed'::text)
                                            Rows Removed by Filter: 1
                                            Buffers: shared hit=104
                    ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.42..8.44 rows=1 width=84) (actual time=0.001..0.001 rows=1 loops=6)
                          Index Cond: (id = su_1.id)
                          Buffers: shared hit=24
              ->  Index Scan using project_pkey on project p  (cost=0.28..0.31 rows=1 width=87) (actual time=0.001..0.001 rows=1 loops=6)
                    Index Cond: (id = su.project_id)
                    Buffers: shared hit=18
        ->  Index Scan using location_pkey on location l  (cost=0.14..0.16 rows=1 width=44) (actual time=0.001..0.001 rows=1 loops=6)
              Index Cond: (id = su.current_location_id)
              Buffers: shared hit=12
Planning:
  Buffers: shared hit=39
Planning Time: 0.356 ms
Execution Time: 0.787 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=148.00..148.03 rows=10 width=125) (actual time=0.046..0.047 rows=10 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 26kB
  Buffers: shared hit=52
  ->  Nested Loop  (cost=26.90..147.84 rows=10 width=125) (actual time=0.026..0.038 rows=10 loops=1)
        Buffers: shared hit=52
        ->  Bitmap Heap Scan on storage_unit_hole_summary h  (cost=26.61..64.81 rows=10 width=93) (actual time=0.021..0.024 rows=10 loops=1)
              Recheck Cond: (storage_unit_id = ANY ('{6 uuids}'::uuid[]))
              Heap Blocks: exact=4
              Buffers: shared hit=22
              ->  Bitmap Index Scan on summary_one_per_hole_key  (cost=0.00..26.61 rows=10 width=0) (actual time=0.015..0.016 rows=10 loops=1)
                    Index Cond: (storage_unit_id = ANY ('{6 uuids}'::uuid[]))
                    Buffers: shared hit=18
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..8.30 rows=1 width=32) (actual time=0.001..0.001 rows=1 loops=10)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=30
Planning:
  Buffers: shared hit=12
Planning Time: 0.104 ms
Execution Time: 0.058 ms
```

## inventory: filter location (slowest draw)

```sql
SELECT count(*)::int AS total FROM storage_unit su WHERE su.current_location_id = $1 AND su.status <> 'disposed'
```

```text
Aggregate  (cost=104.41..104.42 rows=1 width=4) (actual time=0.177..0.178 rows=1 loops=1)
  Buffers: shared hit=7
  ->  Index Only Scan using storage_unit_location_idx on storage_unit su  (cost=0.29..99.83 rows=1831 width=0) (actual time=0.007..0.139 rows=1631 loops=1)
        Index Cond: (current_location_id = 'f59551de-4222-4a40-8b18-27146faf0ccc'::uuid)
        Filter: (status <> 'disposed'::text)
        Rows Removed by Filter: 2117
        Heap Fetches: 0
        Buffers: shared hit=7
Planning Time: 0.052 ms
Execution Time: 0.187 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name FROM (SELECT su.id FROM storage_unit su WHERE su.current_location_id = $1 AND su.status <> 'disposed' ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC LIMIT $2 OFFSET $3) page JOIN storage_unit su ON su.id = page.id JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC
```

```text
Sort  (cost=293.12..293.18 rows=25 width=247) (actual time=0.527..0.528 rows=25 loops=1)
  Sort Key: su.received_date DESC, su.readable_id COLLATE "C" DESC
  Sort Method: quicksort  Memory: 30kB
  Buffers: shared hit=489
  ->  Nested Loop  (cost=4.45..292.54 rows=25 width=247) (actual time=0.425..0.520 rows=25 loops=1)
        Buffers: shared hit=489
        ->  Nested Loop  (cost=4.31..288.49 rows=25 width=155) (actual time=0.422..0.506 rows=25 loops=1)
              Buffers: shared hit=439
              ->  Nested Loop  (cost=4.03..280.85 rows=25 width=84) (actual time=0.419..0.471 rows=25 loops=1)
                    Buffers: shared hit=364
                    ->  Limit  (cost=3.61..69.73 rows=25 width=52) (actual time=0.413..0.416 rows=25 loops=1)
                          Buffers: shared hit=264
                          ->  Incremental Sort  (cost=3.61..4845.96 rows=1831 width=52) (actual time=0.412..0.413 rows=25 loops=1)
                                Sort Key: su_1.received_date DESC, ((su_1.readable_id)::text) COLLATE "C" DESC
                                Presorted Key: su_1.received_date
                                Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 26kB  Peak Memory: 26kB
                                Buffers: shared hit=264
                                ->  Index Scan Backward using storage_unit_received_date_idx on storage_unit su_1  (cost=0.29..4777.15 rows=1831 width=52) (actual time=0.339..0.405 rows=28 loops=1)
                                      Filter: ((status <> 'disposed'::text) AND (current_location_id = 'f59551de-4222-4a40-8b18-27146faf0ccc'::uuid))
                                      Rows Removed by Filter: 4787
                                      Buffers: shared hit=264
                    ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.42..8.44 rows=1 width=84) (actual time=0.002..0.002 rows=1 loops=25)
                          Index Cond: (id = su_1.id)
                          Buffers: shared hit=100
              ->  Index Scan using project_pkey on project p  (cost=0.28..0.31 rows=1 width=87) (actual time=0.001..0.001 rows=1 loops=25)
                    Index Cond: (id = su.project_id)
                    Buffers: shared hit=75
        ->  Index Scan using location_pkey on location l  (cost=0.14..0.16 rows=1 width=44) (actual time=0.000..0.000 rows=1 loops=25)
              Index Cond: (id = su.current_location_id)
              Buffers: shared hit=50
Planning:
  Buffers: shared hit=21
Planning Time: 0.380 ms
Execution Time: 0.554 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=552.66..552.76 rows=41 width=125) (actual time=0.160..0.161 rows=38 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 29kB
  Buffers: shared hit=202
  ->  Nested Loop  (cost=111.23..551.56 rows=41 width=125) (actual time=0.064..0.132 rows=38 loops=1)
        Buffers: shared hit=202
        ->  Bitmap Heap Scan on storage_unit_hole_summary h  (cost=110.95..259.15 rows=41 width=93) (actual time=0.060..0.069 rows=38 loops=1)
              Recheck Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
              Heap Blocks: exact=13
              Buffers: shared hit=88
              ->  Bitmap Index Scan on summary_one_per_hole_key  (cost=0.00..110.88 rows=41 width=0) (actual time=0.055..0.055 rows=38 loops=1)
                    Index Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
                    Buffers: shared hit=75
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..7.13 rows=1 width=32) (actual time=0.001..0.001 rows=1 loops=38)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=114
Planning:
  Buffers: shared hit=12
Planning Time: 0.130 ms
Execution Time: 0.176 ms
```

## inventory: filter received dates (slowest draw)

```sql
SELECT count(*)::int AS total FROM storage_unit su WHERE su.received_date >= $1::date AND su.received_date <= $2::date
```

```text
Aggregate  (cost=65.28..65.29 rows=1 width=4) (actual time=0.134..0.134 rows=1 loops=1)
  Buffers: shared hit=6
  ->  Index Only Scan using storage_unit_received_date_idx on storage_unit su  (cost=0.29..59.39 rows=2355 width=0) (actual time=0.005..0.076 rows=2389 loops=1)
        Index Cond: ((received_date >= '2021-09-01'::date) AND (received_date <= '2021-11-28'::date))
        Heap Fetches: 0
        Buffers: shared hit=6
Planning Time: 0.053 ms
Execution Time: 0.144 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name FROM (SELECT su.id FROM storage_unit su WHERE su.received_date >= $1::date AND su.received_date <= $2::date ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC LIMIT $3 OFFSET $4) page JOIN storage_unit su ON su.id = page.id JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC
```

```text
Sort  (cost=225.94..226.00 rows=25 width=247) (actual time=0.168..0.169 rows=25 loops=1)
  Sort Key: su.received_date DESC, su.readable_id COLLATE "C" DESC
  Sort Method: quicksort  Memory: 30kB
  Buffers: shared hit=230
  ->  Nested Loop  (cost=1.21..225.36 rows=25 width=247) (actual time=0.034..0.159 rows=25 loops=1)
        Buffers: shared hit=230
        ->  Nested Loop  (cost=1.07..221.31 rows=25 width=155) (actual time=0.030..0.135 rows=25 loops=1)
              Buffers: shared hit=180
              ->  Nested Loop  (cost=0.79..213.67 rows=25 width=84) (actual time=0.027..0.092 rows=25 loops=1)
                    Buffers: shared hit=105
                    ->  Limit  (cost=0.37..2.55 rows=25 width=52) (actual time=0.022..0.024 rows=25 loops=1)
                          Buffers: shared hit=5
                          ->  Incremental Sort  (cost=0.37..205.38 rows=2355 width=52) (actual time=0.021..0.022 rows=25 loops=1)
                                Sort Key: su_1.received_date DESC, ((su_1.readable_id)::text) COLLATE "C" DESC
                                Presorted Key: su_1.received_date
                                Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 26kB  Peak Memory: 26kB
                                Buffers: shared hit=5
                                ->  Index Scan Backward using storage_unit_received_date_idx on storage_unit su_1  (cost=0.29..120.93 rows=2355 width=52) (actual time=0.006..0.011 rows=28 loops=1)
                                      Index Cond: ((received_date >= '2021-09-01'::date) AND (received_date <= '2021-11-28'::date))
                                      Buffers: shared hit=5
                    ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.42..8.44 rows=1 width=84) (actual time=0.002..0.002 rows=1 loops=25)
                          Index Cond: (id = su_1.id)
                          Buffers: shared hit=100
              ->  Index Scan using project_pkey on project p  (cost=0.28..0.31 rows=1 width=87) (actual time=0.001..0.001 rows=1 loops=25)
                    Index Cond: (id = su.project_id)
                    Buffers: shared hit=75
        ->  Index Scan using location_pkey on location l  (cost=0.14..0.16 rows=1 width=44) (actual time=0.001..0.001 rows=1 loops=25)
              Index Cond: (id = su.current_location_id)
              Buffers: shared hit=50
Planning:
  Buffers: shared hit=21
Planning Time: 0.424 ms
Execution Time: 0.197 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=552.66..552.76 rows=41 width=125) (actual time=0.160..0.161 rows=34 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 28kB
  Buffers: shared hit=178
  ->  Nested Loop  (cost=111.23..551.56 rows=41 width=125) (actual time=0.074..0.134 rows=34 loops=1)
        Buffers: shared hit=178
        ->  Bitmap Heap Scan on storage_unit_hole_summary h  (cost=110.95..259.15 rows=41 width=93) (actual time=0.069..0.071 rows=34 loops=1)
              Recheck Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
              Heap Blocks: exact=1
              Buffers: shared hit=76
              ->  Bitmap Index Scan on summary_one_per_hole_key  (cost=0.00..110.88 rows=41 width=0) (actual time=0.063..0.063 rows=34 loops=1)
                    Index Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
                    Buffers: shared hit=75
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..7.13 rows=1 width=32) (actual time=0.002..0.002 rows=1 loops=34)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=102
Planning:
  Buffers: shared hit=12
Planning Time: 0.149 ms
Execution Time: 0.177 ms
```

## inventory: filter project (slowest draw)

```sql
SELECT count(*)::int AS total FROM storage_unit su WHERE su.project_id = $1
```

```text
Aggregate  (cost=4.69..4.71 rows=1 width=4) (actual time=0.015..0.015 rows=1 loops=1)
  Buffers: shared hit=3
  ->  Index Only Scan using storage_unit_project_status_idx on storage_unit su  (cost=0.29..4.64 rows=20 width=0) (actual time=0.008..0.010 rows=25 loops=1)
        Index Cond: (project_id = 'bcc651ef-4e2b-4886-a9ac-797fc957abaf'::uuid)
        Heap Fetches: 0
        Buffers: shared hit=3
Planning Time: 0.098 ms
Execution Time: 0.032 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name FROM (SELECT su.id FROM storage_unit su WHERE su.project_id = $1 ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC LIMIT $2 OFFSET $3) page JOIN storage_unit su ON su.id = page.id JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC
```

```text
Sort  (cost=258.38..258.43 rows=20 width=247) (actual time=0.189..0.191 rows=25 loops=1)
  Sort Key: su.received_date DESC, su.readable_id COLLATE "C" DESC
  Sort Method: quicksort  Memory: 30kB
  Buffers: shared hit=237
  ->  Nested Loop  (cost=80.48..257.95 rows=20 width=247) (actual time=0.060..0.178 rows=25 loops=1)
        Buffers: shared hit=237
        ->  Nested Loop  (cost=80.34..254.70 rows=20 width=155) (actual time=0.054..0.151 rows=25 loops=1)
              Buffers: shared hit=187
              ->  Nested Loop  (cost=80.06..248.59 rows=20 width=84) (actual time=0.049..0.125 rows=25 loops=1)
                    Buffers: shared hit=112
                    ->  Limit  (cost=79.64..79.69 rows=20 width=52) (actual time=0.042..0.045 rows=25 loops=1)
                          Buffers: shared hit=12
                          ->  Sort  (cost=79.64..79.69 rows=20 width=52) (actual time=0.042..0.043 rows=25 loops=1)
                                Sort Key: su_1.received_date DESC, ((su_1.readable_id)::text) COLLATE "C" DESC
                                Sort Method: quicksort  Memory: 26kB
                                Buffers: shared hit=12
                                ->  Bitmap Heap Scan on storage_unit su_1  (cost=4.45..79.21 rows=20 width=52) (actual time=0.017..0.033 rows=25 loops=1)
                                      Recheck Cond: (project_id = 'bcc651ef-4e2b-4886-a9ac-797fc957abaf'::uuid)
                                      Heap Blocks: exact=10
                                      Buffers: shared hit=12
                                      ->  Bitmap Index Scan on storage_unit_project_status_idx  (cost=0.00..4.44 rows=20 width=0) (actual time=0.005..0.005 rows=25 loops=1)
                                            Index Cond: (project_id = 'bcc651ef-4e2b-4886-a9ac-797fc957abaf'::uuid)
                                            Buffers: shared hit=2
                    ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.42..8.44 rows=1 width=84) (actual time=0.003..0.003 rows=1 loops=25)
                          Index Cond: (id = su_1.id)
                          Buffers: shared hit=100
              ->  Index Scan using project_pkey on project p  (cost=0.28..0.31 rows=1 width=87) (actual time=0.001..0.001 rows=1 loops=25)
                    Index Cond: (id = su.project_id)
                    Buffers: shared hit=75
        ->  Index Scan using location_pkey on location l  (cost=0.14..0.16 rows=1 width=44) (actual time=0.001..0.001 rows=1 loops=25)
              Index Cond: (id = su.current_location_id)
              Buffers: shared hit=50
Planning:
  Buffers: shared hit=21
Planning Time: 0.469 ms
Execution Time: 0.230 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=552.66..552.76 rows=41 width=125) (actual time=0.160..0.161 rows=38 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 29kB
  Buffers: shared hit=198
  ->  Nested Loop  (cost=111.23..551.56 rows=41 width=125) (actual time=0.097..0.141 rows=38 loops=1)
        Buffers: shared hit=198
        ->  Bitmap Heap Scan on storage_unit_hole_summary h  (cost=110.95..259.15 rows=41 width=93) (actual time=0.091..0.102 rows=38 loops=1)
              Recheck Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
              Heap Blocks: exact=9
              Buffers: shared hit=84
              ->  Bitmap Index Scan on summary_one_per_hole_key  (cost=0.00..110.88 rows=41 width=0) (actual time=0.082..0.082 rows=38 loops=1)
                    Index Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
                    Buffers: shared hit=75
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..7.13 rows=1 width=32) (actual time=0.001..0.001 rows=1 loops=38)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=114
Planning:
  Buffers: shared hit=12
Planning Time: 0.174 ms
Execution Time: 0.178 ms
```

## inventory: filter project + test hole (slowest draw)

```sql
SELECT count(*)::int AS total FROM storage_unit su WHERE su.project_id = $1 AND EXISTS (SELECT 1 FROM storage_unit_hole_summary h WHERE h.storage_unit_id = su.id AND h.test_hole_id = $2) AND su.status <> 'disposed'
```

```text
Aggregate  (cost=119.44..119.45 rows=1 width=4) (actual time=0.085..0.086 rows=1 loops=1)
  Buffers: shared hit=33
  ->  Nested Loop  (cost=4.87..119.43 rows=1 width=0) (actual time=0.038..0.083 rows=7 loops=1)
        Buffers: shared hit=33
        ->  Bitmap Heap Scan on storage_unit su  (cost=4.44..79.25 rows=9 width=16) (actual time=0.032..0.070 rows=7 loops=1)
              Recheck Cond: (project_id = '1040387c-06ae-481d-a374-339d2a47383d'::uuid)
              Filter: (status <> 'disposed'::text)
              Rows Removed by Filter: 12
              Heap Blocks: exact=9
              Buffers: shared hit=11
              ->  Bitmap Index Scan on storage_unit_project_status_idx  (cost=0.00..4.44 rows=20 width=0) (actual time=0.026..0.026 rows=19 loops=1)
                    Index Cond: (project_id = '1040387c-06ae-481d-a374-339d2a47383d'::uuid)
                    Buffers: shared hit=2
        ->  Memoize  (cost=0.43..4.45 rows=1 width=16) (actual time=0.002..0.002 rows=1 loops=7)
              Cache Key: su.id
              Cache Mode: logical
              Hits: 0  Misses: 7  Evictions: 0  Overflows: 0  Memory Usage: 1kB
              Buffers: shared hit=22
              ->  Index Only Scan using summary_one_per_hole_key on storage_unit_hole_summary h  (cost=0.42..4.44 rows=1 width=16) (actual time=0.001..0.001 rows=1 loops=7)
                    Index Cond: ((storage_unit_id = su.id) AND (test_hole_id = '42565707-f395-49cc-a830-49aeb562f1c7'::uuid))
                    Heap Fetches: 0
                    Buffers: shared hit=22
Planning:
  Buffers: shared hit=16
Planning Time: 0.148 ms
Execution Time: 0.130 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name FROM (SELECT su.id FROM storage_unit su WHERE su.project_id = $1 AND EXISTS (SELECT 1 FROM storage_unit_hole_summary h WHERE h.storage_unit_id = su.id AND h.test_hole_id = $2) AND su.status <> 'disposed' ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC LIMIT $3 OFFSET $4) page JOIN storage_unit su ON su.id = page.id JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC
```

```text
Sort  (cost=128.82..128.83 rows=1 width=247) (actual time=0.057..0.058 rows=7 loops=1)
  Sort Key: su.received_date DESC, su.readable_id COLLATE "C" DESC
  Sort Method: quicksort  Memory: 26kB
  Buffers: shared hit=96
  ->  Nested Loop  (cost=120.73..128.81 rows=1 width=247) (actual time=0.037..0.054 rows=7 loops=1)
        Buffers: shared hit=96
        ->  Nested Loop  (cost=120.59..128.65 rows=1 width=155) (actual time=0.033..0.046 rows=7 loops=1)
              Buffers: shared hit=82
              ->  Nested Loop  (cost=120.31..128.34 rows=1 width=84) (actual time=0.030..0.040 rows=7 loops=1)
                    Buffers: shared hit=61
                    ->  Limit  (cost=119.89..119.90 rows=1 width=52) (actual time=0.027..0.028 rows=7 loops=1)
                          Buffers: shared hit=33
                          ->  Sort  (cost=119.89..119.90 rows=1 width=52) (actual time=0.027..0.028 rows=7 loops=1)
                                Sort Key: su_1.received_date DESC, ((su_1.readable_id)::text) COLLATE "C" DESC
                                Sort Method: quicksort  Memory: 25kB
                                Buffers: shared hit=33
                                ->  Nested Loop  (cost=4.86..119.88 rows=1 width=52) (actual time=0.014..0.024 rows=7 loops=1)
                                      Buffers: shared hit=33
                                      ->  Bitmap Heap Scan on storage_unit su_1  (cost=4.44..79.25 rows=9 width=35) (actual time=0.010..0.014 rows=7 loops=1)
                                            Recheck Cond: (project_id = '1040387c-06ae-481d-a374-339d2a47383d'::uuid)
                                            Filter: (status <> 'disposed'::text)
                                            Rows Removed by Filter: 12
                                            Heap Blocks: exact=9
                                            Buffers: shared hit=11
                                            ->  Bitmap Index Scan on storage_unit_project_status_idx  (cost=0.00..4.44 rows=20 width=0) (actual time=0.003..0.003 rows=19 loops=1)
                                                  Index Cond: (project_id = '1040387c-06ae-481d-a374-339d2a47383d'::uuid)
                                                  Buffers: shared hit=2
                                      ->  Index Only Scan using summary_one_per_hole_key on storage_unit_hole_summary h  (cost=0.42..4.44 rows=1 width=16) (actual time=0.001..0.001 rows=1 loops=7)
                                            Index Cond: ((storage_unit_id = su_1.id) AND (test_hole_id = '42565707-f395-49cc-a830-49aeb562f1c7'::uuid))
                                            Heap Fetches: 0
                                            Buffers: shared hit=22
                    ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.42..8.44 rows=1 width=84) (actual time=0.001..0.001 rows=1 loops=7)
                          Index Cond: (id = su_1.id)
                          Buffers: shared hit=28
              ->  Index Scan using project_pkey on project p  (cost=0.28..0.31 rows=1 width=87) (actual time=0.001..0.001 rows=1 loops=7)
                    Index Cond: (id = su.project_id)
                    Buffers: shared hit=21
        ->  Index Scan using location_pkey on location l  (cost=0.14..0.16 rows=1 width=44) (actual time=0.001..0.001 rows=1 loops=7)
              Index Cond: (id = su.current_location_id)
              Buffers: shared hit=14
Planning:
  Buffers: shared hit=37
Planning Time: 0.338 ms
Execution Time: 0.083 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=176.52..176.55 rows=12 width=125) (actual time=0.056..0.057 rows=12 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 26kB
  Buffers: shared hit=64
  ->  Nested Loop  (cost=31.33..176.31 rows=12 width=125) (actual time=0.025..0.043 rows=12 loops=1)
        Buffers: shared hit=64
        ->  Bitmap Heap Scan on storage_unit_hole_summary h  (cost=31.05..76.67 rows=12 width=93) (actual time=0.018..0.025 rows=12 loops=1)
              Recheck Cond: (storage_unit_id = ANY ('{7 uuids}'::uuid[]))
              Heap Blocks: exact=7
              Buffers: shared hit=28
              ->  Bitmap Index Scan on summary_one_per_hole_key  (cost=0.00..31.05 rows=12 width=0) (actual time=0.012..0.012 rows=12 loops=1)
                    Index Cond: (storage_unit_id = ANY ('{7 uuids}'::uuid[]))
                    Buffers: shared hit=21
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..8.30 rows=1 width=32) (actual time=0.001..0.001 rows=1 loops=12)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=36
Planning:
  Buffers: shared hit=12
Planning Time: 0.160 ms
Execution Time: 0.072 ms
```

## detail: storage unit (slowest draw)

```sql
SELECT id, readable_id, receipt_id FROM storage_unit WHERE readable_id = $1
```

```text
Index Scan using storage_unit_readable_id_key on storage_unit  (cost=0.42..8.44 rows=1 width=47) (actual time=0.011..0.011 rows=1 loops=1)
  Index Cond: (readable_id = 'BKT-2020-005793'::text)
  Buffers: shared hit=4
Planning Time: 0.052 ms
Execution Time: 0.018 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.note, su.received_date::text AS received_date, su.version, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name, r.id AS receipt_id, r.received_date::text AS receipt_received_date, rp.id AS receipt_project_id, rp.project_number AS receipt_project_number, rp.name AS receipt_project_name, rp.client AS receipt_client, r.receiver_initials_snapshot, r.receiver_name_snapshot, a.official_initials AS account_initials, a.display_name AS account_name, r.description, r.quantity, r.confirmed_at FROM storage_unit su JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id JOIN receipt r ON r.id = su.receipt_id JOIN project rp ON rp.id = r.project_id JOIN app_user a ON a.id = r.account_user_id WHERE su.id = $1
```

```text
Nested Loop  (cost=9.45..27.07 rows=1 width=450) (actual time=0.062..0.066 rows=1 loops=1)
  Buffers: shared hit=16
  ->  Nested Loop  (cost=9.30..26.90 rows=1 width=392) (actual time=0.051..0.054 rows=1 loops=1)
        Buffers: shared hit=14
        ->  Nested Loop  (cost=9.02..26.59 rows=1 width=321) (actual time=0.046..0.049 rows=1 loops=1)
              Buffers: shared hit=11
              ->  Nested Loop  (cost=8.73..18.28 rows=1 width=218) (actual time=0.038..0.041 rows=1 loops=1)
                    Buffers: shared hit=8
                    ->  Hash Join  (cost=8.45..9.98 rows=1 width=147) (actual time=0.030..0.033 rows=1 loops=1)
                          Hash Cond: (l.id = su.current_location_id)
                          Buffers: shared hit=5
                          ->  Seq Scan on location l  (cost=0.00..1.41 rows=41 width=44) (actual time=0.006..0.007 rows=41 loops=1)
                                Buffers: shared hit=1
                          ->  Hash  (cost=8.44..8.44 rows=1 width=119) (actual time=0.015..0.016 rows=1 loops=1)
                                Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                Buffers: shared hit=4
                                ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.42..8.44 rows=1 width=119) (actual time=0.009..0.010 rows=1 loops=1)
                                      Index Cond: (id = 'd1e3ab6b-d53b-4a4b-9cb5-57987ab97698'::uuid)
                                      Buffers: shared hit=4
                    ->  Index Scan using project_pkey on project p  (cost=0.28..8.30 rows=1 width=87) (actual time=0.006..0.006 rows=1 loops=1)
                          Index Cond: (id = su.project_id)
                          Buffers: shared hit=3
              ->  Index Scan using receipt_pkey on receipt r  (cost=0.29..8.31 rows=1 width=119) (actual time=0.007..0.008 rows=1 loops=1)
                    Index Cond: (id = su.receipt_id)
                    Buffers: shared hit=3
        ->  Index Scan using project_pkey on project rp  (cost=0.28..0.31 rows=1 width=87) (actual time=0.005..0.005 rows=1 loops=1)
              Index Cond: (id = r.project_id)
              Buffers: shared hit=3
  ->  Index Scan using app_user_pkey on app_user a  (cost=0.14..0.16 rows=1 width=34) (actual time=0.010..0.010 rows=1 loops=1)
        Index Cond: (id = r.account_user_id)
        Buffers: shared hit=2
Planning:
  Buffers: shared hit=41
Planning Time: 0.455 ms
Execution Time: 0.099 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=28.90..28.90 rows=2 width=125) (actual time=0.025..0.025 rows=2 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=10
  ->  Nested Loop  (cost=4.72..28.89 rows=2 width=125) (actual time=0.015..0.017 rows=2 loops=1)
        Buffers: shared hit=10
        ->  Bitmap Heap Scan on storage_unit_hole_summary h  (cost=4.44..12.28 rows=2 width=93) (actual time=0.010..0.010 rows=2 loops=1)
              Recheck Cond: (storage_unit_id = ANY ('{d1e3ab6b-d53b-4a4b-9cb5-57987ab97698}'::uuid[]))
              Heap Blocks: exact=1
              Buffers: shared hit=4
              ->  Bitmap Index Scan on summary_one_per_hole_key  (cost=0.00..4.43 rows=2 width=0) (actual time=0.006..0.006 rows=2 loops=1)
                    Index Cond: (storage_unit_id = ANY ('{d1e3ab6b-d53b-4a4b-9cb5-57987ab97698}'::uuid[]))
                    Buffers: shared hit=3
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..8.30 rows=1 width=32) (actual time=0.002..0.002 rows=1 loops=2)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=6
Planning:
  Buffers: shared hit=12
Planning Time: 0.140 ms
Execution Time: 0.040 ms
```

## detail: print history (slowest draw)

```sql
SELECT id, readable_id FROM storage_unit WHERE readable_id = upper($1)
```

```text
Index Scan using storage_unit_readable_id_key on storage_unit  (cost=0.42..8.44 rows=1 width=31) (actual time=0.006..0.007 rows=1 loops=1)
  Index Cond: (readable_id = 'ST-2023-000949'::text)
  Buffers: shared hit=4
Planning Time: 0.038 ms
Execution Time: 0.010 ms
```

```sql
SELECT j.id, j.kind, j.printer_key, p.name AS printer_name, j.template_version, j.status, j.attempts, j.last_error, j.printer_message, j.created_at, j.updated_at, j.sent_at, j.physically_confirmed_at, j.requested_by_user_id, rq.display_name AS requested_by_name, rq.official_initials AS requested_by_initials, j.receiver_user_id, rc.display_name AS receiver_name, rc.official_initials AS receiver_initials, j.physically_confirmed_by_user_id AS confirmed_by_user_id, cf.display_name AS confirmed_by_name, cf.official_initials AS confirmed_by_initials FROM print_job j JOIN printer p ON p.key = j.printer_key JOIN app_user rq ON rq.id = j.requested_by_user_id LEFT JOIN app_user rc ON rc.id = j.receiver_user_id LEFT JOIN app_user cf ON cf.id = j.physically_confirmed_by_user_id WHERE j.id IN (SELECT print_job_id FROM print_job_item WHERE storage_unit_id = $1) ORDER BY j.created_at DESC, j.id DESC LIMIT 100
```

```text
Limit  (cost=17.26..17.26 rows=1 width=268) (actual time=0.043..0.044 rows=2 loops=1)
  Buffers: shared hit=24
  ->  Sort  (cost=17.26..17.26 rows=1 width=268) (actual time=0.042..0.043 rows=2 loops=1)
        Sort Key: j.created_at DESC, j.id DESC
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=24
        ->  Nested Loop Left Join  (cost=1.13..17.25 rows=1 width=268) (actual time=0.029..0.039 rows=2 loops=1)
              Buffers: shared hit=24
              ->  Nested Loop Left Join  (cost=0.99..17.09 rows=1 width=250) (actual time=0.026..0.035 rows=2 loops=1)
                    Buffers: shared hit=22
                    ->  Nested Loop  (cost=0.84..16.93 rows=1 width=232) (actual time=0.019..0.027 rows=2 loops=1)
                          Buffers: shared hit=18
                          ->  Nested Loop  (cost=0.70..16.77 rows=1 width=214) (actual time=0.016..0.023 rows=2 loops=1)
                                Buffers: shared hit=14
                                ->  Nested Loop  (cost=0.58..16.61 rows=1 width=187) (actual time=0.014..0.018 rows=2 loops=1)
                                      Buffers: shared hit=10
                                      ->  Index Scan using print_job_item_unit_idx on print_job_item  (cost=0.29..8.31 rows=1 width=16) (actual time=0.008..0.009 rows=2 loops=1)
                                            Index Cond: (storage_unit_id = '212e0e97-a995-474b-8ac6-2153e926dacc'::uuid)
                                            Buffers: shared hit=4
                                      ->  Index Scan using print_job_pkey on print_job j  (cost=0.29..8.30 rows=1 width=187) (actual time=0.004..0.004 rows=1 loops=2)
                                            Index Cond: (id = print_job_item.print_job_id)
                                            Buffers: shared hit=6
                                ->  Index Scan using printer_pkey on printer p  (cost=0.12..0.14 rows=1 width=43) (actual time=0.001..0.001 rows=1 loops=2)
                                      Index Cond: (key = j.printer_key)
                                      Buffers: shared hit=4
                          ->  Index Scan using app_user_pkey on app_user rq  (cost=0.14..0.16 rows=1 width=34) (actual time=0.002..0.002 rows=1 loops=2)
                                Index Cond: (id = j.requested_by_user_id)
                                Buffers: shared hit=4
                    ->  Index Scan using app_user_pkey on app_user rc  (cost=0.14..0.16 rows=1 width=34) (actual time=0.003..0.003 rows=1 loops=2)
                          Index Cond: (id = j.receiver_user_id)
                          Buffers: shared hit=4
              ->  Index Scan using app_user_pkey on app_user cf  (cost=0.14..0.16 rows=1 width=34) (actual time=0.001..0.001 rows=0 loops=2)
                    Index Cond: (id = j.physically_confirmed_by_user_id)
                    Buffers: shared hit=2
Planning:
  Buffers: shared hit=35
Planning Time: 0.830 ms
Execution Time: 0.086 ms
```

```sql
SELECT i.print_job_id, i.storage_unit_id, su.readable_id, i.position FROM print_job_item i JOIN storage_unit su ON su.id = i.storage_unit_id WHERE i.print_job_id = ANY($1::uuid[]) ORDER BY i.print_job_id, i.position
```

```text
Sort  (cost=69.70..69.71 rows=5 width=51) (actual time=0.041..0.041 rows=8 loops=1)
  Sort Key: i.print_job_id, i."position"
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=40
  ->  Nested Loop  (cost=9.29..69.64 rows=5 width=51) (actual time=0.020..0.034 rows=8 loops=1)
        Buffers: shared hit=40
        ->  Bitmap Heap Scan on print_job_item i  (cost=8.88..27.47 rows=5 width=36) (actual time=0.017..0.018 rows=8 loops=1)
              Recheck Cond: (print_job_id = ANY ('{2 uuids}'::uuid[]))
              Heap Blocks: exact=2
              Buffers: shared hit=8
              ->  Bitmap Index Scan on print_job_item_print_job_id_position_key  (cost=0.00..8.88 rows=5 width=0) (actual time=0.012..0.012 rows=8 loops=1)
                    Index Cond: (print_job_id = ANY ('{2 uuids}'::uuid[]))
                    Buffers: shared hit=6
        ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.42..8.44 rows=1 width=31) (actual time=0.002..0.002 rows=1 loops=8)
              Index Cond: (id = i.storage_unit_id)
              Buffers: shared hit=32
Planning:
  Buffers: shared hit=14
Planning Time: 0.146 ms
Execution Time: 0.052 ms
```

## detail: history page 1 (slowest draw)

```sql
SELECT id, readable_id, receipt_id FROM storage_unit WHERE readable_id = $1
```

```text
Index Scan using storage_unit_readable_id_key on storage_unit  (cost=0.42..8.44 rows=1 width=47) (actual time=0.012..0.012 rows=1 loops=1)
  Index Cond: (readable_id = 'BKT-2025-005073'::text)
  Buffers: shared hit=4
Planning Time: 0.054 ms
Execution Time: 0.019 ms
```

```sql
SELECT count(*)::int AS total FROM audit_event e WHERE (e.entity_type = 'storage_unit' AND e.entity_id = $1) OR (e.entity_type = 'receipt' AND e.entity_id = $2)
```

```text
Aggregate  (cost=12.90..12.91 rows=1 width=4) (actual time=0.025..0.026 rows=1 loops=1)
  Buffers: shared hit=8
  ->  Bitmap Heap Scan on audit_event e  (cost=8.88..12.90 rows=1 width=0) (actual time=0.022..0.023 rows=2 loops=1)
        Recheck Cond: (((entity_type = 'storage_unit'::text) AND (entity_id = 'e00024dd-b39a-4332-8701-f1c84522e925'::uuid)) OR ((entity_type = 'receipt'::text) AND (entity_id = 'ecd488cc-5a87-43a1-a8ae-0b57db50012a'::uuid)))
        Heap Blocks: exact=2
        Buffers: shared hit=8
        ->  BitmapOr  (cost=8.88..8.88 rows=1 width=0) (actual time=0.017..0.017 rows=0 loops=1)
              Buffers: shared hit=6
              ->  Bitmap Index Scan on audit_event_entity_idx  (cost=0.00..4.44 rows=1 width=0) (actual time=0.008..0.008 rows=1 loops=1)
                    Index Cond: ((entity_type = 'storage_unit'::text) AND (entity_id = 'e00024dd-b39a-4332-8701-f1c84522e925'::uuid))
                    Buffers: shared hit=3
              ->  Bitmap Index Scan on audit_event_entity_idx  (cost=0.00..4.44 rows=1 width=0) (actual time=0.008..0.008 rows=1 loops=1)
                    Index Cond: ((entity_type = 'receipt'::text) AND (entity_id = 'ecd488cc-5a87-43a1-a8ae-0b57db50012a'::uuid))
                    Buffers: shared hit=3
Planning Time: 0.056 ms
Execution Time: 0.041 ms
```

```sql
SELECT e.id, e.occurred_at, e.action, e.actor_initials_snapshot, e.actor_name_snapshot, e.actor_account_type, r.official_initials AS receiver_initials, r.display_name AS receiver_name, e.reason, e.before_values, e.after_values FROM audit_event e LEFT JOIN app_user r ON r.id = e.receiver_user_id WHERE (e.entity_type = 'storage_unit' AND e.entity_id = $1) OR (e.entity_type = 'receipt' AND e.entity_id = $2) ORDER BY e.occurred_at DESC, e.id DESC LIMIT $3 OFFSET $4
```

```text
Limit  (cost=14.89..14.90 rows=1 width=161) (actual time=0.044..0.045 rows=2 loops=1)
  Buffers: shared hit=9
  ->  Sort  (cost=14.89..14.90 rows=1 width=161) (actual time=0.043..0.044 rows=2 loops=1)
        Sort Key: e.occurred_at DESC, e.id DESC
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=9
        ->  Hash Right Join  (cost=12.91..14.88 rows=1 width=161) (actual time=0.036..0.040 rows=2 loops=1)
              Hash Cond: (r.id = e.receiver_user_id)
              Buffers: shared hit=9
              ->  Seq Scan on app_user r  (cost=0.00..1.70 rows=70 width=34) (actual time=0.004..0.006 rows=70 loops=1)
                    Buffers: shared hit=1
              ->  Hash  (cost=12.90..12.90 rows=1 width=159) (actual time=0.026..0.026 rows=2 loops=1)
                    Buckets: 1024  Batches: 1  Memory Usage: 9kB
                    Buffers: shared hit=8
                    ->  Bitmap Heap Scan on audit_event e  (cost=8.88..12.90 rows=1 width=159) (actual time=0.022..0.023 rows=2 loops=1)
                          Recheck Cond: (((entity_type = 'storage_unit'::text) AND (entity_id = 'e00024dd-b39a-4332-8701-f1c84522e925'::uuid)) OR ((entity_type = 'receipt'::text) AND (entity_id = 'ecd488cc-5a87-43a1-a8ae-0b57db50012a'::uuid)))
                          Heap Blocks: exact=2
                          Buffers: shared hit=8
                          ->  BitmapOr  (cost=8.88..8.88 rows=1 width=0) (actual time=0.014..0.014 rows=0 loops=1)
                                Buffers: shared hit=6
                                ->  Bitmap Index Scan on audit_event_entity_idx  (cost=0.00..4.44 rows=1 width=0) (actual time=0.007..0.007 rows=1 loops=1)
                                      Index Cond: ((entity_type = 'storage_unit'::text) AND (entity_id = 'e00024dd-b39a-4332-8701-f1c84522e925'::uuid))
                                      Buffers: shared hit=3
                                ->  Bitmap Index Scan on audit_event_entity_idx  (cost=0.00..4.44 rows=1 width=0) (actual time=0.006..0.006 rows=1 loops=1)
                                      Index Cond: ((entity_type = 'receipt'::text) AND (entity_id = 'ecd488cc-5a87-43a1-a8ae-0b57db50012a'::uuid))
                                      Buffers: shared hit=3
Planning:
  Buffers: shared hit=1
Planning Time: 0.117 ms
Execution Time: 0.069 ms
```

## lookup: scan storage unit ID (slowest draw)

```sql
SELECT id, readable_id FROM storage_unit WHERE readable_id = $1
```

```text
Index Scan using storage_unit_readable_id_key on storage_unit  (cost=0.42..8.44 rows=1 width=31) (actual time=0.012..0.012 rows=1 loops=1)
  Index Cond: (readable_id = 'ST-2023-000949'::text)
  Buffers: shared hit=4
Planning Time: 0.054 ms
Execution Time: 0.020 ms
```

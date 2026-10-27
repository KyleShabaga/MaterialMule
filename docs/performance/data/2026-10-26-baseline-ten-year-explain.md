# EXPLAIN (ANALYZE, BUFFERS): materialmule_test_t19

Seed 20261025, 5 draws per request kind, run 2026-10-26T21:49:51.085Z.
Database execution time per request (all statements of the endpoint), warm cache.

| Request kind                             | median ms | max ms |
| ---------------------------------------- | --------: | -----: |
| inventory: search ID fragment            |      11.7 |   16.2 |
| inventory: search test hole              |       3.5 |   10.3 |
| inventory: search two words              |       3.8 |    4.1 |
| inventory: search one common word        |       3.3 |    4.0 |
| inventory: filter type + status          |       2.0 |    2.3 |
| inventory: default view, later page      |       1.7 |    2.0 |
| inventory: all statuses by ID, deep page |       1.7 |    2.0 |
| inventory: search + type + dates         |       1.4 |    1.8 |
| inventory: default view                  |       1.3 |    1.7 |
| inventory: search project number         |       0.5 |    0.5 |
| inventory: filter location               |       0.3 |    0.5 |
| inventory: filter received dates         |       0.3 |    0.3 |
| inventory: filter project                |       0.1 |    0.2 |
| inventory: filter project + test hole    |       0.1 |    0.2 |
| detail: print history                    |       0.1 |    0.2 |
| detail: storage unit                     |       0.1 |    0.1 |
| detail: history page 1                   |       0.1 |    0.1 |
| lookup: scan storage unit ID             |       0.0 |    0.0 |

## inventory: search ID fragment (slowest draw)

```sql
SELECT count(*)::int AS total FROM storage_unit su JOIN storage_unit_search s ON s.storage_unit_id = su.id WHERE s.document LIKE $1 AND su.status <> 'disposed'
```

```text
Aggregate  (cost=1425.59..1425.60 rows=1 width=4) (actual time=3.510..3.512 rows=1 loops=1)
  Buffers: shared hit=611
  ->  Hash Join  (cost=671.29..1424.61 rows=389 width=0) (actual time=1.126..3.498 rows=345 loops=1)
        Hash Cond: (su.id = s.storage_unit_id)
        Buffers: shared hit=611
        ->  Seq Scan on storage_unit su  (cost=0.00..728.06 rows=9623 width=16) (actual time=0.013..1.952 rows=9623 loops=1)
              Filter: (status <> 'disposed'::text)
              Rows Removed by Filter: 10382
              Buffers: shared hit=478
        ->  Hash  (cost=661.19..661.19 rows=808 width=16) (actual time=1.102..1.103 rows=999 loops=1)
              Buckets: 1024  Batches: 1  Memory Usage: 55kB
              Buffers: shared hit=133
              ->  Bitmap Heap Scan on storage_unit_search s  (cost=103.44..661.19 rows=808 width=16) (actual time=0.865..1.016 rows=999 loops=1)
                    Recheck Cond: (document ~~ '%bkt-2017-000%'::text)
                    Rows Removed by Index Recheck: 36
                    Heap Blocks: exact=57
                    Buffers: shared hit=133
                    ->  Bitmap Index Scan on storage_unit_search_document_trgm_idx  (cost=0.00..103.24 rows=808 width=0) (actual time=0.847..0.848 rows=1035 loops=1)
                          Index Cond: (document ~~ '%bkt-2017-000%'::text)
                          Buffers: shared hit=76
Planning:
  Buffers: shared hit=14
Planning Time: 0.256 ms
Execution Time: 3.611 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name FROM (SELECT su.id FROM storage_unit su JOIN storage_unit_search s ON s.storage_unit_id = su.id WHERE s.document LIKE $1 AND su.status <> 'disposed' ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC LIMIT $2 OFFSET $3) page JOIN storage_unit su ON su.id = page.id JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC
```

```text
Sort  (cost=639.81..639.87 rows=25 width=247) (actual time=12.261..12.264 rows=25 loops=1)
  Sort Key: su.received_date DESC, su.readable_id COLLATE "C" DESC
  Sort Method: quicksort  Memory: 30kB
  Buffers: shared hit=28879
  ->  Nested Loop  (cost=17.70..639.23 rows=25 width=247) (actual time=12.148..12.248 rows=25 loops=1)
        Buffers: shared hit=28879
        ->  Nested Loop  (cost=17.56..635.17 rows=25 width=155) (actual time=12.140..12.227 rows=25 loops=1)
              Buffers: shared hit=28829
              ->  Nested Loop  (cost=17.27..626.99 rows=25 width=84) (actual time=12.132..12.183 rows=25 loops=1)
                    Buffers: shared hit=28754
                    ->  Limit  (cost=16.99..427.12 rows=25 width=52) (actual time=12.114..12.116 rows=25 loops=1)
                          Buffers: shared hit=28679
                          ->  Incremental Sort  (cost=16.99..6398.59 rows=389 width=52) (actual time=12.113..12.115 rows=25 loops=1)
                                Sort Key: su_1.received_date DESC, ((su_1.readable_id)::text) COLLATE "C" DESC
                                Presorted Key: su_1.received_date
                                Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 26kB  Peak Memory: 26kB
                                Buffers: shared hit=28679
                                ->  Nested Loop  (cost=0.57..6381.09 rows=389 width=52) (actual time=12.056..12.101 rows=26 loops=1)
                                      Buffers: shared hit=28679
                                      ->  Index Scan Backward using storage_unit_received_date_idx on storage_unit su_1  (cost=0.29..950.02 rows=9623 width=35) (actual time=0.009..3.295 rows=9142 loops=1)
                                            Filter: (status <> 'disposed'::text)
                                            Rows Removed by Filter: 9490
                                            Buffers: shared hit=1253
                                      ->  Index Scan using storage_unit_search_pkey on storage_unit_search s  (cost=0.29..0.56 rows=1 width=16) (actual time=0.001..0.001 rows=0 loops=9142)
                                            Index Cond: (storage_unit_id = su_1.id)
                                            Filter: (document ~~ '%bkt-2017-000%'::text)
                                            Rows Removed by Filter: 1
                                            Buffers: shared hit=27426
                    ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.29..7.98 rows=1 width=84) (actual time=0.002..0.002 rows=1 loops=25)
                          Index Cond: (id = su_1.id)
                          Buffers: shared hit=75
              ->  Index Scan using project_pkey on project p  (cost=0.28..0.33 rows=1 width=87) (actual time=0.002..0.002 rows=1 loops=25)
                    Index Cond: (id = su.project_id)
                    Buffers: shared hit=75
        ->  Index Scan using location_pkey on location l  (cost=0.14..0.16 rows=1 width=44) (actual time=0.001..0.001 rows=1 loops=25)
              Index Cond: (id = su.current_location_id)
              Buffers: shared hit=50
Planning:
  Buffers: shared hit=37
Planning Time: 0.596 ms
Execution Time: 12.427 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=485.95..486.04 rows=37 width=127) (actual time=0.162..0.163 rows=36 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 29kB
  Buffers: shared hit=159
  ->  Nested Loop  (cost=103.73..484.98 rows=37 width=127) (actual time=0.067..0.132 rows=36 loops=1)
        Buffers: shared hit=159
        ->  Bitmap Heap Scan on storage_unit_hole_summary h  (cost=103.45..217.79 rows=37 width=95) (actual time=0.062..0.067 rows=36 loops=1)
              Recheck Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
              Heap Blocks: exact=3
              Buffers: shared hit=51
              ->  Bitmap Index Scan on summary_one_per_hole_key  (cost=0.00..103.38 rows=37 width=0) (actual time=0.053..0.053 rows=36 loops=1)
                    Index Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
                    Buffers: shared hit=48
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..7.22 rows=1 width=32) (actual time=0.002..0.002 rows=1 loops=36)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=108
Planning:
  Buffers: shared hit=12
Planning Time: 0.208 ms
Execution Time: 0.183 ms
```

## inventory: search test hole (slowest draw)

```sql
SELECT count(*)::int AS total FROM storage_unit su JOIN storage_unit_search s ON s.storage_unit_id = su.id WHERE s.document LIKE $1 AND su.status <> 'disposed'
```

```text
Aggregate  (cost=1373.88..1373.89 rows=1 width=4) (actual time=2.369..2.370 rows=1 loops=1)
  Buffers: shared hit=590
  ->  Hash Join  (cost=619.82..1373.15 rows=292 width=0) (actual time=0.779..2.355 rows=104 loops=1)
        Hash Cond: (su.id = s.storage_unit_id)
        Buffers: shared hit=590
        ->  Seq Scan on storage_unit su  (cost=0.00..728.06 rows=9623 width=16) (actual time=0.012..1.629 rows=9623 loops=1)
              Filter: (status <> 'disposed'::text)
              Rows Removed by Filter: 10382
              Buffers: shared hit=478
        ->  Hash  (cost=612.25..612.25 rows=606 width=16) (actual time=0.355..0.356 rows=337 loops=1)
              Buckets: 1024  Batches: 1  Memory Usage: 24kB
              Buffers: shared hit=112
              ->  Bitmap Heap Scan on storage_unit_search s  (cost=54.85..612.25 rows=606 width=16) (actual time=0.172..0.333 rows=337 loops=1)
                    Recheck Cond: (document ~~ '%mw19-01%'::text)
                    Rows Removed by Index Recheck: 68
                    Heap Blocks: exact=94
                    Buffers: shared hit=112
                    ->  Bitmap Index Scan on storage_unit_search_document_trgm_idx  (cost=0.00..54.69 rows=606 width=0) (actual time=0.158..0.158 rows=405 loops=1)
                          Index Cond: (document ~~ '%mw19-01%'::text)
                          Buffers: shared hit=18
Planning:
  Buffers: shared hit=14
Planning Time: 0.154 ms
Execution Time: 2.401 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name FROM (SELECT su.id FROM storage_unit su JOIN storage_unit_search s ON s.storage_unit_id = su.id WHERE s.document LIKE $1 AND su.status <> 'disposed' ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC LIMIT $2 OFFSET $3) page JOIN storage_unit su ON su.id = page.id JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC
```

```text
Sort  (cost=780.66..780.72 rows=25 width=247) (actual time=7.733..7.735 rows=25 loops=1)
  Sort Key: su.received_date DESC, su.readable_id COLLATE "C" DESC
  Sort Method: quicksort  Memory: 30kB
  Buffers: shared hit=22870
  ->  Nested Loop  (cost=23.15..780.08 rows=25 width=247) (actual time=7.632..7.726 rows=25 loops=1)
        Buffers: shared hit=22870
        ->  Nested Loop  (cost=23.01..776.02 rows=25 width=155) (actual time=7.624..7.705 rows=25 loops=1)
              Buffers: shared hit=22820
              ->  Nested Loop  (cost=22.72..767.84 rows=25 width=84) (actual time=7.618..7.661 rows=25 loops=1)
                    Buffers: shared hit=22745
                    ->  Limit  (cost=22.44..567.97 rows=25 width=52) (actual time=7.610..7.613 rows=25 loops=1)
                          Buffers: shared hit=22670
                          ->  Incremental Sort  (cost=22.44..6394.23 rows=292 width=52) (actual time=7.610..7.611 rows=25 loops=1)
                                Sort Key: su_1.received_date DESC, ((su_1.readable_id)::text) COLLATE "C" DESC
                                Presorted Key: su_1.received_date
                                Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 26kB  Peak Memory: 26kB
                                Buffers: shared hit=22670
                                ->  Nested Loop  (cost=0.57..6381.09 rows=292 width=52) (actual time=7.103..7.601 rows=26 loops=1)
                                      Buffers: shared hit=22670
                                      ->  Index Scan Backward using storage_unit_received_date_idx on storage_unit su_1  (cost=0.29..950.02 rows=9623 width=35) (actual time=0.007..1.471 rows=7262 loops=1)
                                            Filter: (status <> 'disposed'::text)
                                            Rows Removed by Filter: 6035
                                            Buffers: shared hit=884
                                      ->  Index Scan using storage_unit_search_pkey on storage_unit_search s  (cost=0.29..0.56 rows=1 width=16) (actual time=0.001..0.001 rows=0 loops=7262)
                                            Index Cond: (storage_unit_id = su_1.id)
                                            Filter: (document ~~ '%mw19-01%'::text)
                                            Rows Removed by Filter: 1
                                            Buffers: shared hit=21786
                    ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.29..7.98 rows=1 width=84) (actual time=0.002..0.002 rows=1 loops=25)
                          Index Cond: (id = su_1.id)
                          Buffers: shared hit=75
              ->  Index Scan using project_pkey on project p  (cost=0.28..0.33 rows=1 width=87) (actual time=0.002..0.002 rows=1 loops=25)
                    Index Cond: (id = su.project_id)
                    Buffers: shared hit=75
        ->  Index Scan using location_pkey on location l  (cost=0.14..0.16 rows=1 width=44) (actual time=0.001..0.001 rows=1 loops=25)
              Index Cond: (id = su.current_location_id)
              Buffers: shared hit=50
Planning:
  Buffers: shared hit=37
Planning Time: 0.368 ms
Execution Time: 7.758 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=485.95..486.04 rows=37 width=127) (actual time=0.163..0.164 rows=41 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 29kB
  Buffers: shared hit=183
  ->  Nested Loop  (cost=103.73..484.98 rows=37 width=127) (actual time=0.060..0.138 rows=41 loops=1)
        Buffers: shared hit=183
        ->  Bitmap Heap Scan on storage_unit_hole_summary h  (cost=103.45..217.79 rows=37 width=95) (actual time=0.055..0.068 rows=41 loops=1)
              Recheck Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
              Heap Blocks: exact=16
              Buffers: shared hit=60
              ->  Bitmap Index Scan on summary_one_per_hole_key  (cost=0.00..103.38 rows=37 width=0) (actual time=0.048..0.048 rows=41 loops=1)
                    Index Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
                    Buffers: shared hit=44
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..7.22 rows=1 width=32) (actual time=0.001..0.001 rows=1 loops=41)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=123
Planning:
  Buffers: shared hit=12
Planning Time: 0.174 ms
Execution Time: 0.180 ms
```

## inventory: search two words (slowest draw)

```sql
SELECT count(*)::int AS total FROM storage_unit su JOIN storage_unit_search s ON s.storage_unit_id = su.id WHERE s.document LIKE $1 AND s.document LIKE $2 AND su.status <> 'disposed'
```

```text
Aggregate  (cost=1211.61..1211.62 rows=1 width=4) (actual time=1.863..1.865 rows=1 loops=1)
  Buffers: shared hit=582
  ->  Hash Join  (cost=458.07..1211.39 rows=89 width=0) (actual time=0.348..1.860 rows=80 loops=1)
        Hash Cond: (su.id = s.storage_unit_id)
        Buffers: shared hit=582
        ->  Seq Scan on storage_unit su  (cost=0.00..728.06 rows=9623 width=16) (actual time=0.005..1.222 rows=9623 loops=1)
              Filter: (status <> 'disposed'::text)
              Rows Removed by Filter: 10382
              Buffers: shared hit=478
        ->  Hash  (cost=455.77..455.77 rows=184 width=16) (actual time=0.321..0.322 rows=183 loops=1)
              Buckets: 1024  Batches: 1  Memory Usage: 17kB
              Buffers: shared hit=104
              ->  Bitmap Heap Scan on storage_unit_search s  (cost=82.82..455.77 rows=184 width=16) (actual time=0.259..0.310 rows=183 loops=1)
                    Recheck Cond: ((document ~~ '%tamarack%'::text) AND (document ~~ '%hill%'::text))
                    Heap Blocks: exact=74
                    Buffers: shared hit=104
                    ->  Bitmap Index Scan on storage_unit_search_document_trgm_idx  (cost=0.00..82.77 rows=184 width=0) (actual time=0.253..0.253 rows=183 loops=1)
                          Index Cond: ((document ~~ '%tamarack%'::text) AND (document ~~ '%hill%'::text))
                          Buffers: shared hit=30
Planning:
  Buffers: shared hit=14
Planning Time: 0.155 ms
Execution Time: 1.917 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name FROM (SELECT su.id FROM storage_unit su JOIN storage_unit_search s ON s.storage_unit_id = su.id WHERE s.document LIKE $1 AND s.document LIKE $2 AND su.status <> 'disposed' ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC LIMIT $3 OFFSET $4) page JOIN storage_unit su ON su.id = page.id JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC
```

```text
Sort  (cost=1424.72..1424.78 rows=25 width=247) (actual time=1.881..1.883 rows=25 loops=1)
  Sort Key: su.received_date DESC, su.readable_id COLLATE "C" DESC
  Sort Method: quicksort  Memory: 30kB
  Buffers: shared hit=733
  ->  Hash Join  (cost=1216.39..1424.14 rows=25 width=247) (actual time=1.802..1.874 rows=25 loops=1)
        Hash Cond: (su.current_location_id = l.id)
        Buffers: shared hit=733
        ->  Nested Loop  (cost=1214.47..1422.01 rows=25 width=155) (actual time=1.779..1.845 rows=25 loops=1)
              Buffers: shared hit=732
              ->  Nested Loop  (cost=1214.19..1413.84 rows=25 width=84) (actual time=1.774..1.818 rows=25 loops=1)
                    Buffers: shared hit=657
                    ->  Limit  (cost=1213.90..1213.96 rows=25 width=52) (actual time=1.766..1.768 rows=25 loops=1)
                          Buffers: shared hit=582
                          ->  Sort  (cost=1213.90..1214.12 rows=89 width=52) (actual time=1.765..1.767 rows=25 loops=1)
                                Sort Key: su_1.received_date DESC, ((su_1.readable_id)::text) COLLATE "C" DESC
                                Sort Method: top-N heapsort  Memory: 28kB
                                Buffers: shared hit=582
                                ->  Hash Join  (cost=458.07..1211.39 rows=89 width=52) (actual time=0.339..1.752 rows=80 loops=1)
                                      Hash Cond: (su_1.id = s.storage_unit_id)
                                      Buffers: shared hit=582
                                      ->  Seq Scan on storage_unit su_1  (cost=0.00..728.06 rows=9623 width=35) (actual time=0.003..1.130 rows=9623 loops=1)
                                            Filter: (status <> 'disposed'::text)
                                            Rows Removed by Filter: 10382
                                            Buffers: shared hit=478
                                      ->  Hash  (cost=455.77..455.77 rows=184 width=16) (actual time=0.314..0.314 rows=183 loops=1)
                                            Buckets: 1024  Batches: 1  Memory Usage: 17kB
                                            Buffers: shared hit=104
                                            ->  Bitmap Heap Scan on storage_unit_search s  (cost=82.82..455.77 rows=184 width=16) (actual time=0.261..0.305 rows=183 loops=1)
                                                  Recheck Cond: ((document ~~ '%tamarack%'::text) AND (document ~~ '%hill%'::text))
                                                  Heap Blocks: exact=74
                                                  Buffers: shared hit=104
                                                  ->  Bitmap Index Scan on storage_unit_search_document_trgm_idx  (cost=0.00..82.77 rows=184 width=0) (actual time=0.253..0.254 rows=183 loops=1)
                                                        Index Cond: ((document ~~ '%tamarack%'::text) AND (document ~~ '%hill%'::text))
                                                        Buffers: shared hit=30
                    ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.29..7.98 rows=1 width=84) (actual time=0.002..0.002 rows=1 loops=25)
                          Index Cond: (id = su_1.id)
                          Buffers: shared hit=75
              ->  Index Scan using project_pkey on project p  (cost=0.28..0.33 rows=1 width=87) (actual time=0.001..0.001 rows=1 loops=25)
                    Index Cond: (id = su.project_id)
                    Buffers: shared hit=75
        ->  Hash  (cost=1.41..1.41 rows=41 width=44) (actual time=0.018..0.018 rows=41 loops=1)
              Buckets: 1024  Batches: 1  Memory Usage: 12kB
              Buffers: shared hit=1
              ->  Seq Scan on location l  (cost=0.00..1.41 rows=41 width=44) (actual time=0.010..0.012 rows=41 loops=1)
                    Buffers: shared hit=1
Planning:
  Buffers: shared hit=37
Planning Time: 0.427 ms
Execution Time: 1.968 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=493.22..493.31 rows=38 width=127) (actual time=0.154..0.155 rows=42 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 29kB
  Buffers: shared hit=189
  ->  Nested Loop  (cost=103.92..492.22 rows=38 width=127) (actual time=0.069..0.126 rows=42 loops=1)
        Buffers: shared hit=189
        ->  Bitmap Heap Scan on storage_unit_hole_summary h  (cost=103.63..220.72 rows=38 width=95) (actual time=0.063..0.074 rows=42 loops=1)
              Recheck Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
              Heap Blocks: exact=13
              Buffers: shared hit=63
              ->  Bitmap Index Scan on summary_one_per_hole_key  (cost=0.00..103.56 rows=38 width=0) (actual time=0.051..0.051 rows=42 loops=1)
                    Index Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
                    Buffers: shared hit=50
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..7.14 rows=1 width=32) (actual time=0.001..0.001 rows=1 loops=42)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=126
Planning:
  Buffers: shared hit=12
Planning Time: 0.199 ms
Execution Time: 0.172 ms
```

## inventory: search one common word (slowest draw)

```sql
SELECT count(*)::int AS total FROM storage_unit su JOIN storage_unit_search s ON s.storage_unit_id = su.id WHERE s.document LIKE $1 AND su.status <> 'disposed'
```

```text
Aggregate  (cost=1400.60..1400.61 rows=1 width=4) (actual time=3.423..3.424 rows=1 loops=1)
  Buffers: shared hit=987
  ->  Hash Join  (cost=643.87..1397.20 rows=1361 width=0) (actual time=1.195..3.374 rows=1762 loops=1)
        Hash Cond: (su.id = s.storage_unit_id)
        Buffers: shared hit=987
        ->  Seq Scan on storage_unit su  (cost=0.00..728.06 rows=9623 width=16) (actual time=0.005..1.464 rows=9623 loops=1)
              Filter: (status <> 'disposed'::text)
              Rows Removed by Filter: 10382
              Buffers: shared hit=478
        ->  Hash  (cost=608.51..608.51 rows=2829 width=16) (actual time=1.187..1.187 rows=3651 loops=1)
              Buckets: 4096  Batches: 1  Memory Usage: 204kB
              Buffers: shared hit=509
              ->  Bitmap Heap Scan on storage_unit_search s  (cost=49.15..608.51 rows=2829 width=16) (actual time=0.256..0.986 rows=3651 loops=1)
                    Recheck Cond: (document ~~ '%ridge%'::text)
                    Heap Blocks: exact=499
                    Buffers: shared hit=509
                    ->  Bitmap Index Scan on storage_unit_search_document_trgm_idx  (cost=0.00..48.44 rows=2829 width=0) (actual time=0.227..0.227 rows=3653 loops=1)
                          Index Cond: (document ~~ '%ridge%'::text)
                          Buffers: shared hit=10
Planning:
  Buffers: shared hit=14
Planning Time: 0.145 ms
Execution Time: 3.494 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name FROM (SELECT su.id FROM storage_unit su JOIN storage_unit_search s ON s.storage_unit_id = su.id WHERE s.document LIKE $1 AND su.status <> 'disposed' ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC LIMIT $2 OFFSET $3) page JOIN storage_unit su ON su.id = page.id JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC
```

```text
Sort  (cost=336.21..336.27 rows=25 width=247) (actual time=0.314..0.315 rows=25 loops=1)
  Sort Key: su.received_date DESC, su.readable_id COLLATE "C" DESC
  Sort Method: quicksort  Memory: 30kB
  Buffers: shared hit=553
  ->  Nested Loop  (cost=5.98..335.63 rows=25 width=247) (actual time=0.219..0.303 rows=25 loops=1)
        Buffers: shared hit=553
        ->  Nested Loop  (cost=5.84..331.57 rows=25 width=155) (actual time=0.214..0.287 rows=25 loops=1)
              Buffers: shared hit=503
              ->  Nested Loop  (cost=5.56..323.39 rows=25 width=84) (actual time=0.211..0.260 rows=25 loops=1)
                    Buffers: shared hit=428
                    ->  Limit  (cost=5.27..123.51 rows=25 width=52) (actual time=0.205..0.207 rows=25 loops=1)
                          Buffers: shared hit=353
                          ->  Incremental Sort  (cost=5.27..6442.33 rows=1361 width=52) (actual time=0.205..0.205 rows=25 loops=1)
                                Sort Key: su_1.received_date DESC, ((su_1.readable_id)::text) COLLATE "C" DESC
                                Presorted Key: su_1.received_date
                                Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 26kB  Peak Memory: 26kB
                                Buffers: shared hit=353
                                ->  Nested Loop  (cost=0.57..6381.09 rows=1361 width=52) (actual time=0.044..0.197 rows=26 loops=1)
                                      Buffers: shared hit=353
                                      ->  Index Scan Backward using storage_unit_received_date_idx on storage_unit su_1  (cost=0.29..950.02 rows=9623 width=35) (actual time=0.008..0.020 rows=116 loops=1)
                                            Filter: (status <> 'disposed'::text)
                                            Buffers: shared hit=5
                                      ->  Index Scan using storage_unit_search_pkey on storage_unit_search s  (cost=0.29..0.56 rows=1 width=16) (actual time=0.001..0.001 rows=0 loops=116)
                                            Index Cond: (storage_unit_id = su_1.id)
                                            Filter: (document ~~ '%ridge%'::text)
                                            Rows Removed by Filter: 1
                                            Buffers: shared hit=348
                    ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.29..7.98 rows=1 width=84) (actual time=0.002..0.002 rows=1 loops=25)
                          Index Cond: (id = su_1.id)
                          Buffers: shared hit=75
              ->  Index Scan using project_pkey on project p  (cost=0.28..0.33 rows=1 width=87) (actual time=0.001..0.001 rows=1 loops=25)
                    Index Cond: (id = su.project_id)
                    Buffers: shared hit=75
        ->  Index Scan using location_pkey on location l  (cost=0.14..0.16 rows=1 width=44) (actual time=0.000..0.000 rows=1 loops=25)
              Index Cond: (id = su.current_location_id)
              Buffers: shared hit=50
Planning:
  Buffers: shared hit=37
Planning Time: 0.401 ms
Execution Time: 0.341 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=493.22..493.31 rows=38 width=127) (actual time=0.146..0.147 rows=35 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 28kB
  Buffers: shared hit=156
  ->  Nested Loop  (cost=103.92..492.22 rows=38 width=127) (actual time=0.064..0.119 rows=35 loops=1)
        Buffers: shared hit=156
        ->  Bitmap Heap Scan on storage_unit_hole_summary h  (cost=103.63..220.72 rows=38 width=95) (actual time=0.057..0.062 rows=35 loops=1)
              Recheck Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
              Heap Blocks: exact=3
              Buffers: shared hit=51
              ->  Bitmap Index Scan on summary_one_per_hole_key  (cost=0.00..103.56 rows=38 width=0) (actual time=0.052..0.052 rows=35 loops=1)
                    Index Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
                    Buffers: shared hit=48
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..7.14 rows=1 width=32) (actual time=0.001..0.001 rows=1 loops=35)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=105
Planning:
  Buffers: shared hit=12
Planning Time: 0.157 ms
Execution Time: 0.161 ms
```

## inventory: filter type + status (slowest draw)

```sql
SELECT count(*)::int AS total FROM storage_unit su WHERE su.unit_type = $1 AND su.status = $2
```

```text
Aggregate  (cost=796.22..796.23 rows=1 width=4) (actual time=1.809..1.809 rows=1 loops=1)
  Buffers: shared hit=478
  ->  Seq Scan on storage_unit su  (cost=0.00..778.08 rows=7257 width=0) (actual time=0.006..1.632 rows=7271 loops=1)
        Filter: ((unit_type = 'bucket'::text) AND (status = 'disposed'::text))
        Rows Removed by Filter: 12734
        Buffers: shared hit=478
Planning Time: 0.052 ms
Execution Time: 1.818 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name FROM (SELECT su.id FROM storage_unit su WHERE su.unit_type = $1 AND su.status = $2 ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC LIMIT $3 OFFSET $4) page JOIN storage_unit su ON su.id = page.id JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC
```

```text
Sort  (cost=217.45..217.51 rows=25 width=247) (actual time=0.263..0.264 rows=25 loops=1)
  Sort Key: su.received_date DESC, su.readable_id COLLATE "C" DESC
  Sort Method: quicksort  Memory: 30kB
  Buffers: shared hit=305
  ->  Nested Loop  (cost=1.34..216.87 rows=25 width=247) (actual time=0.159..0.255 rows=25 loops=1)
        Buffers: shared hit=305
        ->  Nested Loop  (cost=1.20..212.81 rows=25 width=155) (actual time=0.153..0.235 rows=25 loops=1)
              Buffers: shared hit=255
              ->  Nested Loop  (cost=0.92..204.63 rows=25 width=84) (actual time=0.149..0.192 rows=25 loops=1)
                    Buffers: shared hit=180
                    ->  Limit  (cost=0.63..4.76 rows=25 width=52) (actual time=0.143..0.145 rows=25 loops=1)
                          Buffers: shared hit=105
                          ->  Incremental Sort  (cost=0.63..1197.02 rows=7257 width=52) (actual time=0.143..0.144 rows=25 loops=1)
                                Sort Key: su_1.received_date DESC, ((su_1.readable_id)::text) COLLATE "C" DESC
                                Presorted Key: su_1.received_date
                                Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 26kB  Peak Memory: 26kB
                                Buffers: shared hit=105
                                ->  Index Scan Backward using storage_unit_received_date_idx on storage_unit su_1  (cost=0.29..1000.03 rows=7257 width=52) (actual time=0.078..0.137 rows=26 loops=1)
                                      Filter: ((unit_type = 'bucket'::text) AND (status = 'disposed'::text))
                                      Rows Removed by Filter: 1582
                                      Buffers: shared hit=105
                    ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.29..7.98 rows=1 width=84) (actual time=0.002..0.002 rows=1 loops=25)
                          Index Cond: (id = su_1.id)
                          Buffers: shared hit=75
              ->  Index Scan using project_pkey on project p  (cost=0.28..0.33 rows=1 width=87) (actual time=0.002..0.002 rows=1 loops=25)
                    Index Cond: (id = su.project_id)
                    Buffers: shared hit=75
        ->  Index Scan using location_pkey on location l  (cost=0.14..0.16 rows=1 width=44) (actual time=0.001..0.001 rows=1 loops=25)
              Index Cond: (id = su.current_location_id)
              Buffers: shared hit=50
Planning:
  Buffers: shared hit=23
Planning Time: 0.265 ms
Execution Time: 0.286 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=485.95..486.04 rows=37 width=127) (actual time=0.177..0.178 rows=40 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 29kB
  Buffers: shared hit=183
  ->  Nested Loop  (cost=103.73..484.98 rows=37 width=127) (actual time=0.061..0.144 rows=40 loops=1)
        Buffers: shared hit=183
        ->  Bitmap Heap Scan on storage_unit_hole_summary h  (cost=103.45..217.79 rows=37 width=95) (actual time=0.055..0.066 rows=40 loops=1)
              Recheck Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
              Heap Blocks: exact=13
              Buffers: shared hit=63
              ->  Bitmap Index Scan on summary_one_per_hole_key  (cost=0.00..103.38 rows=37 width=0) (actual time=0.049..0.049 rows=40 loops=1)
                    Index Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
                    Buffers: shared hit=50
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..7.22 rows=1 width=32) (actual time=0.002..0.002 rows=1 loops=40)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=120
Planning:
  Buffers: shared hit=12
Planning Time: 0.143 ms
Execution Time: 0.192 ms
```

## inventory: default view, later page (slowest draw)

```sql
SELECT count(*)::int AS total FROM storage_unit su WHERE su.status <> 'disposed'
```

```text
Aggregate  (cost=474.43..474.44 rows=1 width=4) (actual time=1.661..1.662 rows=1 loops=1)
  Buffers: shared hit=25
  ->  Index Only Scan using storage_unit_location_idx on storage_unit su  (cost=0.29..450.38 rows=9623 width=0) (actual time=0.008..1.360 rows=9623 loops=1)
        Filter: (status <> 'disposed'::text)
        Rows Removed by Filter: 10382
        Heap Fetches: 0
        Buffers: shared hit=25
Planning Time: 0.078 ms
Execution Time: 1.677 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name FROM (SELECT su.id FROM storage_unit su WHERE su.status <> 'disposed' ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC LIMIT $1 OFFSET $2) page JOIN storage_unit su ON su.id = page.id JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC
```

```text
Sort  (cost=232.17..232.23 rows=25 width=247) (actual time=0.158..0.160 rows=25 loops=1)
  Sort Key: su.received_date DESC, su.readable_id COLLATE "C" DESC
  Sort Method: quicksort  Memory: 30kB
  Buffers: shared hit=206
  ->  Nested Loop  (cost=17.04..231.59 rows=25 width=247) (actual time=0.064..0.151 rows=25 loops=1)
        Buffers: shared hit=206
        ->  Nested Loop  (cost=16.90..227.53 rows=25 width=155) (actual time=0.061..0.136 rows=25 loops=1)
              Buffers: shared hit=156
              ->  Nested Loop  (cost=16.62..219.35 rows=25 width=84) (actual time=0.057..0.104 rows=25 loops=1)
                    Buffers: shared hit=81
                    ->  Limit  (cost=16.33..19.48 rows=25 width=52) (actual time=0.052..0.056 rows=25 loops=1)
                          Buffers: shared hit=6
                          ->  Incremental Sort  (cost=0.61..1210.82 rows=9623 width=52) (actual time=0.019..0.053 rows=150 loops=1)
                                Sort Key: su_1.received_date DESC, ((su_1.readable_id)::text) COLLATE "C" DESC
                                Presorted Key: su_1.received_date
                                Full-sort Groups: 5  Sort Methods: top-N heapsort, quicksort  Average Memory: 27kB  Peak Memory: 27kB
                                Buffers: shared hit=6
                                ->  Index Scan Backward using storage_unit_received_date_idx on storage_unit su_1  (cost=0.29..950.02 rows=9623 width=52) (actual time=0.007..0.024 rows=156 loops=1)
                                      Filter: (status <> 'disposed'::text)
                                      Buffers: shared hit=6
                    ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.29..7.98 rows=1 width=84) (actual time=0.002..0.002 rows=1 loops=25)
                          Index Cond: (id = su_1.id)
                          Buffers: shared hit=75
              ->  Index Scan using project_pkey on project p  (cost=0.28..0.33 rows=1 width=87) (actual time=0.001..0.001 rows=1 loops=25)
                    Index Cond: (id = su.project_id)
                    Buffers: shared hit=75
        ->  Index Scan using location_pkey on location l  (cost=0.14..0.16 rows=1 width=44) (actual time=0.000..0.000 rows=1 loops=25)
              Index Cond: (id = su.current_location_id)
              Buffers: shared hit=50
Planning:
  Buffers: shared hit=23
Planning Time: 0.309 ms
Execution Time: 0.182 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=485.95..486.04 rows=37 width=127) (actual time=0.134..0.135 rows=31 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 28kB
  Buffers: shared hit=143
  ->  Nested Loop  (cost=103.73..484.98 rows=37 width=127) (actual time=0.063..0.108 rows=31 loops=1)
        Buffers: shared hit=143
        ->  Bitmap Heap Scan on storage_unit_hole_summary h  (cost=103.45..217.79 rows=37 width=95) (actual time=0.056..0.059 rows=31 loops=1)
              Recheck Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
              Heap Blocks: exact=2
              Buffers: shared hit=50
              ->  Bitmap Index Scan on summary_one_per_hole_key  (cost=0.00..103.38 rows=37 width=0) (actual time=0.049..0.049 rows=31 loops=1)
                    Index Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
                    Buffers: shared hit=48
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..7.22 rows=1 width=32) (actual time=0.001..0.001 rows=1 loops=31)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=93
Planning:
  Buffers: shared hit=12
Planning Time: 0.185 ms
Execution Time: 0.152 ms
```

## inventory: all statuses by ID, deep page (slowest draw)

```sql
SELECT count(*)::int AS total FROM storage_unit su
```

```text
Aggregate  (cost=450.38..450.39 rows=1 width=4) (actual time=1.157..1.157 rows=1 loops=1)
  Buffers: shared hit=25
  ->  Index Only Scan using storage_unit_location_idx on storage_unit su  (cost=0.29..400.36 rows=20005 width=0) (actual time=0.008..0.641 rows=20005 loops=1)
        Heap Fetches: 0
        Buffers: shared hit=25
Planning Time: 0.051 ms
Execution Time: 1.166 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name FROM (SELECT su.id FROM storage_unit su ORDER BY su.readable_id COLLATE "C" ASC LIMIT $1 OFFSET $2) page JOIN storage_unit su ON su.id = page.id JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id ORDER BY su.readable_id COLLATE "C" ASC
```

```text
Sort  (cost=725.47..725.54 rows=25 width=243) (actual time=0.627..0.628 rows=25 loops=1)
  Sort Key: su.readable_id COLLATE "C"
  Sort Method: quicksort  Memory: 30kB
  Buffers: shared hit=339
  ->  Hash Join  (cost=514.32..724.89 rows=25 width=243) (actual time=0.541..0.618 rows=25 loops=1)
        Hash Cond: (su.current_location_id = l.id)
        Buffers: shared hit=339
        ->  Nested Loop  (cost=512.40..722.77 rows=25 width=155) (actual time=0.524..0.595 rows=25 loops=1)
              Buffers: shared hit=338
              ->  Nested Loop  (cost=512.11..714.59 rows=25 width=84) (actual time=0.517..0.556 rows=25 loops=1)
                    Buffers: shared hit=263
                    ->  Limit  (cost=511.83..514.72 rows=25 width=48) (actual time=0.511..0.516 rows=25 loops=1)
                          Buffers: shared hit=188
                          ->  Index Scan using storage_unit_readable_id_c_idx on storage_unit su_1  (cost=0.29..2312.91 rows=20005 width=48) (actual time=0.005..0.428 rows=4450 loops=1)
                                Buffers: shared hit=188
                    ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.29..7.98 rows=1 width=84) (actual time=0.001..0.001 rows=1 loops=25)
                          Index Cond: (id = su_1.id)
                          Buffers: shared hit=75
              ->  Index Scan using project_pkey on project p  (cost=0.28..0.33 rows=1 width=87) (actual time=0.001..0.001 rows=1 loops=25)
                    Index Cond: (id = su.project_id)
                    Buffers: shared hit=75
        ->  Hash  (cost=1.41..1.41 rows=41 width=44) (actual time=0.013..0.013 rows=41 loops=1)
              Buckets: 1024  Batches: 1  Memory Usage: 12kB
              Buffers: shared hit=1
              ->  Seq Scan on location l  (cost=0.00..1.41 rows=41 width=44) (actual time=0.005..0.007 rows=41 loops=1)
                    Buffers: shared hit=1
Planning:
  Buffers: shared hit=23
Planning Time: 0.286 ms
Execution Time: 0.651 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=485.95..486.04 rows=37 width=127) (actual time=0.145..0.146 rows=36 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 28kB
  Buffers: shared hit=156
  ->  Nested Loop  (cost=103.73..484.98 rows=37 width=127) (actual time=0.057..0.117 rows=36 loops=1)
        Buffers: shared hit=156
        ->  Bitmap Heap Scan on storage_unit_hole_summary h  (cost=103.45..217.79 rows=37 width=95) (actual time=0.052..0.054 rows=36 loops=1)
              Recheck Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
              Heap Blocks: exact=2
              Buffers: shared hit=48
              ->  Bitmap Index Scan on summary_one_per_hole_key  (cost=0.00..103.38 rows=37 width=0) (actual time=0.045..0.045 rows=36 loops=1)
                    Index Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
                    Buffers: shared hit=46
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..7.22 rows=1 width=32) (actual time=0.002..0.002 rows=1 loops=36)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=108
Planning:
  Buffers: shared hit=12
Planning Time: 0.135 ms
Execution Time: 0.160 ms
```

## inventory: search + type + dates (slowest draw)

```sql
SELECT count(*)::int AS total FROM storage_unit su JOIN storage_unit_search s ON s.storage_unit_id = su.id WHERE s.document LIKE $1 AND su.unit_type = $2 AND su.received_date >= $3::date AND su.received_date <= $4::date
```

```text
Aggregate  (cost=660.38..660.40 rows=1 width=4) (actual time=0.809..0.810 rows=1 loops=1)
  Buffers: shared hit=425
  ->  Hash Join  (cost=108.79..660.30 rows=33 width=0) (actual time=0.427..0.807 rows=30 loops=1)
        Hash Cond: (s.storage_unit_id = su.id)
        Buffers: shared hit=425
        ->  Bitmap Heap Scan on storage_unit_search s  (cost=69.89..616.63 rows=1819 width=16) (actual time=0.329..0.670 rows=1646 loops=1)
              Recheck Cond: (document ~~ '%tamarack%'::text)
              Heap Blocks: exact=381
              Buffers: shared hit=406
              ->  Bitmap Index Scan on storage_unit_search_document_trgm_idx  (cost=0.00..69.44 rows=1819 width=0) (actual time=0.305..0.305 rows=1646 loops=1)
                    Index Cond: (document ~~ '%tamarack%'::text)
                    Buffers: shared hit=25
        ->  Hash  (cost=34.37..34.37 rows=362 width=16) (actual time=0.068..0.068 rows=354 loops=1)
              Buckets: 1024  Batches: 1  Memory Usage: 25kB
              Buffers: shared hit=19
              ->  Index Scan using storage_unit_received_date_idx on storage_unit su  (cost=0.29..34.37 rows=362 width=16) (actual time=0.005..0.049 rows=354 loops=1)
                    Index Cond: ((received_date >= '2017-08-01'::date) AND (received_date <= '2017-10-28'::date))
                    Filter: (unit_type = 'bucket'::text)
                    Rows Removed by Filter: 165
                    Buffers: shared hit=19
Planning:
  Buffers: shared hit=14
Planning Time: 0.166 ms
Execution Time: 0.861 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name FROM (SELECT su.id FROM storage_unit su JOIN storage_unit_search s ON s.storage_unit_id = su.id WHERE s.document LIKE $1 AND su.unit_type = $2 AND su.received_date >= $3::date AND su.received_date <= $4::date ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC LIMIT $5 OFFSET $6) page JOIN storage_unit su ON su.id = page.id JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC
```

```text
Sort  (cost=871.95..872.01 rows=25 width=247) (actual time=0.786..0.788 rows=25 loops=1)
  Sort Key: su.received_date DESC, su.readable_id COLLATE "C" DESC
  Sort Method: quicksort  Memory: 30kB
  Buffers: shared hit=598
  ->  Hash Join  (cost=663.63..871.37 rows=25 width=247) (actual time=0.718..0.780 rows=25 loops=1)
        Hash Cond: (su.current_location_id = l.id)
        Buffers: shared hit=598
        ->  Nested Loop  (cost=661.70..869.25 rows=25 width=155) (actual time=0.700..0.756 rows=25 loops=1)
              Buffers: shared hit=597
              ->  Nested Loop  (cost=661.42..861.07 rows=25 width=84) (actual time=0.696..0.732 rows=25 loops=1)
                    Buffers: shared hit=522
                    ->  Limit  (cost=661.13..661.20 rows=25 width=52) (actual time=0.693..0.695 rows=25 loops=1)
                          Buffers: shared hit=447
                          ->  Sort  (cost=661.13..661.22 rows=33 width=52) (actual time=0.693..0.694 rows=25 loops=1)
                                Sort Key: su_1.received_date DESC, ((su_1.readable_id)::text) COLLATE "C" DESC
                                Sort Method: quicksort  Memory: 27kB
                                Buffers: shared hit=447
                                ->  Hash Join  (cost=108.79..660.30 rows=33 width=52) (actual time=0.403..0.687 rows=30 loops=1)
                                      Hash Cond: (s.storage_unit_id = su_1.id)
                                      Buffers: shared hit=447
                                      ->  Bitmap Heap Scan on storage_unit_search s  (cost=69.89..616.63 rows=1819 width=16) (actual time=0.293..0.532 rows=1646 loops=1)
                                            Recheck Cond: (document ~~ '%tamarack%'::text)
                                            Heap Blocks: exact=381
                                            Buffers: shared hit=406
                                            ->  Bitmap Index Scan on storage_unit_search_document_trgm_idx  (cost=0.00..69.44 rows=1819 width=0) (actual time=0.271..0.271 rows=1646 loops=1)
                                                  Index Cond: (document ~~ '%tamarack%'::text)
                                                  Buffers: shared hit=25
                                      ->  Hash  (cost=34.37..34.37 rows=362 width=35) (actual time=0.085..0.085 rows=354 loops=1)
                                            Buckets: 1024  Batches: 1  Memory Usage: 32kB
                                            Buffers: shared hit=41
                                            ->  Index Scan Backward using storage_unit_received_date_idx on storage_unit su_1  (cost=0.29..34.37 rows=362 width=35) (actual time=0.007..0.060 rows=354 loops=1)
                                                  Index Cond: ((received_date >= '2017-08-01'::date) AND (received_date <= '2017-10-28'::date))
                                                  Filter: (unit_type = 'bucket'::text)
                                                  Rows Removed by Filter: 165
                                                  Buffers: shared hit=41
                    ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.29..7.98 rows=1 width=84) (actual time=0.001..0.001 rows=1 loops=25)
                          Index Cond: (id = su_1.id)
                          Buffers: shared hit=75
              ->  Index Scan using project_pkey on project p  (cost=0.28..0.33 rows=1 width=87) (actual time=0.001..0.001 rows=1 loops=25)
                    Index Cond: (id = su.project_id)
                    Buffers: shared hit=75
        ->  Hash  (cost=1.41..1.41 rows=41 width=44) (actual time=0.013..0.013 rows=41 loops=1)
              Buckets: 1024  Batches: 1  Memory Usage: 12kB
              Buffers: shared hit=1
              ->  Seq Scan on location l  (cost=0.00..1.41 rows=41 width=44) (actual time=0.006..0.008 rows=41 loops=1)
                    Buffers: shared hit=1
Planning:
  Buffers: shared hit=37
Planning Time: 0.355 ms
Execution Time: 0.846 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=485.95..486.04 rows=37 width=127) (actual time=0.108..0.109 rows=34 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 28kB
  Buffers: shared hit=156
  ->  Nested Loop  (cost=103.73..484.98 rows=37 width=127) (actual time=0.045..0.089 rows=34 loops=1)
        Buffers: shared hit=156
        ->  Bitmap Heap Scan on storage_unit_hole_summary h  (cost=103.45..217.79 rows=37 width=95) (actual time=0.042..0.048 rows=34 loops=1)
              Recheck Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
              Heap Blocks: exact=8
              Buffers: shared hit=54
              ->  Bitmap Index Scan on summary_one_per_hole_key  (cost=0.00..103.38 rows=37 width=0) (actual time=0.036..0.036 rows=34 loops=1)
                    Index Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
                    Buffers: shared hit=46
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..7.22 rows=1 width=32) (actual time=0.001..0.001 rows=1 loops=34)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=102
Planning:
  Buffers: shared hit=12
Planning Time: 0.127 ms
Execution Time: 0.123 ms
```

## inventory: default view (slowest draw)

```sql
SELECT count(*)::int AS total FROM storage_unit su WHERE su.status <> 'disposed'
```

```text
Aggregate  (cost=474.43..474.44 rows=1 width=4) (actual time=1.288..1.288 rows=1 loops=1)
  Buffers: shared hit=25
  ->  Index Only Scan using storage_unit_location_idx on storage_unit su  (cost=0.29..450.38 rows=9623 width=0) (actual time=0.009..0.958 rows=9623 loops=1)
        Filter: (status <> 'disposed'::text)
        Rows Removed by Filter: 10382
        Heap Fetches: 0
        Buffers: shared hit=25
Planning Time: 0.086 ms
Execution Time: 1.306 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name FROM (SELECT su.id FROM storage_unit su WHERE su.status <> 'disposed' ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC LIMIT $1 OFFSET $2) page JOIN storage_unit su ON su.id = page.id JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC
```

```text
Sort  (cost=216.45..216.51 rows=25 width=247) (actual time=0.143..0.144 rows=25 loops=1)
  Sort Key: su.received_date DESC, su.readable_id COLLATE "C" DESC
  Sort Method: quicksort  Memory: 30kB
  Buffers: shared hit=203
  ->  Nested Loop  (cost=1.32..215.87 rows=25 width=247) (actual time=0.043..0.132 rows=25 loops=1)
        Buffers: shared hit=203
        ->  Nested Loop  (cost=1.18..211.81 rows=25 width=155) (actual time=0.038..0.114 rows=25 loops=1)
              Buffers: shared hit=153
              ->  Nested Loop  (cost=0.90..203.63 rows=25 width=84) (actual time=0.032..0.081 rows=25 loops=1)
                    Buffers: shared hit=78
                    ->  Limit  (cost=0.61..3.76 rows=25 width=52) (actual time=0.026..0.028 rows=25 loops=1)
                          Buffers: shared hit=3
                          ->  Incremental Sort  (cost=0.61..1210.82 rows=9623 width=52) (actual time=0.025..0.026 rows=25 loops=1)
                                Sort Key: su_1.received_date DESC, ((su_1.readable_id)::text) COLLATE "C" DESC
                                Presorted Key: su_1.received_date
                                Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 27kB  Peak Memory: 27kB
                                Buffers: shared hit=3
                                ->  Index Scan Backward using storage_unit_received_date_idx on storage_unit su_1  (cost=0.29..950.02 rows=9623 width=52) (actual time=0.010..0.014 rows=36 loops=1)
                                      Filter: (status <> 'disposed'::text)
                                      Buffers: shared hit=3
                    ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.29..7.98 rows=1 width=84) (actual time=0.002..0.002 rows=1 loops=25)
                          Index Cond: (id = su_1.id)
                          Buffers: shared hit=75
              ->  Index Scan using project_pkey on project p  (cost=0.28..0.33 rows=1 width=87) (actual time=0.001..0.001 rows=1 loops=25)
                    Index Cond: (id = su.project_id)
                    Buffers: shared hit=75
        ->  Index Scan using location_pkey on location l  (cost=0.14..0.16 rows=1 width=44) (actual time=0.000..0.000 rows=1 loops=25)
              Index Cond: (id = su.current_location_id)
              Buffers: shared hit=50
Planning:
  Buffers: shared hit=23
Planning Time: 0.385 ms
Execution Time: 0.186 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=485.95..486.04 rows=37 width=127) (actual time=0.152..0.153 rows=37 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 29kB
  Buffers: shared hit=162
  ->  Nested Loop  (cost=103.73..484.98 rows=37 width=127) (actual time=0.064..0.123 rows=37 loops=1)
        Buffers: shared hit=162
        ->  Bitmap Heap Scan on storage_unit_hole_summary h  (cost=103.45..217.79 rows=37 width=95) (actual time=0.059..0.060 rows=37 loops=1)
              Recheck Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
              Heap Blocks: exact=1
              Buffers: shared hit=51
              ->  Bitmap Index Scan on summary_one_per_hole_key  (cost=0.00..103.38 rows=37 width=0) (actual time=0.051..0.051 rows=37 loops=1)
                    Index Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
                    Buffers: shared hit=50
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..7.22 rows=1 width=32) (actual time=0.001..0.001 rows=1 loops=37)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=111
Planning:
  Buffers: shared hit=12
Planning Time: 0.182 ms
Execution Time: 0.170 ms
```

## inventory: search project number (slowest draw)

```sql
SELECT count(*)::int AS total FROM storage_unit su JOIN storage_unit_search s ON s.storage_unit_id = su.id WHERE s.document LIKE $1 AND su.status <> 'disposed'
```

```text
Aggregate  (cost=84.63..84.64 rows=1 width=4) (actual time=0.159..0.159 rows=1 loops=1)
  Buffers: shared hit=59
  ->  Nested Loop  (cost=60.64..84.63 rows=1 width=0) (actual time=0.147..0.157 rows=2 loops=1)
        Buffers: shared hit=59
        ->  Bitmap Heap Scan on storage_unit_search s  (cost=60.36..68.01 rows=2 width=16) (actual time=0.140..0.142 rows=10 loops=1)
              Recheck Cond: (document ~~ '%b20-0323%'::text)
              Heap Blocks: exact=3
              Buffers: shared hit=29
              ->  Bitmap Index Scan on storage_unit_search_document_trgm_idx  (cost=0.00..60.36 rows=2 width=0) (actual time=0.135..0.135 rows=10 loops=1)
                    Index Cond: (document ~~ '%b20-0323%'::text)
                    Buffers: shared hit=26
        ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.29..8.31 rows=1 width=16) (actual time=0.001..0.001 rows=0 loops=10)
              Index Cond: (id = s.storage_unit_id)
              Filter: (status <> 'disposed'::text)
              Rows Removed by Filter: 1
              Buffers: shared hit=30
Planning:
  Buffers: shared hit=14
Planning Time: 0.142 ms
Execution Time: 0.172 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name FROM (SELECT su.id FROM storage_unit su JOIN storage_unit_search s ON s.storage_unit_id = su.id WHERE s.document LIKE $1 AND su.status <> 'disposed' ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC LIMIT $2 OFFSET $3) page JOIN storage_unit su ON su.id = page.id JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC
```

```text
Sort  (cost=93.46..93.46 rows=1 width=247) (actual time=0.246..0.247 rows=2 loops=1)
  Sort Key: su.received_date DESC, su.readable_id COLLATE "C" DESC
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=75
  ->  Nested Loop  (cost=85.35..93.45 rows=1 width=247) (actual time=0.238..0.244 rows=2 loops=1)
        Buffers: shared hit=75
        ->  Nested Loop  (cost=85.21..93.28 rows=1 width=155) (actual time=0.233..0.237 rows=2 loops=1)
              Buffers: shared hit=71
              ->  Nested Loop  (cost=84.92..92.96 rows=1 width=84) (actual time=0.228..0.230 rows=2 loops=1)
                    Buffers: shared hit=65
                    ->  Limit  (cost=84.64..84.64 rows=1 width=52) (actual time=0.223..0.224 rows=2 loops=1)
                          Buffers: shared hit=59
                          ->  Sort  (cost=84.64..84.64 rows=1 width=52) (actual time=0.222..0.223 rows=2 loops=1)
                                Sort Key: su_1.received_date DESC, ((su_1.readable_id)::text) COLLATE "C" DESC
                                Sort Method: quicksort  Memory: 25kB
                                Buffers: shared hit=59
                                ->  Nested Loop  (cost=60.64..84.63 rows=1 width=52) (actual time=0.207..0.220 rows=2 loops=1)
                                      Buffers: shared hit=59
                                      ->  Bitmap Heap Scan on storage_unit_search s  (cost=60.36..68.01 rows=2 width=16) (actual time=0.193..0.197 rows=10 loops=1)
                                            Recheck Cond: (document ~~ '%b20-0323%'::text)
                                            Heap Blocks: exact=3
                                            Buffers: shared hit=29
                                            ->  Bitmap Index Scan on storage_unit_search_document_trgm_idx  (cost=0.00..60.36 rows=2 width=0) (actual time=0.183..0.183 rows=10 loops=1)
                                                  Index Cond: (document ~~ '%b20-0323%'::text)
                                                  Buffers: shared hit=26
                                      ->  Index Scan using storage_unit_pkey on storage_unit su_1  (cost=0.29..8.31 rows=1 width=35) (actual time=0.002..0.002 rows=0 loops=10)
                                            Index Cond: (id = s.storage_unit_id)
                                            Filter: (status <> 'disposed'::text)
                                            Rows Removed by Filter: 1
                                            Buffers: shared hit=30
                    ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.29..8.30 rows=1 width=84) (actual time=0.002..0.002 rows=1 loops=2)
                          Index Cond: (id = su_1.id)
                          Buffers: shared hit=6
              ->  Index Scan using project_pkey on project p  (cost=0.28..0.33 rows=1 width=87) (actual time=0.003..0.003 rows=1 loops=2)
                    Index Cond: (id = su.project_id)
                    Buffers: shared hit=6
        ->  Index Scan using location_pkey on location l  (cost=0.14..0.16 rows=1 width=44) (actual time=0.002..0.002 rows=1 loops=2)
              Index Cond: (id = su.current_location_id)
              Buffers: shared hit=4
Planning:
  Buffers: shared hit=37
Planning Time: 0.336 ms
Execution Time: 0.305 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=44.83..44.84 rows=3 width=127) (actual time=0.033..0.034 rows=2 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=11
  ->  Nested Loop  (cost=8.88..44.81 rows=3 width=127) (actual time=0.024..0.026 rows=2 loops=1)
        Buffers: shared hit=11
        ->  Bitmap Heap Scan on storage_unit_hole_summary h  (cost=8.59..19.90 rows=3 width=95) (actual time=0.017..0.017 rows=2 loops=1)
              Recheck Cond: (storage_unit_id = ANY ('{2 uuids}'::uuid[]))
              Heap Blocks: exact=1
              Buffers: shared hit=5
              ->  Bitmap Index Scan on summary_one_per_hole_key  (cost=0.00..8.59 rows=3 width=0) (actual time=0.009..0.009 rows=2 loops=1)
                    Index Cond: (storage_unit_id = ANY ('{2 uuids}'::uuid[]))
                    Buffers: shared hit=4
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..8.30 rows=1 width=32) (actual time=0.003..0.003 rows=1 loops=2)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=6
Planning:
  Buffers: shared hit=12
Planning Time: 0.173 ms
Execution Time: 0.050 ms
```

## inventory: filter location (slowest draw)

```sql
SELECT count(*)::int AS total FROM storage_unit su WHERE su.current_location_id = $1 AND su.status <> 'disposed'
```

```text
Aggregate  (cost=19.59..19.61 rows=1 width=4) (actual time=0.041..0.041 rows=1 loops=1)
  Buffers: shared hit=3
  ->  Index Only Scan using storage_unit_location_idx on storage_unit su  (cost=0.29..18.73 rows=347 width=0) (actual time=0.009..0.033 rows=297 loops=1)
        Index Cond: (current_location_id = 'f59551de-4222-4a40-8b18-27146faf0ccc'::uuid)
        Filter: (status <> 'disposed'::text)
        Rows Removed by Filter: 425
        Heap Fetches: 0
        Buffers: shared hit=3
Planning Time: 0.051 ms
Execution Time: 0.050 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name FROM (SELECT su.id FROM storage_unit su WHERE su.current_location_id = $1 AND su.status <> 'disposed' ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC LIMIT $2 OFFSET $3) page JOIN storage_unit su ON su.id = page.id JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC
```

```text
Sort  (cost=288.90..288.96 rows=25 width=247) (actual time=0.300..0.301 rows=25 loops=1)
  Sort Key: su.received_date DESC, su.readable_id COLLATE "C" DESC
  Sort Method: quicksort  Memory: 30kB
  Buffers: shared hit=314
  ->  Nested Loop  (cost=4.02..288.32 rows=25 width=247) (actual time=0.193..0.291 rows=25 loops=1)
        Buffers: shared hit=314
        ->  Nested Loop  (cost=3.88..284.26 rows=25 width=155) (actual time=0.187..0.272 rows=25 loops=1)
              Buffers: shared hit=264
              ->  Nested Loop  (cost=3.60..276.08 rows=25 width=84) (actual time=0.183..0.228 rows=25 loops=1)
                    Buffers: shared hit=189
                    ->  Limit  (cost=3.31..76.21 rows=25 width=52) (actual time=0.179..0.181 rows=25 loops=1)
                          Buffers: shared hit=114
                          ->  Incremental Sort  (cost=3.31..1015.12 rows=347 width=52) (actual time=0.179..0.180 rows=25 loops=1)
                                Sort Key: su_1.received_date DESC, ((su_1.readable_id)::text) COLLATE "C" DESC
                                Presorted Key: su_1.received_date
                                Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 26kB  Peak Memory: 26kB
                                Buffers: shared hit=114
                                ->  Index Scan Backward using storage_unit_received_date_idx on storage_unit su_1  (cost=0.29..1000.03 rows=347 width=52) (actual time=0.091..0.173 rows=26 loops=1)
                                      Filter: ((status <> 'disposed'::text) AND (current_location_id = 'f59551de-4222-4a40-8b18-27146faf0ccc'::uuid))
                                      Rows Removed by Filter: 1732
                                      Buffers: shared hit=114
                    ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.29..7.98 rows=1 width=84) (actual time=0.002..0.002 rows=1 loops=25)
                          Index Cond: (id = su_1.id)
                          Buffers: shared hit=75
              ->  Index Scan using project_pkey on project p  (cost=0.28..0.33 rows=1 width=87) (actual time=0.001..0.001 rows=1 loops=25)
                    Index Cond: (id = su.project_id)
                    Buffers: shared hit=75
        ->  Index Scan using location_pkey on location l  (cost=0.14..0.16 rows=1 width=44) (actual time=0.000..0.000 rows=1 loops=25)
              Index Cond: (id = su.current_location_id)
              Buffers: shared hit=50
Planning:
  Buffers: shared hit=23
Planning Time: 0.257 ms
Execution Time: 0.324 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=485.95..486.04 rows=37 width=127) (actual time=0.131..0.132 rows=38 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 29kB
  Buffers: shared hit=173
  ->  Nested Loop  (cost=103.73..484.98 rows=37 width=127) (actual time=0.047..0.103 rows=38 loops=1)
        Buffers: shared hit=173
        ->  Bitmap Heap Scan on storage_unit_hole_summary h  (cost=103.45..217.79 rows=37 width=95) (actual time=0.043..0.050 rows=38 loops=1)
              Recheck Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
              Heap Blocks: exact=15
              Buffers: shared hit=59
              ->  Bitmap Index Scan on summary_one_per_hole_key  (cost=0.00..103.38 rows=37 width=0) (actual time=0.033..0.033 rows=38 loops=1)
                    Index Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
                    Buffers: shared hit=44
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..7.22 rows=1 width=32) (actual time=0.001..0.001 rows=1 loops=38)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=114
Planning:
  Buffers: shared hit=12
Planning Time: 0.155 ms
Execution Time: 0.147 ms
```

## inventory: filter received dates (slowest draw)

```sql
SELECT count(*)::int AS total FROM storage_unit su WHERE su.received_date >= $1::date AND su.received_date <= $2::date
```

```text
Aggregate  (cost=14.84..14.85 rows=1 width=4) (actual time=0.070..0.070 rows=1 loops=1)
  Buffers: shared hit=4
  ->  Index Only Scan using storage_unit_received_date_idx on storage_unit su  (cost=0.29..13.67 rows=469 width=0) (actual time=0.017..0.046 rows=473 loops=1)
        Index Cond: ((received_date >= '2019-06-01'::date) AND (received_date <= '2019-08-28'::date))
        Heap Fetches: 0
        Buffers: shared hit=4
Planning Time: 0.108 ms
Execution Time: 0.087 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name FROM (SELECT su.id FROM storage_unit su WHERE su.received_date >= $1::date AND su.received_date <= $2::date ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC LIMIT $3 OFFSET $4) page JOIN storage_unit su ON su.id = page.id JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC
```

```text
Sort  (cost=215.76..215.83 rows=25 width=247) (actual time=0.105..0.106 rows=25 loops=1)
  Sort Key: su.received_date DESC, su.readable_id COLLATE "C" DESC
  Sort Method: quicksort  Memory: 30kB
  Buffers: shared hit=206
  ->  Nested Loop  (cost=1.08..215.18 rows=25 width=247) (actual time=0.031..0.097 rows=25 loops=1)
        Buffers: shared hit=206
        ->  Nested Loop  (cost=0.94..211.12 rows=25 width=155) (actual time=0.025..0.080 rows=25 loops=1)
              Buffers: shared hit=156
              ->  Nested Loop  (cost=0.65..202.95 rows=25 width=84) (actual time=0.022..0.053 rows=25 loops=1)
                    Buffers: shared hit=81
                    ->  Limit  (cost=0.37..3.07 rows=25 width=52) (actual time=0.018..0.020 rows=25 loops=1)
                          Buffers: shared hit=6
                          ->  Incremental Sort  (cost=0.37..51.09 rows=469 width=52) (actual time=0.018..0.018 rows=25 loops=1)
                                Sort Key: su_1.received_date DESC, ((su_1.readable_id)::text) COLLATE "C" DESC
                                Presorted Key: su_1.received_date
                                Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 27kB  Peak Memory: 27kB
                                Buffers: shared hit=6
                                ->  Index Scan Backward using storage_unit_received_date_idx on storage_unit su_1  (cost=0.29..30.97 rows=469 width=52) (actual time=0.006..0.010 rows=30 loops=1)
                                      Index Cond: ((received_date >= '2019-06-01'::date) AND (received_date <= '2019-08-28'::date))
                                      Buffers: shared hit=6
                    ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.29..7.98 rows=1 width=84) (actual time=0.001..0.001 rows=1 loops=25)
                          Index Cond: (id = su_1.id)
                          Buffers: shared hit=75
              ->  Index Scan using project_pkey on project p  (cost=0.28..0.33 rows=1 width=87) (actual time=0.001..0.001 rows=1 loops=25)
                    Index Cond: (id = su.project_id)
                    Buffers: shared hit=75
        ->  Index Scan using location_pkey on location l  (cost=0.14..0.16 rows=1 width=44) (actual time=0.000..0.000 rows=1 loops=25)
              Index Cond: (id = su.current_location_id)
              Buffers: shared hit=50
Planning:
  Buffers: shared hit=23
Planning Time: 0.262 ms
Execution Time: 0.127 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=485.95..486.04 rows=37 width=127) (actual time=0.105..0.106 rows=37 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 29kB
  Buffers: shared hit=162
  ->  Nested Loop  (cost=103.73..484.98 rows=37 width=127) (actual time=0.040..0.081 rows=37 loops=1)
        Buffers: shared hit=162
        ->  Bitmap Heap Scan on storage_unit_hole_summary h  (cost=103.45..217.79 rows=37 width=95) (actual time=0.035..0.036 rows=37 loops=1)
              Recheck Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
              Heap Blocks: exact=1
              Buffers: shared hit=51
              ->  Bitmap Index Scan on summary_one_per_hole_key  (cost=0.00..103.38 rows=37 width=0) (actual time=0.029..0.029 rows=37 loops=1)
                    Index Cond: (storage_unit_id = ANY ('{25 uuids}'::uuid[]))
                    Buffers: shared hit=50
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..7.22 rows=1 width=32) (actual time=0.001..0.001 rows=1 loops=37)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=111
Planning:
  Buffers: shared hit=12
Planning Time: 0.127 ms
Execution Time: 0.121 ms
```

## inventory: filter project (slowest draw)

```sql
SELECT count(*)::int AS total FROM storage_unit su WHERE su.project_id = $1
```

```text
Aggregate  (cost=4.39..4.40 rows=1 width=4) (actual time=0.011..0.011 rows=1 loops=1)
  Buffers: shared hit=3
  ->  Index Only Scan using storage_unit_project_status_idx on storage_unit su  (cost=0.29..4.37 rows=5 width=0) (actual time=0.008..0.009 rows=9 loops=1)
        Index Cond: (project_id = '39401db4-73d5-45af-9d43-06f610a557c6'::uuid)
        Heap Fetches: 0
        Buffers: shared hit=3
Planning Time: 0.054 ms
Execution Time: 0.020 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name FROM (SELECT su.id FROM storage_unit su WHERE su.project_id = $1 ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC LIMIT $2 OFFSET $3) page JOIN storage_unit su ON su.id = page.id JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC
```

```text
Sort  (cost=67.01..67.02 rows=5 width=247) (actual time=0.066..0.066 rows=9 loops=1)
  Sort Key: su.received_date DESC, su.readable_id COLLATE "C" DESC
  Sort Method: quicksort  Memory: 27kB
  Buffers: shared hit=77
  ->  Nested Loop  (cost=23.62..66.95 rows=5 width=247) (actual time=0.034..0.061 rows=9 loops=1)
        Buffers: shared hit=77
        ->  Nested Loop  (cost=23.48..66.14 rows=5 width=155) (actual time=0.031..0.054 rows=9 loops=1)
              Buffers: shared hit=59
              ->  Nested Loop  (cost=23.20..64.50 rows=5 width=84) (actual time=0.024..0.041 rows=9 loops=1)
                    Buffers: shared hit=32
                    ->  Limit  (cost=22.91..22.93 rows=5 width=52) (actual time=0.019..0.020 rows=9 loops=1)
                          Buffers: shared hit=5
                          ->  Sort  (cost=22.91..22.93 rows=5 width=52) (actual time=0.019..0.019 rows=9 loops=1)
                                Sort Key: su_1.received_date DESC, ((su_1.readable_id)::text) COLLATE "C" DESC
                                Sort Method: quicksort  Memory: 25kB
                                Buffers: shared hit=5
                                ->  Bitmap Heap Scan on storage_unit su_1  (cost=4.33..22.85 rows=5 width=52) (actual time=0.011..0.015 rows=9 loops=1)
                                      Recheck Cond: (project_id = '39401db4-73d5-45af-9d43-06f610a557c6'::uuid)
                                      Heap Blocks: exact=3
                                      Buffers: shared hit=5
                                      ->  Bitmap Index Scan on storage_unit_project_status_idx  (cost=0.00..4.32 rows=5 width=0) (actual time=0.005..0.005 rows=9 loops=1)
                                            Index Cond: (project_id = '39401db4-73d5-45af-9d43-06f610a557c6'::uuid)
                                            Buffers: shared hit=2
                    ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.29..8.30 rows=1 width=84) (actual time=0.002..0.002 rows=1 loops=9)
                          Index Cond: (id = su_1.id)
                          Buffers: shared hit=27
              ->  Index Scan using project_pkey on project p  (cost=0.28..0.33 rows=1 width=87) (actual time=0.001..0.001 rows=1 loops=9)
                    Index Cond: (id = su.project_id)
                    Buffers: shared hit=27
        ->  Index Scan using location_pkey on location l  (cost=0.14..0.16 rows=1 width=44) (actual time=0.001..0.001 rows=1 loops=9)
              Index Cond: (id = su.current_location_id)
              Buffers: shared hit=18
Planning:
  Buffers: shared hit=23
Planning Time: 0.262 ms
Execution Time: 0.091 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=188.49..188.53 rows=13 width=127) (actual time=0.060..0.061 rows=14 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 26kB
  Buffers: shared hit=63
  ->  Nested Loop  (cost=38.97..188.25 rows=13 width=127) (actual time=0.034..0.049 rows=14 loops=1)
        Buffers: shared hit=63
        ->  Bitmap Heap Scan on storage_unit_hole_summary h  (cost=38.68..84.32 rows=13 width=95) (actual time=0.028..0.031 rows=14 loops=1)
              Recheck Cond: (storage_unit_id = ANY ('{9 uuids}'::uuid[]))
              Heap Blocks: exact=3
              Buffers: shared hit=21
              ->  Bitmap Index Scan on summary_one_per_hole_key  (cost=0.00..38.66 rows=13 width=0) (actual time=0.023..0.023 rows=14 loops=1)
                    Index Cond: (storage_unit_id = ANY ('{9 uuids}'::uuid[]))
                    Buffers: shared hit=18
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..7.99 rows=1 width=32) (actual time=0.001..0.001 rows=1 loops=14)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=42
Planning:
  Buffers: shared hit=12
Planning Time: 0.133 ms
Execution Time: 0.074 ms
```

## inventory: filter project + test hole (slowest draw)

```sql
SELECT count(*)::int AS total FROM storage_unit su WHERE su.project_id = $1 AND EXISTS (SELECT 1 FROM storage_unit_hole_summary h WHERE h.storage_unit_id = su.id AND h.test_hole_id = $2) AND su.status <> 'disposed'
```

```text
Aggregate  (cost=31.53..31.54 rows=1 width=4) (actual time=0.005..0.006 rows=1 loops=1)
  Buffers: shared hit=2
  ->  Nested Loop  (cost=4.62..31.53 rows=1 width=0) (actual time=0.004..0.004 rows=0 loops=1)
        Buffers: shared hit=2
        ->  Bitmap Heap Scan on storage_unit su  (cost=4.33..22.87 rows=2 width=16) (actual time=0.004..0.004 rows=0 loops=1)
              Recheck Cond: (project_id = '169fa9cf-772b-4237-baaf-7af30d09e2ba'::uuid)
              Filter: (status <> 'disposed'::text)
              Buffers: shared hit=2
              ->  Bitmap Index Scan on storage_unit_project_status_idx  (cost=0.00..4.32 rows=5 width=0) (actual time=0.001..0.001 rows=0 loops=1)
                    Index Cond: (project_id = '169fa9cf-772b-4237-baaf-7af30d09e2ba'::uuid)
                    Buffers: shared hit=2
        ->  Memoize  (cost=0.30..4.32 rows=1 width=16) (never executed)
              Cache Key: su.id
              Cache Mode: logical
              ->  Index Only Scan using summary_one_per_hole_key on storage_unit_hole_summary h  (cost=0.29..4.31 rows=1 width=16) (never executed)
                    Index Cond: ((storage_unit_id = su.id) AND (test_hole_id = '31c09f98-02e1-49bb-96ba-95818832bf07'::uuid))
                    Heap Fetches: 0
Planning:
  Buffers: shared hit=12
Planning Time: 0.179 ms
Execution Time: 0.135 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text AS received_date, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name FROM (SELECT su.id FROM storage_unit su WHERE su.project_id = $1 AND EXISTS (SELECT 1 FROM storage_unit_hole_summary h WHERE h.storage_unit_id = su.id AND h.test_hole_id = $2) AND su.status <> 'disposed' ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC LIMIT $3 OFFSET $4) page JOIN storage_unit su ON su.id = page.id JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id ORDER BY su.received_date DESC, su.readable_id COLLATE "C" DESC
```

```text
Sort  (cost=40.36..40.36 rows=1 width=247) (actual time=0.011..0.012 rows=0 loops=1)
  Sort Key: su.received_date DESC, su.readable_id COLLATE "C" DESC
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=2
  ->  Nested Loop  (cost=32.25..40.35 rows=1 width=247) (actual time=0.009..0.010 rows=0 loops=1)
        Buffers: shared hit=2
        ->  Nested Loop  (cost=32.11..40.18 rows=1 width=155) (actual time=0.009..0.009 rows=0 loops=1)
              Buffers: shared hit=2
              ->  Nested Loop  (cost=31.82..39.86 rows=1 width=84) (actual time=0.009..0.009 rows=0 loops=1)
                    Buffers: shared hit=2
                    ->  Limit  (cost=31.54..31.54 rows=1 width=52) (actual time=0.009..0.009 rows=0 loops=1)
                          Buffers: shared hit=2
                          ->  Sort  (cost=31.54..31.54 rows=1 width=52) (actual time=0.009..0.009 rows=0 loops=1)
                                Sort Key: su_1.received_date DESC, ((su_1.readable_id)::text) COLLATE "C" DESC
                                Sort Method: quicksort  Memory: 25kB
                                Buffers: shared hit=2
                                ->  Nested Loop  (cost=4.62..31.53 rows=1 width=52) (actual time=0.006..0.006 rows=0 loops=1)
                                      Buffers: shared hit=2
                                      ->  Bitmap Heap Scan on storage_unit su_1  (cost=4.33..22.87 rows=2 width=35) (actual time=0.006..0.006 rows=0 loops=1)
                                            Recheck Cond: (project_id = '169fa9cf-772b-4237-baaf-7af30d09e2ba'::uuid)
                                            Filter: (status <> 'disposed'::text)
                                            Buffers: shared hit=2
                                            ->  Bitmap Index Scan on storage_unit_project_status_idx  (cost=0.00..4.32 rows=5 width=0) (actual time=0.002..0.002 rows=0 loops=1)
                                                  Index Cond: (project_id = '169fa9cf-772b-4237-baaf-7af30d09e2ba'::uuid)
                                                  Buffers: shared hit=2
                                      ->  Memoize  (cost=0.30..4.32 rows=1 width=16) (never executed)
                                            Cache Key: su_1.id
                                            Cache Mode: logical
                                            ->  Index Only Scan using summary_one_per_hole_key on storage_unit_hole_summary h  (cost=0.29..4.31 rows=1 width=16) (never executed)
                                                  Index Cond: ((storage_unit_id = su_1.id) AND (test_hole_id = '31c09f98-02e1-49bb-96ba-95818832bf07'::uuid))
                                                  Heap Fetches: 0
                    ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.29..8.30 rows=1 width=84) (never executed)
                          Index Cond: (id = su_1.id)
              ->  Index Scan using project_pkey on project p  (cost=0.28..0.33 rows=1 width=87) (never executed)
                    Index Cond: (id = su.project_id)
        ->  Index Scan using location_pkey on location l  (cost=0.14..0.16 rows=1 width=44) (never executed)
              Index Cond: (id = su.current_location_id)
Planning:
  Buffers: shared hit=35
Planning Time: 0.324 ms
Execution Time: 0.047 ms
```

## detail: print history (slowest draw)

```sql
SELECT id, readable_id FROM storage_unit WHERE readable_id = upper($1)
```

```text
Index Scan using storage_unit_readable_id_key on storage_unit  (cost=0.29..8.30 rows=1 width=31) (actual time=0.008..0.009 rows=1 loops=1)
  Index Cond: (readable_id = 'BKT-2025-000232'::text)
  Buffers: shared hit=3
Planning Time: 0.049 ms
Execution Time: 0.014 ms
```

```sql
SELECT j.id, j.kind, j.printer_key, p.name AS printer_name, j.template_version, j.status, j.attempts, j.last_error, j.printer_message, j.created_at, j.updated_at, j.sent_at, j.physically_confirmed_at, j.requested_by_user_id, rq.display_name AS requested_by_name, rq.official_initials AS requested_by_initials, j.receiver_user_id, rc.display_name AS receiver_name, rc.official_initials AS receiver_initials, j.physically_confirmed_by_user_id AS confirmed_by_user_id, cf.display_name AS confirmed_by_name, cf.official_initials AS confirmed_by_initials FROM print_job j JOIN printer p ON p.key = j.printer_key JOIN app_user rq ON rq.id = j.requested_by_user_id LEFT JOIN app_user rc ON rc.id = j.receiver_user_id LEFT JOIN app_user cf ON cf.id = j.physically_confirmed_by_user_id WHERE j.id IN (SELECT print_job_id FROM print_job_item WHERE storage_unit_id = $1) ORDER BY j.created_at DESC, j.id DESC LIMIT 100
```

```text
Limit  (cost=42.51..42.52 rows=3 width=268) (actual time=0.052..0.053 rows=3 loops=1)
  Buffers: shared hit=34
  ->  Sort  (cost=42.51..42.52 rows=3 width=268) (actual time=0.052..0.053 rows=3 loops=1)
        Sort Key: j.created_at DESC, j.id DESC
        Sort Method: quicksort  Memory: 26kB
        Buffers: shared hit=34
        ->  Nested Loop Left Join  (cost=5.15..42.49 rows=3 width=268) (actual time=0.036..0.048 rows=3 loops=1)
              Buffers: shared hit=34
              ->  Nested Loop Left Join  (cost=5.01..42.00 rows=3 width=250) (actual time=0.034..0.045 rows=3 loops=1)
                    Buffers: shared hit=32
                    ->  Nested Loop  (cost=4.87..41.52 rows=3 width=232) (actual time=0.031..0.041 rows=3 loops=1)
                          Buffers: shared hit=26
                          ->  Nested Loop  (cost=4.73..41.04 rows=3 width=214) (actual time=0.028..0.036 rows=3 loops=1)
                                Buffers: shared hit=20
                                ->  Nested Loop  (cost=4.60..40.58 rows=3 width=187) (actual time=0.024..0.031 rows=3 loops=1)
                                      Buffers: shared hit=14
                                      ->  Bitmap Heap Scan on print_job_item  (cost=4.31..15.67 rows=3 width=16) (actual time=0.016..0.018 rows=3 loops=1)
                                            Recheck Cond: (storage_unit_id = '39df2854-22b6-44ca-9bf1-b25c8bb69fd8'::uuid)
                                            Heap Blocks: exact=3
                                            Buffers: shared hit=5
                                            ->  Bitmap Index Scan on print_job_item_unit_idx  (cost=0.00..4.31 rows=3 width=0) (actual time=0.008..0.008 rows=3 loops=1)
                                                  Index Cond: (storage_unit_id = '39df2854-22b6-44ca-9bf1-b25c8bb69fd8'::uuid)
                                                  Buffers: shared hit=2
                                      ->  Index Scan using print_job_pkey on print_job j  (cost=0.29..8.30 rows=1 width=187) (actual time=0.004..0.004 rows=1 loops=3)
                                            Index Cond: (id = print_job_item.print_job_id)
                                            Buffers: shared hit=9
                                ->  Index Scan using printer_pkey on printer p  (cost=0.12..0.14 rows=1 width=43) (actual time=0.001..0.001 rows=1 loops=3)
                                      Index Cond: (key = j.printer_key)
                                      Buffers: shared hit=6
                          ->  Index Scan using app_user_pkey on app_user rq  (cost=0.14..0.16 rows=1 width=34) (actual time=0.001..0.001 rows=1 loops=3)
                                Index Cond: (id = j.requested_by_user_id)
                                Buffers: shared hit=6
                    ->  Index Scan using app_user_pkey on app_user rc  (cost=0.14..0.16 rows=1 width=34) (actual time=0.001..0.001 rows=1 loops=3)
                          Index Cond: (id = j.receiver_user_id)
                          Buffers: shared hit=6
              ->  Index Scan using app_user_pkey on app_user cf  (cost=0.14..0.16 rows=1 width=34) (actual time=0.001..0.001 rows=0 loops=3)
                    Index Cond: (id = j.physically_confirmed_by_user_id)
                    Buffers: shared hit=2
Planning:
  Buffers: shared hit=35
Planning Time: 1.031 ms
Execution Time: 0.095 ms
```

```sql
SELECT i.print_job_id, i.storage_unit_id, su.readable_id, i.position FROM print_job_item i JOIN storage_unit su ON su.id = i.storage_unit_id WHERE i.print_job_id = ANY($1::uuid[]) ORDER BY i.print_job_id, i.position
```

```text
Sort  (cost=109.01..109.03 rows=8 width=51) (actual time=0.038..0.038 rows=12 loops=1)
  Sort Key: i.print_job_id, i."position"
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=48
  ->  Nested Loop  (cost=13.60..108.89 rows=8 width=51) (actual time=0.019..0.032 rows=12 loops=1)
        Buffers: shared hit=48
        ->  Bitmap Heap Scan on print_job_item i  (cost=13.31..42.44 rows=8 width=36) (actual time=0.015..0.016 rows=12 loops=1)
              Recheck Cond: (print_job_id = ANY ('{3 uuids}'::uuid[]))
              Heap Blocks: exact=3
              Buffers: shared hit=12
              ->  Bitmap Index Scan on print_job_item_print_job_id_position_key  (cost=0.00..13.31 rows=8 width=0) (actual time=0.011..0.011 rows=12 loops=1)
                    Index Cond: (print_job_id = ANY ('{3 uuids}'::uuid[]))
                    Buffers: shared hit=9
        ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.29..8.30 rows=1 width=31) (actual time=0.001..0.001 rows=1 loops=12)
              Index Cond: (id = i.storage_unit_id)
              Buffers: shared hit=36
Planning:
  Buffers: shared hit=12
Planning Time: 0.120 ms
Execution Time: 0.047 ms
```

## detail: storage unit (slowest draw)

```sql
SELECT id, readable_id, receipt_id FROM storage_unit WHERE readable_id = $1
```

```text
Index Scan using storage_unit_readable_id_key on storage_unit  (cost=0.29..8.30 rows=1 width=47) (actual time=0.009..0.009 rows=1 loops=1)
  Index Cond: (readable_id = 'BKT-2020-001197'::text)
  Buffers: shared hit=3
Planning Time: 0.045 ms
Execution Time: 0.015 ms
```

```sql
SELECT su.id, su.readable_id, su.unit_type, su.status, su.note, su.received_date::text AS received_date, su.version, p.id AS project_id, p.project_number, p.name AS project_name, p.client, l.id AS location_id, l.code AS location_code, l.name AS location_name, r.id AS receipt_id, r.received_date::text AS receipt_received_date, rp.id AS receipt_project_id, rp.project_number AS receipt_project_number, rp.name AS receipt_project_name, rp.client AS receipt_client, r.receiver_initials_snapshot, r.receiver_name_snapshot, a.official_initials AS account_initials, a.display_name AS account_name, r.description, r.quantity, r.confirmed_at FROM storage_unit su JOIN project p ON p.id = su.project_id JOIN location l ON l.id = su.current_location_id JOIN receipt r ON r.id = su.receipt_id JOIN project rp ON rp.id = r.project_id JOIN app_user a ON a.id = r.account_user_id WHERE su.id = $1
```

```text
Nested Loop  (cost=9.31..26.99 rows=1 width=448) (actual time=0.039..0.041 rows=1 loops=1)
  Buffers: shared hit=15
  ->  Nested Loop  (cost=9.17..26.82 rows=1 width=390) (actual time=0.036..0.037 rows=1 loops=1)
        Buffers: shared hit=13
        ->  Nested Loop  (cost=8.88..26.45 rows=1 width=319) (actual time=0.033..0.034 rows=1 loops=1)
              Buffers: shared hit=10
              ->  Nested Loop  (cost=8.60..18.15 rows=1 width=219) (actual time=0.029..0.030 rows=1 loops=1)
                    Buffers: shared hit=7
                    ->  Hash Join  (cost=8.32..9.85 rows=1 width=148) (actual time=0.025..0.026 rows=1 loops=1)
                          Hash Cond: (l.id = su.current_location_id)
                          Buffers: shared hit=4
                          ->  Seq Scan on location l  (cost=0.00..1.41 rows=41 width=44) (actual time=0.009..0.010 rows=41 loops=1)
                                Buffers: shared hit=1
                          ->  Hash  (cost=8.30..8.30 rows=1 width=120) (actual time=0.008..0.009 rows=1 loops=1)
                                Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                Buffers: shared hit=3
                                ->  Index Scan using storage_unit_pkey on storage_unit su  (cost=0.29..8.30 rows=1 width=120) (actual time=0.005..0.005 rows=1 loops=1)
                                      Index Cond: (id = '0fd40ae8-be36-4d23-89bc-7f293d3d5600'::uuid)
                                      Buffers: shared hit=3
                    ->  Index Scan using project_pkey on project p  (cost=0.28..8.30 rows=1 width=87) (actual time=0.003..0.003 rows=1 loops=1)
                          Index Cond: (id = su.project_id)
                          Buffers: shared hit=3
              ->  Index Scan using receipt_pkey on receipt r  (cost=0.28..8.30 rows=1 width=116) (actual time=0.004..0.004 rows=1 loops=1)
                    Index Cond: (id = su.receipt_id)
                    Buffers: shared hit=3
        ->  Index Scan using project_pkey on project rp  (cost=0.28..0.37 rows=1 width=87) (actual time=0.003..0.003 rows=1 loops=1)
              Index Cond: (id = r.project_id)
              Buffers: shared hit=3
  ->  Index Scan using app_user_pkey on app_user a  (cost=0.14..0.16 rows=1 width=34) (actual time=0.002..0.002 rows=1 loops=1)
        Index Cond: (id = r.account_user_id)
        Buffers: shared hit=2
Planning:
  Buffers: shared hit=45
Planning Time: 0.416 ms
Execution Time: 0.072 ms
```

```sql
SELECT h.storage_unit_id, h.test_hole_id, th.name AS test_hole_name, h.summary_type, h.sample_from, h.sample_to, h.depth_from, h.depth_to, h.depth_unit, h.custom_text, h.note FROM storage_unit_hole_summary h JOIN test_hole th ON th.id = h.test_hole_id WHERE h.storage_unit_id = ANY ($1::uuid[]) ORDER BY th.name_normalized, th.id
```

```text
Sort  (cost=16.62..16.62 rows=1 width=127) (actual time=0.022..0.022 rows=1 loops=1)
  Sort Key: th.name_normalized, h.test_hole_id
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=6
  ->  Nested Loop  (cost=0.57..16.61 rows=1 width=127) (actual time=0.016..0.017 rows=1 loops=1)
        Buffers: shared hit=6
        ->  Index Scan using summary_one_per_hole_key on storage_unit_hole_summary h  (cost=0.29..8.30 rows=1 width=95) (actual time=0.008..0.008 rows=1 loops=1)
              Index Cond: (storage_unit_id = ANY ('{0fd40ae8-be36-4d23-89bc-7f293d3d5600}'::uuid[]))
              Buffers: shared hit=3
        ->  Index Scan using test_hole_pkey on test_hole th  (cost=0.29..8.30 rows=1 width=32) (actual time=0.007..0.007 rows=1 loops=1)
              Index Cond: (id = h.test_hole_id)
              Buffers: shared hit=3
Planning:
  Buffers: shared hit=12
Planning Time: 0.111 ms
Execution Time: 0.037 ms
```

## detail: history page 1 (slowest draw)

```sql
SELECT id, readable_id, receipt_id FROM storage_unit WHERE readable_id = $1
```

```text
Index Scan using storage_unit_readable_id_key on storage_unit  (cost=0.29..8.30 rows=1 width=47) (actual time=0.009..0.009 rows=1 loops=1)
  Index Cond: (readable_id = 'BKT-2025-000232'::text)
  Buffers: shared hit=3
Planning Time: 0.045 ms
Execution Time: 0.015 ms
```

```sql
SELECT count(*)::int AS total FROM audit_event e WHERE (e.entity_type = 'storage_unit' AND e.entity_id = $1) OR (e.entity_type = 'receipt' AND e.entity_id = $2)
```

```text
Aggregate  (cost=12.88..12.90 rows=1 width=4) (actual time=0.015..0.015 rows=1 loops=1)
  Buffers: shared hit=7
  ->  Bitmap Heap Scan on audit_event e  (cost=8.86..12.88 rows=1 width=0) (actual time=0.013..0.013 rows=2 loops=1)
        Recheck Cond: (((entity_type = 'storage_unit'::text) AND (entity_id = '39df2854-22b6-44ca-9bf1-b25c8bb69fd8'::uuid)) OR ((entity_type = 'receipt'::text) AND (entity_id = 'c43fc726-b2e6-4a3d-ac72-8580ec85a6ef'::uuid)))
        Heap Blocks: exact=1
        Buffers: shared hit=7
        ->  BitmapOr  (cost=8.86..8.86 rows=1 width=0) (actual time=0.009..0.009 rows=0 loops=1)
              Buffers: shared hit=6
              ->  Bitmap Index Scan on audit_event_entity_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.007..0.007 rows=1 loops=1)
                    Index Cond: ((entity_type = 'storage_unit'::text) AND (entity_id = '39df2854-22b6-44ca-9bf1-b25c8bb69fd8'::uuid))
                    Buffers: shared hit=3
              ->  Bitmap Index Scan on audit_event_entity_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.002..0.002 rows=1 loops=1)
                    Index Cond: ((entity_type = 'receipt'::text) AND (entity_id = 'c43fc726-b2e6-4a3d-ac72-8580ec85a6ef'::uuid))
                    Buffers: shared hit=3
Planning Time: 0.047 ms
Execution Time: 0.028 ms
```

```sql
SELECT e.id, e.occurred_at, e.action, e.actor_initials_snapshot, e.actor_name_snapshot, e.actor_account_type, r.official_initials AS receiver_initials, r.display_name AS receiver_name, e.reason, e.before_values, e.after_values FROM audit_event e LEFT JOIN app_user r ON r.id = e.receiver_user_id WHERE (e.entity_type = 'storage_unit' AND e.entity_id = $1) OR (e.entity_type = 'receipt' AND e.entity_id = $2) ORDER BY e.occurred_at DESC, e.id DESC LIMIT $3 OFFSET $4
```

```text
Limit  (cost=14.88..14.88 rows=1 width=165) (actual time=0.032..0.033 rows=2 loops=1)
  Buffers: shared hit=8
  ->  Sort  (cost=14.88..14.88 rows=1 width=165) (actual time=0.032..0.032 rows=2 loops=1)
        Sort Key: e.occurred_at DESC, e.id DESC
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=8
        ->  Hash Right Join  (cost=12.89..14.87 rows=1 width=165) (actual time=0.024..0.030 rows=2 loops=1)
              Hash Cond: (r.id = e.receiver_user_id)
              Buffers: shared hit=8
              ->  Seq Scan on app_user r  (cost=0.00..1.70 rows=70 width=34) (actual time=0.004..0.006 rows=70 loops=1)
                    Buffers: shared hit=1
              ->  Hash  (cost=12.88..12.88 rows=1 width=163) (actual time=0.015..0.015 rows=2 loops=1)
                    Buckets: 1024  Batches: 1  Memory Usage: 9kB
                    Buffers: shared hit=7
                    ->  Bitmap Heap Scan on audit_event e  (cost=8.86..12.88 rows=1 width=163) (actual time=0.012..0.013 rows=2 loops=1)
                          Recheck Cond: (((entity_type = 'storage_unit'::text) AND (entity_id = '39df2854-22b6-44ca-9bf1-b25c8bb69fd8'::uuid)) OR ((entity_type = 'receipt'::text) AND (entity_id = 'c43fc726-b2e6-4a3d-ac72-8580ec85a6ef'::uuid)))
                          Heap Blocks: exact=1
                          Buffers: shared hit=7
                          ->  BitmapOr  (cost=8.86..8.86 rows=1 width=0) (actual time=0.007..0.007 rows=0 loops=1)
                                Buffers: shared hit=6
                                ->  Bitmap Index Scan on audit_event_entity_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.004..0.004 rows=1 loops=1)
                                      Index Cond: ((entity_type = 'storage_unit'::text) AND (entity_id = '39df2854-22b6-44ca-9bf1-b25c8bb69fd8'::uuid))
                                      Buffers: shared hit=3
                                ->  Bitmap Index Scan on audit_event_entity_idx  (cost=0.00..4.43 rows=1 width=0) (actual time=0.003..0.003 rows=1 loops=1)
                                      Index Cond: ((entity_type = 'receipt'::text) AND (entity_id = 'c43fc726-b2e6-4a3d-ac72-8580ec85a6ef'::uuid))
                                      Buffers: shared hit=3
Planning:
  Buffers: shared hit=1
Planning Time: 0.076 ms
Execution Time: 0.053 ms
```

## lookup: scan storage unit ID (slowest draw)

```sql
SELECT id, readable_id FROM storage_unit WHERE readable_id = $1
```

```text
Index Scan using storage_unit_readable_id_key on storage_unit  (cost=0.29..8.30 rows=1 width=31) (actual time=0.009..0.010 rows=1 loops=1)
  Index Cond: (readable_id = 'BKT-2020-001197'::text)
  Buffers: shared hit=3
Planning Time: 0.044 ms
Execution Time: 0.015 ms
```

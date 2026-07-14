# AI Session Attention globalState Feasibility Report

Date: 2026-07-13

## Decision

**FAIL — return to architecture design.**

The proposed production registry must not use VS Code `globalState` as its
cross-window coordination channel. Two windows attached to the same Dev
Container already violated the approved monotonicity and latency gates. More
difficult local/remote and cross-host matrices were therefore not run.

## Environment

- VS Code: 1.127.0 (`4fe60c8b1cdac1c4c174f2fb180d0d758272d713`)
- Extension: Project Steward 1.1.8, temporary feasibility VSIX
- Host/container OS: Ubuntu 22.04.5 LTS, Linux 5.10.134-16.3.an8.x86_64
- Matrix: two VS Code windows attached to the same Dev Container
- VS Code profile: not captured
- Clean-run duration: 5 minutes
- Probe cadence: write every 1 second, read every 200ms
- Node `13b4cfa1885f16cd`: sentinel owner
- Node `3f41c26ef5763925`: ordinary probe

## Gate Results

| Window | Peer nodes | RTT samples | P95 RTT | Longest missing | Sentinel rollback observations | Write errors | Registry bytes | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Sentinel owner | 1 | 325 | 1680ms | 0ms | 370 | 0 | 213 | FAIL |
| Probe | 1 | 337 | 883ms | 0ms | 66 | 0 | 213 | FAIL |

Approved thresholds were: exactly one peer, at least 100 RTT samples,
`p95RoundTripMs <= 1000`, `longestMissingMs <= 60000`,
`sentinelRollbacks === 0`, `writeErrors === 0`, and registry size below
65536 bytes.

Both nodes discovered exactly one peer, accumulated enough samples, retained
nodes, stayed far below the size cap, and reported no write errors. The
sentinel owner failed both the latency gate (1680ms) and
monotonicity gate (370 rollback observations). The
ordinary probe met the latency gate (883ms) but failed
monotonicity (66 rollback observations).

`sentinelRollbacks` counts poll observations below the highest value already
seen, not necessarily distinct rollback transitions. The gate is zero, so any
positive value is sufficient to fail.

## Probe Correction and Retest

The first run exposed a probe defect: the sentinel owner could poll while its
own asynchronous `globalState.update()` was in flight and count the old value
as a rollback. A regression test reproduced that race. The temporary probe was
changed to suppress rollback detection only during its own sentinel write, and
the safety suite passed before a new VSIX was packaged.

This report uses only the second, clean run after both windows installed the
corrected VSIX, reloaded, and cleared the temporary keys. Rollbacks still
occurred in both windows, including the non-owner that never writes the
sentinel. The remaining rollback observations therefore cannot be explained
by the corrected local in-flight-write race.

The exact VS Code internal propagation mechanism is not established by this
spike. The measured result is sufficient for the architectural gate: concurrent
extension hosts cannot rely on `globalState` reads as a monotonic,
sub-second coordination registry even when both windows use the same Dev
Container.

## Shutdown, Stress, and Other Matrices

- Clean/forced shutdown matrix: NOT RUN — early monotonicity and latency gate failure.
- Unrelated-state stress: NOT RUN — early gate failure.
- Two local windows: NOT RUN — early gate failure.
- Local + Remote SSH: NOT RUN — early gate failure.
- Two different Remote SSH hosts: NOT RUN — early gate failure.
- Local + WSL: NOT RUN — early gate failure.
- Local + Dev Container: NOT RUN — early gate failure.
- Two windows in the same Dev Container: RUN — FAIL.

## Raw Final Status Samples

The final status is cumulative: `roundTripSamplesMs` contains the complete RTT
sample history for the clean run, while missing duration, rollback, error, and
revision fields retain the run's accumulated state.

<details>
<summary>Sentinel owner — 13b4cfa1885f16cd</summary>

```json
{"nodeId":"13b4cfa1885f16cd","ownRevision":342,"seenNodeIds":["3f41c26ef5763925"],"peerRevisions":{"3f41c26ef5763925":335},"peerStalledMs":{"3f41c26ef5763925":252},"closedNodeIds":[],"registryBytes":213,"roundTripSamplesMs":[1205,805,805,806,809,1209,811,813,811,812,812,813,815,816,816,616,818,818,618,818,618,819,819,821,827,829,827,827,828,826,826,829,629,1629,632,833,833,834,834,834,834,835,836,1638,1637,840,839,841,841,841,843,842,1642,1642,1642,1641,841,843,843,1644,1645,1446,1446,1447,1670,1471,1473,1671,1672,1673,1673,1475,1477,1680,1680,1680,1481,882,1684,1484,1683,1682,1683,1682,1485,1485,1684,1685,885,1683,1683,1683,1683,683,884,885,885,688,687,889,689,689,690,1490,1491,1490,1491,693,692,892,1493,1494,1494,1494,1494,1492,1492,1494,1495,1496,1497,1697,896,1499,700,699,1499,1499,1500,1501,1503,1502,702,703,704,704,704,1507,1508,1508,1509,1508,1510,1509,1502,1503,1502,1703,901,701,704,705,705,1506,1506,1508,1507,1508,1511,1511,1510,1512,1511,710,712,713,1512,1511,1511,1514,714,715,714,714,1515,716,715,1517,717,716,719,1521,720,1520,720,1522,1522,1323,1529,729,1531,731,729,731,1531,1531,731,733,734,737,735,1536,1536,736,737,1538,738,737,737,736,736,735,737,737,737,736,737,738,739,1740,1741,743,752,752,753,754,754,758,759,759,758,759,759,760,761,764,764,764,765,767,768,768,767,767,769,769,770,771,772,772,775,776,776,777,779,780,781,782,782,783,786,786,788,789,788,790,792,794,793,794,795,796,797,798,800,1799,1601,799,799,801,801,804,803,802,803,804,805,805,806,805,805,605,806,807,807,813,811,810,811,823,823,822,824,823,825,824,827,826,827,826,828,828,828,629,830,829,829,829,828,831,830,832,832,835,834],"p95RoundTripMs":1680,"longestMissingMs":0,"sentinelRevision":342,"sentinelRollbacks":370,"writeErrors":0}
```

</details>
<details>
<summary>Probe — 3f41c26ef5763925</summary>

```json
{"nodeId":"3f41c26ef5763925","ownRevision":339,"seenNodeIds":["13b4cfa1885f16cd"],"peerRevisions":{"13b4cfa1885f16cd":345},"peerStalledMs":{"13b4cfa1885f16cd":265},"closedNodeIds":[],"registryBytes":213,"roundTripSamplesMs":[601,751,760,803,803,603,804,807,808,807,810,810,809,809,811,621,826,826,626,829,628,829,830,830,833,833,833,843,642,645,849,849,852,650,652,651,653,654,856,890,893,694,893,894,896,894,696,696,698,898,899,899,900,700,903,904,705,704,706,707,724,724,725,726,727,729,729,729,731,730,732,731,731,733,734,735,736,736,736,735,735,739,940,739,743,742,742,742,742,744,746,746,946,947,747,747,749,758,761,724,763,764,763,762,763,765,751,750,762,771,771,771,772,767,762,778,777,779,782,782,785,785,787,788,789,788,789,790,792,793,764,759,797,798,799,799,800,802,803,802,802,802,803,803,805,803,804,803,803,805,807,806,807,807,808,811,811,811,811,813,812,813,818,818,821,821,823,823,826,828,828,830,828,829,830,830,830,831,842,843,844,843,845,854,654,653,655,855,857,857,859,858,859,859,660,859,860,861,863,862,862,865,866,866,868,669,871,871,872,871,873,875,877,879,880,681,681,682,682,886,878,880,679,879,878,680,679,679,681,662,862,664,853,854,854,855,855,856,856,857,856,857,857,859,859,859,859,852,854,854,854,853,852,852,853,855,855,854,855,853,854,866,868,867,670,871,873,874,672,874,874,677,877,878,679,880,882,882,883,882,668,670,669,870,870,868,869,869,870,870,873,871,862,861,877,665,668,669,872,671,671,872,672,675,675,875,676,678,678,879,676,877,676,678,878,679,879,678,880,679,680,880,882,684,678,679,881,678,879,881,870,869,670,672,872,873,876],"p95RoundTripMs":883,"longestMissingMs":0,"sentinelRevision":345,"sentinelRollbacks":66,"writeErrors":0}
```

</details>

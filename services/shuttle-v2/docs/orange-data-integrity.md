# Orange data integrity findings — September 21, 2026

The available data does not support replacing Orange Day with a checkpoint model solely to get narrower windows. The failure is reproducible after reconstructing visits and training priors from raw GPS. There is also a real archival coverage gap, so this is a limited-data result, not proof that the method cannot work on Orange Day.

## Historical coverage

Orange Day has 803, 733 and 842 stored stop visits on September 11, 14 and 15, respectively, but zero raw GPS rows on those dates. September 8–9 are partial. Its qualified pre-September-16 K10 paths come from five dates, chiefly September 3, 4 and 10. The connectivity guard excluded unverified days rather than joining paths through missing GPS.

Archive manifests show the September 11/14/15 files had no independent Pi capture. At that time the server retained only six hours of GPS; the 03:40 ET daily export therefore lacked daytime positions. PR266 (34525a6, September16) changed retention to 36 hours. The current evaluation days September17–18 have daytime GPS. No duplicate or conflicting stop-visit IDs were found. A manifest's complete stream is not evidence of full-day coverage.

## Reconstruction and sensitivity

All Orange raw GPS was replayed through the current chronological visit detector, resetting on gaps, route changes and contended identities. Accepted training paths were separately checked for provider-ID changes, coincident observations, GPS gaps, implausible motion and reconstructed stop-occurrence agreement. The 11,794 Orange Day and 19,852 Orange Night path records include repeated targets/K values and are not independent trips.

A conservative 15-second endpoint-agreement filter flagged 548 Day and 53 Night path records. This is a sensitivity screen, not a corruption label. Four K8 source events account for 124 Day path flags. For three of these events the reconstructed source departure was identical and only the arrival/standing interval changed; the fourth departure differed by 54 seconds. Discarding complete trips for those disagreements spuriously made K8 look much narrower. That candidate is rejected.

| Orange Day K | Original mean width | Fully rebuilt mean width | Paired usual width for rebuild |
|---|---:|---:|---:|
| 1 | 12:53 | 12:48 | 12:00 |
| 2 | 12:55 | 12:52 | 12:21 |
| 3 | 12:56 | 12:48 | 12:48 |
| 5 | 13:16 | 13:10 | 12:58 |
| 8 | 14:11 | 14:12 | 13:04 |
| 10 | 15:25 | 15:17 | 13:13 |
| 15 | 15:27 | 15:19 | 13:34 |

Each K has a different eligible cohort; every comparator is paired within its cohort. Rebuilt K3 differs by less than one second and fails the one-minute narrowing gate. K10's rebuilt MAE is 190s versus 221s usual: it improves point error while widening the window about 125s. All seven K values remain unsuitable under the rider's narrower-window preference and the frozen coverage/error gates.

One of 76 Orange Day K10 outcome arrivals differs between stored and rebuilt events by 27.7s; departure is identical. All 24 Orange Night outcome arrivals reproduce within the 15s check. The full rebuilt Orange Night K10 model retains 548 changed snapshots, with width 786s versus 1269s usual, MAE 309s versus 458s, and 83.3% coverage. Original Night width is 784s: its qualification does not depend on the flagged records.

Removing one training date at a time changes support and sometimes sends many rows back to the live baseline. Such a narrower mixture is not evidence that a particular day was bad. Night coverage is also sensitive to individual training dates, so its small development sample remains a limitation.

## Why K10 can help at night but not by day

On 62 complete Orange Day training journeys from K10 to the first stop after Cedar, pre-wait time and Cedar hold have correlation -0.024: almost no measured offset. Pre-wait standard deviation is 169s, hold standard deviation 306s, and total journey standard deviation 350s. On 125 Orange Night journeys the corresponding correlation is -0.522. This descriptive association supports an offsetting-time explanation at night; it does not establish driver policy or a causal effect.

The longest inspected Day Cedar hold is 32m32s, supported by 384 GPS points from one provider ID, maximum gap 17.6s and four distinct coordinates. The longest inspected Night hold is 27m40s, supported by 333 points, one provider ID and maximum gap 5.2s. These are prolonged observed stationary positions, not confirmed explanations of driver activity. No disconnected-track explanation was found for either. Retain genuine long holds rather than deleting them to manufacture narrower intervals.

Sources: [hosted integrity audit](https://github.com/grtwrn/yale-shuttle/actions/runs/35678999500), [seven-value sweep and export](https://github.com/grtwrn/yale-shuttle/actions/runs/35677536788), and local archive manifests. Training ends before September16; evaluation September17–20 reuses development dates and is not a fresh holdout.

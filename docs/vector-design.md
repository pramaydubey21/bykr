# Route embedding — design note

bykr recommends rides by comparing **96-dimensional route embeddings** stored in
`ride_summary.route_embedding vector(96)`. This note explains what each dimension
means, why it is built this way, and how the database uses it.

Code: `lib/vector/` (`embedding.ts`, `resample.ts`, `types.ts`).
SQL: `db/01_schema.sql` (column and HNSW index), `db/03_functions.sql`
(`fn_similar_rides`, `fn_recommend_rides`).
Self-check: `npx tsx lib/vector/selfcheck.ts`.

## 1. Pipeline

1. A ride ends (`sp_end_ride`).
2. The application reads the ride's pings from MongoDB `location_pings`
   (`{ location.coordinates: [lon, lat], speedKmph, recordedAt }`) and the ride's
   `rider_status` history from PostgreSQL.
3. `buildRouteEmbedding(pings, stats)` returns a `number[]` of length 96.
4. `toPgVector(v)` turns it into pgvector text `"[0.12,-0.4,…]"`, which is written with
   `UPDATE ride_summary SET route_embedding = $1::vector WHERE ride_id = $2`.
5. Similarity is plain SQL with the `<=>` (cosine distance) operator, served by an
   HNSW index.

`buildRouteEmbedding` is a pure function. It does no I/O, uses no randomness, makes no
network call and needs no API key, so the same ride always gives the same vector.

## 2. Layout overview

| Dims (1-based) | Block | Content |
|---|---|---|
| 1–64 | Route shape | 32 points resampled at equal distance along the path, normalised to the bounding box and centred, flattened as `[x0, y0, x1, y1, …]` |
| 65–85 | Route character | 21 scalars, min-max normalised against fixed reference ranges and clamped to [0, 1] |
| 86–96 | Padding | Zeros, kept free for later features (real elevation, for example) without changing the column type |

### Route shape (dims 1–64)

* **Ordering.** Pings are sorted by `recordedAt`, so out-of-order arrival (for example
  after an offline bulk insert) does not change the result.
* **Resampling.** Pings arrive every 5 s, so a slow ghat climb has many more points per
  kilometre than a highway run. `resamplePath` walks the path by cumulative haversine
  distance and interpolates 32 points at `total × k / 31`, for k = 0…31. Every point
  then stands for the same fraction of the route, whatever the speed.
  Consecutive duplicate pings (a stationary rider) are skipped. With 0 pings it returns
  nothing. With 1 ping, or a path of zero length, it returns 32 copies of that point.
* **Projection.** Points are projected to a local flat plane in kilometres
  (`x = lon · 111.32 · cos(mean lat)`, `y = lat · 110.574`). Without this, a degree of
  longitude at 18.5° N (about 105.6 km) would be treated the same as a degree of
  latitude (about 110.6 km).
* **Bounding-box normalisation.** Both axes are divided by the **longer** side of the
  route's bounding box. Using one scale for both axes keeps the aspect ratio honest: a
  route 40 km long and 2 km wide stays a thin line and is not stretched into a square.
* **Centring.** The box centre is subtracted, so the long axis covers exactly
  [-0.5, 0.5] and the short axis a smaller interval around 0.
* **Zero-size box.** A single point, or no movement, gives a scale of 0. All 64 values
  are then set to 0 instead of dividing by zero.

### Route character (dims 65–85)

These scalars hold the facts that the shape block deliberately removes: how far, how
long, how fast, how often the group stopped, what kind of stops they made, when they
rode, and where. Each value is computed as `(value − min) / (max − min)` against a
**fixed** range, then clamped to [0, 1]. Cyclic features (`sin`, `cos`) are mapped from
[-1, 1] to [0, 1]. Hour of day and day of week are taken in IST (UTC+05:30), the
operating region's timezone, so the result does not depend on the server's clock.
The status counts use the five labels in the fixed order REFUELLING, EATING, DELAYED,
RIDING, STOPPED.

## 3. Full dimension layout

This table is generated from `DIMENSION_LAYOUT` in `lib/vector/embedding.ts` by
`dimensionLayoutMarkdown()`. `selfcheck.ts` fails if the two differ, so do not edit it
by hand. To regenerate it:

```bash
npx tsx -e 'import {dimensionLayoutMarkdown} from "./lib/vector/embedding"; console.log(dimensionLayoutMarkdown())'
```

<!-- BEGIN DIMENSION_LAYOUT (generated) -->
| Dim | Index | Group | Name | Meaning / reference range |
|---:|---:|---|---|---|
| 1 | 0 | shape | `p0_x` | Resampled point 0 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 2 | 1 | shape | `p0_y` | Resampled point 0 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 3 | 2 | shape | `p1_x` | Resampled point 1 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 4 | 3 | shape | `p1_y` | Resampled point 1 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 5 | 4 | shape | `p2_x` | Resampled point 2 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 6 | 5 | shape | `p2_y` | Resampled point 2 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 7 | 6 | shape | `p3_x` | Resampled point 3 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 8 | 7 | shape | `p3_y` | Resampled point 3 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 9 | 8 | shape | `p4_x` | Resampled point 4 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 10 | 9 | shape | `p4_y` | Resampled point 4 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 11 | 10 | shape | `p5_x` | Resampled point 5 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 12 | 11 | shape | `p5_y` | Resampled point 5 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 13 | 12 | shape | `p6_x` | Resampled point 6 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 14 | 13 | shape | `p6_y` | Resampled point 6 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 15 | 14 | shape | `p7_x` | Resampled point 7 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 16 | 15 | shape | `p7_y` | Resampled point 7 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 17 | 16 | shape | `p8_x` | Resampled point 8 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 18 | 17 | shape | `p8_y` | Resampled point 8 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 19 | 18 | shape | `p9_x` | Resampled point 9 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 20 | 19 | shape | `p9_y` | Resampled point 9 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 21 | 20 | shape | `p10_x` | Resampled point 10 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 22 | 21 | shape | `p10_y` | Resampled point 10 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 23 | 22 | shape | `p11_x` | Resampled point 11 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 24 | 23 | shape | `p11_y` | Resampled point 11 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 25 | 24 | shape | `p12_x` | Resampled point 12 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 26 | 25 | shape | `p12_y` | Resampled point 12 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 27 | 26 | shape | `p13_x` | Resampled point 13 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 28 | 27 | shape | `p13_y` | Resampled point 13 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 29 | 28 | shape | `p14_x` | Resampled point 14 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 30 | 29 | shape | `p14_y` | Resampled point 14 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 31 | 30 | shape | `p15_x` | Resampled point 15 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 32 | 31 | shape | `p15_y` | Resampled point 15 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 33 | 32 | shape | `p16_x` | Resampled point 16 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 34 | 33 | shape | `p16_y` | Resampled point 16 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 35 | 34 | shape | `p17_x` | Resampled point 17 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 36 | 35 | shape | `p17_y` | Resampled point 17 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 37 | 36 | shape | `p18_x` | Resampled point 18 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 38 | 37 | shape | `p18_y` | Resampled point 18 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 39 | 38 | shape | `p19_x` | Resampled point 19 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 40 | 39 | shape | `p19_y` | Resampled point 19 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 41 | 40 | shape | `p20_x` | Resampled point 20 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 42 | 41 | shape | `p20_y` | Resampled point 20 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 43 | 42 | shape | `p21_x` | Resampled point 21 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 44 | 43 | shape | `p21_y` | Resampled point 21 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 45 | 44 | shape | `p22_x` | Resampled point 22 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 46 | 45 | shape | `p22_y` | Resampled point 22 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 47 | 46 | shape | `p23_x` | Resampled point 23 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 48 | 47 | shape | `p23_y` | Resampled point 23 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 49 | 48 | shape | `p24_x` | Resampled point 24 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 50 | 49 | shape | `p24_y` | Resampled point 24 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 51 | 50 | shape | `p25_x` | Resampled point 25 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 52 | 51 | shape | `p25_y` | Resampled point 25 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 53 | 52 | shape | `p26_x` | Resampled point 26 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 54 | 53 | shape | `p26_y` | Resampled point 26 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 55 | 54 | shape | `p27_x` | Resampled point 27 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 56 | 55 | shape | `p27_y` | Resampled point 27 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 57 | 56 | shape | `p28_x` | Resampled point 28 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 58 | 57 | shape | `p28_y` | Resampled point 28 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 59 | 58 | shape | `p29_x` | Resampled point 29 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 60 | 59 | shape | `p29_y` | Resampled point 29 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 61 | 60 | shape | `p30_x` | Resampled point 30 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 62 | 61 | shape | `p30_y` | Resampled point 30 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 63 | 62 | shape | `p31_x` | Resampled point 31 (of 0–31), east–west offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 64 | 63 | shape | `p31_y` | Resampled point 31 (of 0–31), north–south offset from box centre ÷ longer box side, in [-0.5, 0.5] |
| 65 | 64 | character | `distance_km` | Path length; 0–400 km (a long day ride, e.g. Pune–Kolhapur and back) |
| 66 | 65 | character | `duration_min` | First to last ping; 0–720 min (12 hours) |
| 67 | 66 | character | `avg_speed_kmph` | Distance / duration; 0–100 km/h (moving + stopped time) |
| 68 | 67 | character | `max_speed_kmph` | Highest ping speed; 0–160 km/h |
| 69 | 68 | character | `speed_variance` | Population variance of ping speeds; 0–1600 (km/h)² (standard deviation up to 40 km/h) |
| 70 | 69 | character | `stop_count` | Stops during the ride; 0–30 stops |
| 71 | 70 | character | `status_changes` | Status updates during the ride; 0–50 changes (all participants) |
| 72 | 71 | character | `status_count_refuelling` | Number of REFUELLING statuses set; 0–20 rows (per status label) |
| 73 | 72 | character | `status_count_eating` | Number of EATING statuses set; 0–20 rows (per status label) |
| 74 | 73 | character | `status_count_delayed` | Number of DELAYED statuses set; 0–20 rows (per status label) |
| 75 | 74 | character | `status_count_riding` | Number of RIDING statuses set; 0–20 rows (per status label) |
| 76 | 75 | character | `status_count_stopped` | Number of STOPPED statuses set; 0–20 rows (per status label) |
| 77 | 76 | character | `straightness_ratio` | Direct distance / path distance; 0–1 ratio (1 = perfectly straight) |
| 78 | 77 | character | `bbox_diagonal_km` | Bounding-box diagonal; 0–300 km |
| 79 | 78 | character | `start_hour_sin` | sin(2π·hour/24) of start time in IST, mapped to [0, 1] |
| 80 | 79 | character | `start_hour_cos` | cos(2π·hour/24) of start time in IST, mapped to [0, 1] |
| 81 | 80 | character | `day_of_week_sin` | sin(2π·weekday/7) of start date in IST (Sunday = 0), mapped to [0, 1] |
| 82 | 81 | character | `day_of_week_cos` | cos(2π·weekday/7) of start date in IST (Sunday = 0), mapped to [0, 1] |
| 83 | 82 | character | `start_lat` | Start latitude in the operating region; 17.5–20.5 °N (operating region) |
| 84 | 83 | character | `start_lon` | Start longitude in the operating region; 72.5–75.5 °E (operating region) |
| 85 | 84 | character | `elevation_proxy` | Reserved; pings carry no altitude, so always 0 |
| 86 | 85 | padding | `pad_0` | Zero padding to reach 96 |
| 87 | 86 | padding | `pad_1` | Zero padding to reach 96 |
| 88 | 87 | padding | `pad_2` | Zero padding to reach 96 |
| 89 | 88 | padding | `pad_3` | Zero padding to reach 96 |
| 90 | 89 | padding | `pad_4` | Zero padding to reach 96 |
| 91 | 90 | padding | `pad_5` | Zero padding to reach 96 |
| 92 | 91 | padding | `pad_6` | Zero padding to reach 96 |
| 93 | 92 | padding | `pad_7` | Zero padding to reach 96 |
| 94 | 93 | padding | `pad_8` | Zero padding to reach 96 |
| 95 | 94 | padding | `pad_9` | Zero padding to reach 96 |
| 96 | 95 | padding | `pad_10` | Zero padding to reach 96 |
<!-- END DIMENSION_LAYOUT -->

The same array can be rendered on an admin page, so the examiner can see the layout
next to a stored vector.

## 4. Why these choices

### Why bounding-box normalisation makes shape scale-invariant

Raw coordinates mix up three things: **where** a ride is, **how big** it is, and **what
shape** it has. A 10 km loop around Pune and a 200 km loop through the Sahyadris are the
same kind of ride, but their raw coordinates have almost nothing in common.

Subtracting the box centre removes position. Dividing by the longer box side removes
size. Afterwards both loops become the same closed curve inside the same unit box,
and their 64 shape values are almost identical. The self-check proves this: a 12 km
radius loop and the same loop at one tenth the size have a shape-only cosine distance
of about 1e-6.

Size and position are not discarded. They move to dedicated dimensions
(`distance_km`, `bbox_diagonal_km`, `start_lat`, `start_lon`), where each has a fixed
weight that can be explained. The full vector still separates the small loop from the
large one (distance about 0.005 in the self-check). Shape alone does not.

### Why centring

Cosine distance compares the **angle** between two vectors. If the coordinates sat in
[0, 1], every shape vector would point into the same all-positive corner of the space.
Two very different routes would then share a large positive component, and their
cosine similarity would be inflated by that shared offset rather than by real
similarity of shape. Centring to [-0.5, 0.5] removes the offset. A route heading
north-east and one heading south-west now point in opposite directions, and their
shape dims have a negative dot product, as they should.

### Why fixed reference ranges instead of dataset min-max

Normalising against the current dataset's minimum and maximum would make every stored
embedding depend on every other ride. Recording one new 350 km ride would change the
denominator. Every previously stored `distance_km` value would then be stale, and the
HNSW index would be comparing vectors that were normalised on different scales.

Fixed ranges (`REFERENCE_RANGES` in `embedding.ts`) make each embedding a function of
its own ride only. It is computed once at ride end and never needs recomputing. The
ranges are chosen for motorcycle day rides in Maharashtra (0–400 km, 0–720 min,
0–160 km/h, and so on). Anything outside a range clamps to 0 or 1, which keeps one
extreme ride from dominating. The operating region (lat 17.5–20.5, lon 72.5–75.5)
plays the same role for start coordinates.

### Why a deterministic feature vector instead of a language-model embedding

| | Deterministic feature vector | Language-model / learned embedding |
|---|---|---|
| Explainability | Every dimension has a name and a formula (table above). "Why are these rides similar?" is answered by pointing at dims. | Opaque. Individual dimensions mean nothing to a human. |
| Dependencies | Pure TypeScript, no network, no API key, no billing account | Needs a hosted model or a large local model, plus credentials |
| Reproducibility | Same input, same vector, byte for byte (tested in the self-check) | Changes with model version, and sometimes with the provider |
| Cost and latency | Microseconds per ride, no rate limits | Network round trip and a per-call cost |
| Fit to the data | A route is geometry and numbers, not text. Describing it in prose first would lose information. | Built for text and images |
| Privacy | Ride locations never leave the server | Coordinates are sent to a third party |

Project rule 6 (`CLAUDE.md`) requires this approach. More importantly, it makes the
vector feature something that can be defended line by line in the oral examination.

## 5. How the database uses it

### Storage and index (`db/01_schema.sql`)

```sql
route_embedding vector(96)
CREATE INDEX ix_ride_summary_embedding_hnsw
    ON ride_summary USING hnsw (route_embedding vector_cosine_ops);
```

HNSW (Hierarchical Navigable Small World) is a graph-based approximate nearest-neighbour
index. `vector_cosine_ops` tells pgvector to build the graph for the `<=>` operator, so
an `ORDER BY route_embedding <=> $x LIMIT k` can walk the graph instead of scanning and
sorting every row. Cosine distance is used rather than Euclidean (`<->`) because the
shape block is about direction (which way the route bends), and the character block is
already on a common [0, 1] scale.

`<=>` returns `1 − cos θ`: 0 means identical direction, 1 means unrelated, and 2 means
opposite. `cosineDistance()` in `embedding.ts` uses the same formula so that the
TypeScript and SQL results agree.

### "Rides like this one": `fn_similar_rides(p_ride_id, p_limit)`

```sql
SELECT r.ride_id, r.ride_title, …,
       s.route_embedding <=> src.route_embedding AS cosine_distance
FROM ride_summary s
JOIN ride r ON r.ride_id = s.ride_id
CROSS JOIN (SELECT route_embedding FROM ride_summary WHERE ride_id = p_ride_id) src
WHERE s.ride_id <> p_ride_id AND s.route_embedding IS NOT NULL
  AND fn_user_can_view_ride(fn_current_user_id(), p_ride_id)
ORDER BY s.route_embedding <=> src.route_embedding
LIMIT p_limit;
```

The source ride's embedding is the query vector. The function returns the nearest other
completed rides, but only after checking that the caller may see the source ride.

### "Recommended for you": `fn_recommend_rides(p_user_id, p_limit)`

1. **Taste vector.** `AVG(route_embedding)` over the `ride_summary` rows of every ride the
   rider took part in. pgvector's `AVG` over `vector` is an element-wise mean.
   `averageEmbeddings()` in `lib/vector` computes the same thing in TypeScript, for
   display or testing.
2. **Nearest unseen rides.** `ORDER BY route_embedding <=> centroid`, excluding every ride
   the rider was a participant of (`NOT EXISTS … ride_participant`). This keeps the
   rider's own history out of their recommendations.

Riders with different histories get different centroids, so they get different
recommendation lists. The self-check confirms this: a rider whose history is a loop
and a ghat road, and a rider whose history is a highway run, have taste vectors more than
1.0 apart in cosine distance, and their nearest rides differ. Identical results for every rider would mean
the embedding is broken (`CLAUDE.md`, verification gates).

Averaging works because every dimension is on a fixed, comparable scale. The mean of
two shape blocks is a recognisable blend of the two shapes, and the mean of two
`distance_km` values is a typical distance for that rider.

## 6. Known limitations

* **Direction matters.** The same road ridden in the opposite direction has reversed point
  order, and its shape block is far from the original. This is intended: a descent is a
  different ride from a climb. If direction should not matter, store both orientations
  and take the smaller distance.
* **Orientation matters.** A loop is not rotated to a canonical heading, so the same
  shape rotated by 90° is a different shape. For a regional route recommender this is
  desirable, because "heading north to Nashik" carries meaning.
* **No elevation.** Pings carry no altitude, so `elevation_proxy` is always 0. It is
  reserved so that a later altitude feature does not shift any other index.
* **Fixed ranges need judgement.** If the group starts doing 600 km tours, the
  `distance_km` range should widen. That change requires recomputing every stored
  embedding, which is a single loop over `ride_summary`.

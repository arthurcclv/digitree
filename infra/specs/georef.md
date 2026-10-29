# Spec — `georef.mjs`: a scan's PLY georeference, as a CSV

Status: **revision 2 — approved 2026-10-29.** See *Changes from revision 1*.
Revision 1 — approved 2026-10-29.

## What it is

A script in `infra/scripts/`, run from `infra/`, that copies each scan's
georeference out of its `point_cloud.ply` header into one row of
`data/3dgs/georef.csv`. The loader places a capture from that row in its
`header` mode (`app/src/layers/splat/specs/spec.md`, *Placement* and
*Georeference CSV → `splats` table*). It cannot read the header itself: the
served `.spz` carries none, and `original/` is not mounted in the database.

```bash
node scripts/georef.mjs                   # every scan in original/
node scripts/georef.mjs KZ0918-075047     # just these scans
```

## Where files live

```
data/3dgs/original/<scan>/point_cloud.ply   read-only, as delivered: only its header is read
data/3dgs/georef.csv                        the scan's row is replaced; every other row is kept
```

| input | default | meaning |
| --- | --- | --- |
| `<scan>…` | every folder in `original/` with a `point_cloud.ply` | bare scan folder names; a path, a scan given twice, or a folder without `point_cloud.ply`, is refused, naming it |
| `SPLATS_ORIGINAL_DIR` | `data/3dgs/original` | env: where the scan folders are |
| `SPLATS_GEOREF` | `data/3dgs/georef.csv` | env: the file written |

`gnss.csv` is not needed and not read, and neither are the vertices.

## What it does, per scan

1. **Read the header**, as `control-points.mjs` does (`specs/control-points.md`,
   step 1): the same code, now in `scripts/ply-header.mjs`, shared by both.
   It refuses the scan, naming it and the problem, when the capture is not a
   `.ply` or there is more than one `point_cloud.*`; `epsg` or any of
   `offsetx/y/z` is missing or not a number; `epsg` is not a whole number
   (digits only, as the loader reads it) in WGS 84 / UTM (32601–32660,
   32701–32760); a `shift*` is present and not 0, or a
   `scale*` is present and not 1.
2. **Write** one row:

   | column | value |
   | --- | --- |
   | `SplatID` | `<scan>` |
   | `File` | `<scan>.spz`, the format served (the loader checks it exists) |
   | `EPSG` | the header's `epsg`, as written |
   | `OFFSETX`, `OFFSETY`, `OFFSETZ` | the header's `offsetx`, `offsety`, `offsetz`, as written (e.g. `26.9006000000000007`) |

   "As written" means the header's text, unparsed, so nothing is lost to a
   round trip through a double.

## Output contract

- `georef.csv` has the header `SplatID,File,EPSG,OFFSETX,OFFSETY,OFFSETZ`. A
  missing file is created with it; a file with any other header is refused,
  untouched.
- The rows of the scans being processed are removed; every other row is kept
  byte for byte, in order. The new rows are appended, scans in the order
  given.
- Written to a temporary file beside it and renamed into place only when every
  scan succeeded: one failing scan leaves the file untouched.
- `original/` is only read. Re-running gives the same file.
- Prints each scan's EPSG and offset.
- The scan list, the kept rows and the rename are `scripts/scan-csv.mjs`,
  shared with `control-points.mjs`.

## What it does not check

- **That the header's georeference is true of the vertices**, as
  `control-points.mjs` does not: verified on the two KZ0918 scans by hand. A
  capture whose header lies loads, and lands wrong.
- **That `<scan>.spz` exists.** The loader checks it, and its LoD.
- **The height's datum.** `offsetz` is copied as it is: the height of the
  file's origin in `gnss.csv`'s datum, WGS 84 ellipsoidal on the delivered
  scans. The loader draws it less its group's datum (the splat spec, *The
  datum*).

## Tests — `test/georef.sh`

Runs the real script on scans in a scratch directory. Needs only node.

- `T1` (the control-points fixture, KZ0918-075047's header) gives one row,
  `T1,T1.spz,32651,352796.8287235790048726,2770099.7470906949602067,26.9006000000000007`:
  every offset as written.
- A scan without `gnss.csv` is still written.
- No scan given takes every folder with a `point_cloud.ply`, and skips a
  folder without one.
- Merging: another capture's row is kept byte for byte, the scan's old row
  replaced, and a re-run gives the same file.
- Refused, leaving the file untouched and no temporary file: a header without
  `epsg`, or without `offsetz`; `epsg 3826`; `epsg 32651.0`; `offsetx abc`;
  `shiftx 1`; `scalez 2`; a `point_cloud.sog` instead; two captures; a path
  as `<scan>`; a scan given twice; a missing scan; a file with another header.
- `original/` is only read: `T1`'s folder is byte for byte as it was after
  every run.
- `test/run.sh` loads `T1`'s generated row through the real `04_splats.sql`
  in `header` mode (the splat spec, *Tests*).

## Docs

- `infra/README.md`: the splat section says the default placement is the
  header, how to write `georef.csv`, and how to switch back to the control
  points (`SPLATS_PLACEMENT=control_points ./load.sh`).
- `infra/CLAUDE.md`: the folder map gains `georef.mjs`, `ply-header.mjs`,
  `scan-csv.mjs`,
  `04_splats_header.sql`, `specs/georef.md` and `test/georef.sh`; *The
  contract with `app/`* says placements come from the header by default.
- `app/ai/DECISIONS.md`: a new top entry.

## Changes from revision 1

- A scan given twice is refused, naming it. It used to write two rows, which
  the loader then refused.
- `epsg` must be digits only. `32651.0` used to pass here and be copied into
  a row the loader refuses.
- The scan list, the kept rows and the rename move to `scripts/scan-csv.mjs`,
  shared with `control-points.mjs`, which gains the same two refusals.

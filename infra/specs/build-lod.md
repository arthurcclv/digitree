# Spec — `build-lod.sh`: a tile's level-of-detail tree, as a paged `.rad`

Status: **revision 4, approved 2026-10-29**, with `specs/splat-mosaic.md`:
the trees are built from the mosaic's tiles, `tiles/<tile>.ply`, not from
`source/<scan>.spz`, and `--all` builds every tile; see *Changes from
revision 3*. Revision 3 (approved 2026-10-23) moved the script to
`infra/scripts/`; see *Changes from revision 2*. Revision 2 made the output
chunked (`--rad-chunked`). Revision 1 wrote one `.rad` read by byte ranges. Approved
with `app/src/layers/splat/specs/spec.md` revision 5 (paged LoD), which is
where the measurements behind it are.

## What it is

A script in `infra/scripts/` that builds each tile of the mosaic
(`specs/splat-mosaic.md`) into a level-of-detail tree offline and writes it
as the `.rad` file the app draws. Spark streams a
`.rad` page by page into a fixed-size pool, so the app holds only what the
view needs. Before this script, the app built the tree in the browser from the
whole `.spz` on every load, and kept every splat.

```bash
./scripts/build-lod.sh 32651-352600-2770000   # tiles/<tile>.ply → lod/<tile>-lod.rad + -lod-<n>.radc
./scripts/build-lod.sh A B C                  # several tiles, one after another
./scripts/build-lod.sh --all                  # every tile in tiles/, then lod/ pruned to them
```

## Where files live

```
data/3dgs/tiles/<tile>.ply           a tile of the mosaic (splat-mosaic.mjs) — read, never written
data/3dgs/lod/<tile>-lod.rad         its LoD tree's header: the chunks' names, offsets and sizes
data/3dgs/lod/<tile>-lod-<n>.radc    one file per 64 K-splat chunk, n = 0, 1, …
                                     — all written only by build-lod.sh
```

The header names its chunks by file name, relative to itself, so they must
sit beside it. That is why the layout is flat.

The `files` service serves `lod/` at `/3dgs-lod/`, beside `tiles/` at
`/3dgs/`. `04_splats.sql` (`splats_lod_dir`) requires `<stem>-lod.rad` for
every capture, where `<stem>` is its `File` less the extension. The "never
modify `data/`" rule has an exception for it: `build-lod.sh` owns
`data/3dgs/lod/`, which is derived from `tiles/` and can always be rebuilt.

## Inputs

| input | default | meaning |
| --- | --- | --- |
| `<tile>…` | — | one or more bare tile ids; the script reads each `tiles/<tile>.ply` |
| `--all` | — | instead of tiles: every `tiles/*.ply`, then prune `lod/` (step 7) |
| `SPLATS_TILES_DIR` | `data/3dgs/tiles` | env: where the mosaic's tiles are |
| `SPLATS_LOD_DIR` | `data/3dgs/lod` | env: where the trees are written |

The two directories are variables for the same reason the loader's inputs
are: the test suite points the real script at a scratch directory.

There are no other options. The method is fixed (below), so every tile gets
the same tree from one command.

## What it does

1. **Refuses**, before building anything: no argument; `--all` with
   anything after it, or with no tiles in `tiles/`; a tile that is not a bare
   name (`/`, `.`, `..`, or a leading `-`); a tile with no
   `tiles/<tile>.ply`; and a host without `docker` or `node` (step 4 reads
   the `.rad` header with `node`, which the mosaic, the step before, already
   needs).
2. **Builds** with Spark's own `build-lod` (`rust/build-lod` in the Spark
   repo) at **tag `v2.3.1`**, the version `app/package.json` pins. The `.rad`
   format is read by the app's Spark, so the writer is held to it. It runs
   in **`rust:1.88-bookworm`**, with nothing installed on the host for it but
   Docker. The first run clones the tag and compiles the tool, in about a
   minute. The tool and cargo's downloads are kept in the Docker volume
   `splat-build-lod-v2.3.1`, so later runs skip that step. The crate is
   compiled with `--no-default-features`: the default `gpu` feature only
   clusters spherical harmonics and needs a GPU the container lacks, and the
   captures have none.
3. **Runs** `build-lod --quality --rad-chunked` on the tile's `.ply`, as it
   is: Spark's `build-lod` reads PLY itself (its `MultiDecoder` detects the
   format from the content), so nothing converts it first. `--quality`
   is `bhatt-lod`, Spark's recommended method for trees built offline and
   streamed. `--rad-chunked` writes a header and one `.radc` per chunk. Spark
   fetches each chunk file whole, so a chunk is cached and revalidated on its
   own (ETag), and the server needs no byte ranges beyond the header.
4. **Checks** that the header is non-empty and starts with the magic `RAD0`,
   and that every chunk file it names was written, non-empty. `build-lod`
   reports an input it cannot read and still exits 0, so this check is what
   fails such an input. The script then prints the tail of the tool's log.
5. **Replaces** the tile's tree. Everything is built in a temporary directory inside
   `lod/`, so a failed run leaves the previous tree, and no partial file, in
   place. On success, the old `<tile>-lod-*.radc` are removed, the new chunks
   are renamed in, and the header is renamed last. A set of files cannot be
   swapped atomically. For the moment between the steps, a reader can see the
   old header with missing chunks, which fails its fetch, and never a new
   header with old chunks.
6. **Reports** the input's splats, the tree's nodes, the number of chunks and
   their total size. Steps 2–6 run for each tile in turn; a failure stops
   the run there, with the tiles already built kept and the failing one's
   previous tree in place.
7. **Prunes**, with `--all` only: after every tile is built, each
   `<x>-lod.rad` and `<x>-lod-<n>.radc` in `lod/` whose `tiles/<x>.ply` no
   longer exists is removed, and the count reported. `--all` owns `lod/`;
   a run naming tiles never touches another tile's files.

## Output contract

- `lod/<tile>-lod.rad`: a `.rad` header with `lodTree: true`, naming
  `<tile>-lod-0.radc` … `<tile>-lod-<N−1>.radc`, which together hold every
  input splat as a leaf plus the interior nodes. Built per scan, KZ0918 came
  to 1.48× the splats, in 294 and 411 chunks of 64 K splats.
- No `<tile>-lod-*.radc` beyond those the header names: a rebuild with fewer
  chunks leaves none behind.
- Coordinates as stored in the tile, in its own frame. The step-0 spike found
  a drawn capture within 0.26 px (about 0.15 m) of the file drawn without LoD,
  so the tile's placement from `georef.csv` holds for its tree.
- The header records the build's durations, so a re-run is not identical byte
  for byte. The tree is.
- Nothing else in `lod/` is written, and other tiles' files are untouched,
  except by `--all`'s pruning. `tiles/` is never written.

Measured per scan, from its `.spz`, on an Apple M4 with 8 GB for Docker
(revision 3; a tile holds fewer splats than a whole scan):

| scan | splats | time | peak memory | tree |
| --- | --- | --- | --- | --- |
| KZ0918-090946 | 12,965,333 | 2 min 28 s | 3.6 GB | 339 MB |
| KZ0918-075047 | 18,621,308 | 3 min 42 s | 5.0 GB | 474 MB |

(Measured as one `.rad`; chunked, the same bytes are split across files.)

## Tests

`test/build-lod.sh` runs at the end of `test/run.sh` and can also run on its
own. It generates a 108,000-Gaussian grid, and a 3,000-Gaussian one, with
splat-transform's `.mjs` generator input and saves them as `<tile>.ply` in a
scratch directory, so no binary fixture is checked in. It asserts:

- the script reads `tiles/<tile>.ply` and writes `lod/<tile>-lod.rad`, a RAD header that says `lodTree`,
  holds at least the input's splats and names chunk files, every one of which
  is in `lod/`, non-empty;
- it reports the counts;
- it leaves the tile unchanged and nothing in `lod/` but the header and its
  chunks;
- a re-run replaces the tree with one of the same node count, and stale
  chunks beyond the new count are removed;
- another tile's tree in `lod/` is untouched, including a tile whose name
  starts with this one's;
- several tiles named build each; `--all` builds every tile in `tiles/`,
  removes the trees of tiles not there (and says how many files), and leaves
  only the tiles' headers and chunks;
- it refuses a missing tile (alone, or among others, before building any), a
  path, an option given as a tile, no argument, `--all` with a tile, and
  `--all` with no tiles;
- it fails on a file `build-lod` cannot read, and leaves no output or
  temporary file behind.

`test/run.sh` covers the loader's side: a capture without its
`<stem>-lod.rad` fails the splat load, naming it. Every other splat fixture
has a stand-in `.rad` in `test/fixtures/splats/lod/`.

## Out of scope

- Running it from `load.sh`. Like `process-splat.sh`, it is an explicit step.
- Building from anything but the mosaic's `tiles/<tile>.ply`.
- Building tiles in parallel. One container at a time keeps the peak memory
  that of the largest tile.
- Spherical harmonics (`--cluster-sh`), which the captures do not have.

## Changes from revision 3

- The input is a tile of the mosaic, `tiles/<tile>.ply`, not a cleaned scan,
  `source/<scan>.spz`; Spark's `build-lod` reads the PLY directly.
  `SPLATS_SOURCE_DIR` becomes `SPLATS_TILES_DIR`.
- It takes one or more tiles, or `--all`, which builds every tile and then
  prunes `lod/` of the trees of tiles that are gone.
- Tests: the grids are written as `.ply`; new cases for several tiles,
  `--all` and its pruning, and its refusals.

## Changes from revision 2

- `build-lod.sh` moves from `infra/` to `infra/scripts/`, beside the other
  splat tools; run it from `infra/` as `./scripts/build-lod.sh <scan>`. Paths
  it reads and writes are still relative to `infra/`, and the loader's
  missing-LoD message names the new path. Nothing else changes.

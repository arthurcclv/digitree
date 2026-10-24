# Spec — `build-lod.sh`: a capture's level-of-detail tree, as a paged `.rad`

Status: **revision 3, approved 2026-10-23**: the script moves to
`infra/scripts/`; see *Changes from revision 2*. Revision 2 made the output
chunked (`--rad-chunked`). Revision 1 wrote one `.rad` read by byte ranges. Approved
with `app/src/layers/splat/specs/spec.md` revision 5 (paged LoD), which is
where the measurements behind it are.

## What it is

A script in `infra/scripts/` that builds a cleaned capture's level-of-detail tree
offline and writes it as the `.rad` file the app draws. Spark streams a
`.rad` page by page into a fixed-size pool, so the app holds only what the
view needs. Before this script, the app built the tree in the browser from the
whole `.spz` on every load, and kept every splat.

```bash
./scripts/build-lod.sh KZ0918-075047      # source/KZ0918-075047.spz → lod/KZ0918-075047-lod.rad + -lod-<n>.radc
```

## Where files live

```
data/3dgs/source/<scan>.spz          the cleaned capture (process-splat.sh) — read, never written
data/3dgs/lod/<scan>-lod.rad         its LoD tree's header: the chunks' names, offsets and sizes
data/3dgs/lod/<scan>-lod-<n>.radc    one file per 64 K-splat chunk, n = 0, 1, …
                                     — all written only by build-lod.sh
```

The header names its chunks by file name, relative to itself, so they must
sit beside it. That is why the layout is flat.

The `files` service serves `lod/` at `/3dgs-lod/`, beside `source/` at
`/3dgs/`. `04_splats.sql` (`splats_lod_dir`) requires `<stem>-lod.rad` for
every capture, where `<stem>` is its `File` less the extension. The "never
modify `data/`" rule gains a third exception: `build-lod.sh` owns
`data/3dgs/lod/`, which is derived from `source/` and can always be rebuilt.

## Inputs

| input | default | meaning |
| --- | --- | --- |
| `<scan>` | — | a bare scan name; the script reads `source/<scan>.spz` |
| `SPLATS_SOURCE_DIR` | `data/3dgs/source` | env: where the cleaned captures are |
| `SPLATS_LOD_DIR` | `data/3dgs/lod` | env: where the trees are written |

The two directories are variables for the same reason the loader's inputs
are: the test suite points the real script at a scratch directory.

There are no options. The method is fixed (below), so every capture gets the
same tree from one command.

## What it does

1. **Refuses** a missing argument, a scan that is not a bare name (`/`, `.`,
   `..`, or a leading `-`), a scan with no `source/<scan>.spz`, and a host
   without `docker` or `node` (step 4 reads the `.rad` header with `node`,
   which `process-splat.sh`, the step before, already needs).
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
3. **Runs** `build-lod --quality --rad-chunked` on the capture. `--quality`
   is `bhatt-lod`, Spark's recommended method for trees built offline and
   streamed. `--rad-chunked` writes a header and one `.radc` per chunk. Spark
   fetches each chunk file whole, so a chunk is cached and revalidated on its
   own (ETag), and the server needs no byte ranges beyond the header.
4. **Checks** that the header is non-empty and starts with the magic `RAD0`,
   and that every chunk file it names was written, non-empty. `build-lod`
   reports an input it cannot read and still exits 0, so this check is what
   fails such an input. The script then prints the tail of the tool's log.
5. **Replaces** the tree. Everything is built in a temporary directory inside
   `lod/`, so a failed run leaves the previous tree, and no partial file, in
   place. On success, the old `<scan>-lod-*.radc` are removed, the new chunks
   are renamed in, and the header is renamed last. A set of files cannot be
   swapped atomically. For the moment between the steps, a reader can see the
   old header with missing chunks, which fails its fetch, and never a new
   header with old chunks.
6. **Reports** the input's splats, the tree's nodes, the number of chunks and
   their total size.

## Output contract

- `lod/<scan>-lod.rad`: a `.rad` header with `lodTree: true`, naming
  `<scan>-lod-0.radc` … `<scan>-lod-<N−1>.radc`, which together hold every
  input splat as a leaf plus the interior nodes. For KZ0918 this is 1.48×
  the splats, in 294 and 411 chunks of 64 K splats.
- No `<scan>-lod-*.radc` beyond those the header names: a rebuild with fewer
  chunks leaves none behind.
- Coordinates as stored in the `.spz`. The step-0 spike found the drawn
  capture within 0.26 px (about 0.15 m) of the `.spz` drawn without LoD. So a
  capture's control points, and `04_splats.sql`'s fit, are unchanged.
- The header records the build's durations, so a re-run is not identical byte
  for byte. The tree is.
- Nothing else in `lod/` is written, and other scans' files are untouched.
  `source/` is never written.

Measured on an Apple M4 with 8 GB for Docker:

| scan | splats | time | peak memory | tree |
| --- | --- | --- | --- | --- |
| KZ0918-090946 | 12,965,333 | 2 min 28 s | 3.6 GB | 339 MB |
| KZ0918-075047 | 18,621,308 | 3 min 42 s | 5.0 GB | 474 MB |

(Measured as one `.rad`; chunked, the same bytes are split across files.)

## Tests

`test/build-lod.sh` runs at the end of `test/run.sh` and can also run on its
own. It generates a 2,000-Gaussian grid with splat-transform's `.mjs`
generator input and saves it as `<scan>.spz` in a scratch directory, so no
binary fixture is checked in. It asserts:

- the script writes `lod/<scan>-lod.rad`, a RAD header that says `lodTree`,
  holds at least the input's splats and names chunk files, every one of which
  is in `lod/`, non-empty;
- it reports the counts;
- it leaves the source unchanged and nothing in `lod/` but the header and its
  chunks;
- a re-run replaces the tree with one of the same node count, and stale
  chunks beyond the new count are removed;
- another scan's tree in `lod/` is untouched, including a scan whose name
  starts with this one's;
- it refuses a missing scan, a path, an option given as a scan, and no
  argument;
- it fails on a file `build-lod` cannot read, and leaves no output or
  temporary file behind.

`test/run.sh` covers the loader's side: a capture without its
`<stem>-lod.rad` fails the splat load, naming it. Every other splat fixture
has a stand-in `.rad` in `test/fixtures/splats/lod/`.

## Out of scope

- Running it from `load.sh`. Like `process-splat.sh`, it is an explicit step.
- Building from anything but the cleaned `.spz`.
- Spherical harmonics (`--cluster-sh`), which the captures do not have.

## Changes from revision 2

- `build-lod.sh` moves from `infra/` to `infra/scripts/`, beside the other
  splat tools; run it from `infra/` as `./scripts/build-lod.sh <scan>`. Paths
  it reads and writes are still relative to `infra/`, and the loader's
  missing-LoD message names the new path. Nothing else changes.

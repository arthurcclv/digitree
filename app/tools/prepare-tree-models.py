#!/usr/bin/env python3
"""
Prepare downloaded glTF tree models for `app/public/models/trees/`.

The models the tree layer serves are not the files that were downloaded. See
"The assets" in `src/layers/tree/specs/spec.md`; this script is the other half
of that section.

Each original produces **one served file per rung of the detail ladder** --
`<name>.glb` at level 0, then `<name>.L1.glb`, `<name>.L2.glb` and so on, each
more decimated than the last. The ladder is the `LEVELS` table below; its
counterpart is `MODEL_LODS` in `src/layers/tree/models.ts`, which decides how
far each rung reaches. Adding a level is a row in each.

For every file, this script does exactly two things:

1. Resizes every texture to at most MAX_TEXTURE px on its long edge and
   re-encodes it as WebP, declaring `EXT_texture_webp`. The originals carry
   uncompressed 1024x1024 PNGs -- 4-11 MB a file, 124 MB across the set -- and
   a tree on this map is tens of pixels wide at z16. WebP rather than JPEG
   because the foliage is `alphaMode: MASK` and the cutout lives in the
   baseColor alpha channel, which JPEG does not carry.

2. Preserves `asset.extras` byte for byte. That block holds each model's author,
   licence and source URL and is the only record of them inside the file.
   `CREDITS.md` is generated from it, never typed.

A decimated rung is built first, by `gltf-transform` (meshoptimizer), and
**welded before it is simplified** -- see `decimate` for why that is not
tidying -- then prepared with smaller textures, because a tree far enough away
to want fewer triangles resolves fewer texels too.

Models that do not declare a CC-BY licence are refused rather than prepared:
`public/` is downloadable by definition, so a licence that forbids
redistributing the model file forbids serving it. `src/layers/tree/models.test.ts`
asserts the same thing from the other end.

    python3 tools/prepare-tree-models.py <source-dir> [--out public/models/trees]

Requires Pillow with WebP support (`python3 -c "import PIL"`) and the
`@gltf-transform/cli` devDependency (`npm install` in `app/`).
"""

from __future__ import annotations

import argparse
import io
import json
import pathlib
import struct
import subprocess
import sys
import tempfile

from PIL import Image

APP_DIR = pathlib.Path(__file__).resolve().parent.parent

LEVELS = (
    # level 0: the authored model, at the plain name. A tree is a few hundred
    # pixels across at z20, so 512 px is the most that is ever resolved.
    {"suffix": "", "texture": 512, "ratio": None},
    # level 1: from 300 m out, where neither the triangles nor the texels land.
    {"suffix": ".L1", "texture": 128, "ratio": "0.1"},
)
"""
The detail ladder. Mirrors `MODEL_LODS` in `src/layers/tree/models.ts`, which
holds the distance each rung reaches; this table holds how each is built.

Adding an `L2` is a row here and a row there. `ratio` of `None` means "do not
decimate", which is what makes level 0 the authored model rather than a
suspiciously lossless copy of it.
"""

SIMPLIFY_ERROR = "0.15"
"""
Not raised further because it buys nothing: `beech_tree`, `spruce` and
`date_palm` fall short of the ratio at 0.15, 0.3 and 0.6 alike. Their foliage is
disconnected cards that meshoptimizer will not collapse, and `--lock-border
false` is already the default.
"""

WEBP_QUALITY = 85
WEBP_METHOD = 6
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
WEBP_EXTENSION = "EXT_texture_webp"


def read_glb(path: pathlib.Path) -> tuple[dict, bytes]:
    """Split a .glb into its JSON chunk and its binary chunk."""
    raw = path.read_bytes()
    magic, _version, _length = struct.unpack_from("<III", raw, 0)
    if magic != 0x46546C67:
        raise ValueError(f"{path.name} is not a .glb")

    doc: dict | None = None
    blob = b""
    offset = 12
    while offset < len(raw):
        (chunk_len, chunk_type) = struct.unpack_from("<II", raw, offset)
        body = raw[offset + 8 : offset + 8 + chunk_len]
        if chunk_type == JSON_CHUNK:
            doc = json.loads(body.decode("utf-8"))
        elif chunk_type == BIN_CHUNK:
            blob = body
        offset += 8 + chunk_len + (-chunk_len % 4)

    if doc is None:
        raise ValueError(f"{path.name} has no JSON chunk")
    return doc, blob


def write_glb(path: pathlib.Path, doc: dict, blob: bytes) -> None:
    """The inverse. Both chunks are padded to 4 bytes, per the glTF spec."""
    text = json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    text += b" " * (-len(text) % 4)
    blob += b"\x00" * (-len(blob) % 4)

    total = 12 + 8 + len(text) + (8 + len(blob) if blob else 0)
    out = bytearray()
    out += struct.pack("<III", 0x46546C67, 2, total)
    out += struct.pack("<II", len(text), JSON_CHUNK) + text
    if blob:
        out += struct.pack("<II", len(blob), BIN_CHUNK) + blob
    path.write_bytes(bytes(out))


def decimate(source: pathlib.Path, workdir: pathlib.Path, ratio: str) -> pathlib.Path:
    """
    A decimated copy of `source`, via meshoptimizer.

    **The weld pass is load-bearing, not tidying.** These are Sketchfab exports
    with split vertices, and meshoptimizer will not collapse an edge across a
    split. Run without it, oak_tree's leaf mesh obeyed the ratio (7,340 -> 673
    triangles) while its trunk did not move *at all* -- 1,024 before and 1,024
    after, at every ratio tried. Welded first, the same command reaches the
    target on every primitive: 8,364 -> 775 triangles, a 10.8x reduction.

    A prep step that silently declines to simplify an eighth of the geometry is
    the kind of thing that only ever shows up in a frame-time graph.
    """
    welded = workdir / "welded.glb"
    simplified = workdir / f"simplified-{ratio}.glb"
    for args in (
        ["weld", str(source), str(welded)],
        ["simplify", str(welded), str(simplified),
         "--ratio", ratio, "--error", SIMPLIFY_ERROR],
    ):
        result = subprocess.run(
            ["npx", "--no-install", "gltf-transform", *args],
            cwd=APP_DIR, capture_output=True, text=True,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"gltf-transform {args[0]} failed for {source.name}.\n"
                f"Is `@gltf-transform/cli` installed? Run `npm install` in app/.\n"
                f"{result.stderr.strip()[:500]}"
            )
    return simplified


def shrink(data: bytes, max_px: int) -> bytes:
    """One texture, downscaled to fit `max_px` and re-encoded as WebP."""
    image = Image.open(io.BytesIO(data))
    # RGBA is kept: a MASK-mode foliage material cuts its leaves out of the
    # baseColor alpha channel, so dropping it fills the gaps between leaves in.
    image = image.convert("RGBA" if "A" in image.getbands() else "RGB")

    longest = max(image.size)
    if longest > max_px:
        scale = max_px / longest
        size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
        image = image.resize(size, Image.LANCZOS)

    buffer = io.BytesIO()
    image.save(buffer, format="WEBP", quality=WEBP_QUALITY, method=WEBP_METHOD)
    return buffer.getvalue()


def prepare(doc: dict, blob: bytes, max_px: int) -> dict:
    """
    Rewrite every image as WebP and rebuild the binary chunk around the result.

    The buffer is rebuilt rather than patched because the images change length:
    every bufferView is copied in order into a fresh blob, 4-byte aligned, and
    its `byteOffset` updated to match.
    """
    views = doc.get("bufferViews", [])
    replaced: dict[int, bytes] = {}

    for image in doc.get("images", []):
        index = image.get("bufferView")
        if index is None:
            continue  # A URI-referenced image; nothing embedded to shrink.
        view = views[index]
        start = view.get("byteOffset", 0)
        replaced[index] = shrink(blob[start : start + view["byteLength"]], max_px)
        image["mimeType"] = "image/webp"

    rebuilt = bytearray()
    for index, view in enumerate(views):
        data = replaced.get(index)
        if data is None:
            start = view.get("byteOffset", 0)
            data = blob[start : start + view["byteLength"]]
        rebuilt += b"\x00" * (-len(rebuilt) % 4)
        view["byteOffset"] = len(rebuilt)
        view["byteLength"] = len(data)
        rebuilt += data

    # An image is reached through its texture, so the extension goes on the
    # texture. With no fallback `source` left, the extension is required.
    for texture in doc.get("textures", []):
        source = texture.pop("source", None)
        if source is None:
            source = texture.get("extensions", {}).get(WEBP_EXTENSION, {}).get("source")
        texture.setdefault("extensions", {})[WEBP_EXTENSION] = {"source": source}

    for key in ("extensionsUsed", "extensionsRequired"):
        declared = doc.setdefault(key, [])
        if WEBP_EXTENSION not in declared:
            declared.append(WEBP_EXTENSION)

    doc["buffers"] = [{"byteLength": len(rebuilt)}]
    return {"doc": doc, "blob": bytes(rebuilt)}


def credits_row(names: list[str], extras: dict) -> str:
    """
    One row per model, naming every file the ladder produced for it.

    A decimated rung is covered by the credit of the model it derives from — a
    decimated CC BY asset is still a CC BY asset — so the rungs are named here
    rather than given rows of their own.
    """
    title = extras.get("title", names[0])
    author = extras.get("author", "unknown")
    licence = extras.get("license", "unknown")
    source = extras.get("source", "")
    files = " · ".join(f"`{name}`" for name in names)
    return f"| {files} | {title} | {author} | {licence} | {source} |"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=pathlib.Path, help="directory of original .glb files")
    parser.add_argument(
        "--out",
        type=pathlib.Path,
        default=pathlib.Path(__file__).resolve().parent.parent / "public" / "models" / "trees",
        help="where the prepared models are written",
    )
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    rows: list[str] = []
    refused: list[tuple[str, str]] = []
    before = after = 0

    for path in sorted(args.source.glob("*.glb")):
        doc, blob = read_glb(path)
        extras = doc.get("asset", {}).get("extras", {}) or {}
        licence = str(extras.get("license", ""))

        # Refused, not silently skipped: anything under public/ is downloadable,
        # so a licence that forbids redistributing the file forbids serving it.
        if not licence.upper().startswith("CC-BY"):
            refused.append((path.name, licence or "no licence declared"))
            continue

        names: list[str] = []
        written: list[int] = []

        with tempfile.TemporaryDirectory() as tmp:
            for level in LEVELS:
                name = path.stem + level["suffix"] + ".glb"
                if level["ratio"] is None:
                    level_doc, level_blob = read_glb(path)
                else:
                    small = decimate(path, pathlib.Path(tmp), level["ratio"])
                    level_doc, level_blob = read_glb(small)
                    # Carried forward explicitly rather than trusted: this block
                    # is the only record of the licence inside the file, and a
                    # tool in the middle of the pipeline is free to drop it.
                    level_doc.setdefault("asset", {})["extras"] = extras

                target = args.out / name
                prepared = prepare(level_doc, level_blob, level["texture"])
                write_glb(target, prepared["doc"], prepared["blob"])
                names.append(name)
                written.append(target.stat().st_size)

        before += path.stat().st_size
        after += sum(written)
        rows.append(credits_row(names, extras))
        sizes = " + ".join(f"{n / 1048576:.2f}" for n in written)
        print(
            f"  {path.name:<45} {path.stat().st_size / 1048576:6.1f} MB"
            f" -> {sizes} MB"
        )

    (args.out / "CREDITS.md").write_text(
        "# Tree model credits\n\n"
        "**Generated by `app/tools/prepare-tree-models.py` from each model's\n"
        "`asset.extras` block. Do not edit by hand.**\n\n"
        "Every model below is served from `public/models/trees/` and is used\n"
        "under the licence named in its row. CC BY 4.0 requires the author, the\n"
        "licence and a link, which is what this file and `MODELS_ATTRIBUTION`\n"
        "in `src/layers/tree/constants.ts` exist to satisfy.\n\n"
        "| files | title | author | licence | source |\n"
        "| --- | --- | --- | --- | --- |\n" + "\n".join(sorted(rows)) + "\n",
        encoding="utf-8",
    )

    print(
        f"\n{len(rows)} models, {len(LEVELS)} levels each: "
        f"{before / 1048576:.0f} MB -> {after / 1048576:.1f} MB"
    )
    for name, why in refused:
        print(f"refused {name}: {why}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

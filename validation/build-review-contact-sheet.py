#!/usr/bin/env python3
"""Build a labelled reference-photo vs reconstructed-mesh contact sheet."""
from __future__ import annotations
import argparse
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps


def fit(image: Image.Image, size: tuple[int, int], background=(245, 246, 248)):
    source = ImageOps.exif_transpose(image).convert("RGB")
    thumb = ImageOps.contain(source, size)
    canvas = Image.new("RGB", size, background)
    canvas.paste(thumb, ((size[0] - thumb.width) // 2, (size[1] - thumb.height) // 2))
    return canvas


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--references", required=True, type=Path)
    parser.add_argument("--previews", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--columns", type=int, default=4)
    args = parser.parse_args()

    items = []
    for path in sorted(args.references.glob("*")):
        if path.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp"}:
            continue
        items.append((f"REFERENCE  |  {path.name}", path))
    for name in ("front-orthographic.png", "side-orthographic.png", "top-orthographic.png"):
        path = args.previews / name
        if path.is_file():
            items.append((f"GLB REVIEW  |  {name.replace('-orthographic.png', '').upper()}", path))
    if not items:
        raise SystemExit("No reference photos or model previews were found")

    columns = max(1, args.columns)
    cell_w, cell_h, header_h, margin = 380, 270, 38, 12
    rows = (len(items) + columns - 1) // columns
    title_h, footer_h = 80, 58
    width = columns * cell_w + (columns + 1) * margin
    height = title_h + rows * (cell_h + margin) + footer_h
    sheet = Image.new("RGB", (width, height), (250, 250, 251))
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default()
    draw.text((margin, 18), "AHSAN MANZIL — REAL-MEDIA RECONSTRUCTION REVIEW", fill=(20, 28, 38), font=font)
    draw.text((margin, 42), "Reference photos and GLB orthographic silhouettes; source attributions are in reference-image-attribution.txt", fill=(65, 72, 82), font=font)

    for index, (label, path) in enumerate(items):
        row, column = divmod(index, columns)
        x, y = margin + column * (cell_w + margin), title_h + row * (cell_h + margin)
        draw.rectangle((x, y, x + cell_w, y + cell_h), fill=(255, 255, 255), outline=(205, 210, 216), width=1)
        draw.text((x + 8, y + 8), label[:58], fill=(24, 31, 41), font=font)
        try:
            with Image.open(path) as im:
                tile = fit(im, (cell_w - 16, cell_h - header_h - 14))
            sheet.paste(tile, (x + 8, y + header_h))
        except Exception as error:
            draw.text((x + 8, y + header_h + 8), f"Could not open image: {error}", fill=(150, 40, 40), font=font)

    footer_y = title_h + rows * (cell_h + margin) + 8
    draw.text((margin, footer_y), "Important: a visual resemblance is not a metric of survey accuracy; inspect dimension-comparison.json and overall-validation.json.", fill=(70, 75, 85), font=font)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(args.output, quality=90)
    print(f"Wrote {args.output} ({width}x{height}) using {len(items)} images")


if __name__ == "__main__":
    main()

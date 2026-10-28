#!/usr/bin/env bash
set -euo pipefail

# Download only the small public metadata PDF. Never fetch the multi-GB
# imagery, LAZ, orthophoto, or mesh archives in this inspection workflow.
readonly SOURCE_URL="https://zenodo.org/records/15282970/files/TUM_Downtown_ULS_Photogrammetry_20241217_docu.pdf?download=1"
readonly EXPECTED_MD5="3427e70196d1db6a126acb6f041da04a"
readonly MAX_BYTES=$((10 * 1024 * 1024))

output_arg="${1:-artifacts/brf27-tum-metadata}"
mkdir -p "$output_arg"
output_dir="$(cd "$output_arg" && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

for command_name in curl md5sum sha256sum pdfinfo pdftotext pdftoppm python3; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command is missing: $command_name" >&2
    exit 2
  fi
done

pdf_path="$tmp_dir/TUM_Downtown_ULS_Photogrammetry_20241217_docu.pdf"
text_path="$output_dir/metadata-extract.txt"
pdfinfo_path="$output_dir/pdfinfo.txt"
report_path="$output_dir/metadata-audit.json"

curl --fail --location --silent --show-error --retry 3 --retry-all-errors \
  --connect-timeout 15 --max-time 180 "$SOURCE_URL" --output "$pdf_path"

actual_bytes="$(wc -c < "$pdf_path" | tr -d '[:space:]')"
if [[ ! "$actual_bytes" =~ ^[0-9]+$ ]] || (( actual_bytes <= 0 || actual_bytes > MAX_BYTES )); then
  echo "Downloaded PDF size is invalid or exceeds the 10 MiB safety limit: $actual_bytes bytes" >&2
  exit 1
fi

actual_md5="$(md5sum "$pdf_path" | awk '{print $1}')"
if [[ "$actual_md5" != "$EXPECTED_MD5" ]]; then
  echo "Publisher MD5 mismatch. Expected $EXPECTED_MD5, received $actual_md5." >&2
  exit 1
fi
actual_sha256="$(sha256sum "$pdf_path" | awk '{print $1}')"

pdfinfo "$pdf_path" > "$pdfinfo_path"
pdftotext -layout -enc UTF-8 "$pdf_path" "$text_path"
# Render a small set of source pages for human verification of tables/figures
# that text extraction may not preserve. The original PDF stays ephemeral.
for page_number in 2 4 7; do
  page_label="$(printf '%02d' "$page_number")"
  pdftoppm -f "$page_number" -l "$page_number" -png -r 90 -singlefile \
    "$pdf_path" "$output_dir/page-preview-$page_label" >/dev/null 2>&1
done
if [[ ! -s "$text_path" ]]; then
  echo "PDF text extraction produced an empty file; do not infer missing metadata from an empty extraction." >&2
  exit 1
fi

BRF27_SOURCE_URL="$SOURCE_URL" \
BRF27_EXPECTED_MD5="$EXPECTED_MD5" \
BRF27_ACTUAL_MD5="$actual_md5" \
BRF27_ACTUAL_SHA256="$actual_sha256" \
BRF27_BYTE_SIZE="$actual_bytes" \
BRF27_PDFINFO_PATH="$pdfinfo_path" \
BRF27_TEXT_PATH="$text_path" \
BRF27_REPORT_PATH="$report_path" \
python3 <<'PY'
import json
import os
import re
from pathlib import Path

text_path = Path(os.environ["BRF27_TEXT_PATH"])
pdfinfo_path = Path(os.environ["BRF27_PDFINFO_PATH"])
report_path = Path(os.environ["BRF27_REPORT_PATH"])
text = text_path.read_text(encoding="utf-8", errors="replace")
lines = text.splitlines()

categories = {
    "horizontal_crs": [
        r"coordinate reference", r"\bcrs\b", r"\bepsg\b", r"\butm\b",
        r"etrs", r"\bprojection\b", r"horizontal reference",
    ],
    "vertical_reference": [
        r"vertical datum", r"height system", r"geoid", r"orthometric",
        r"ellipsoid", r"d[h]?hn", r"height reference", r"vertical reference",
    ],
    "units_and_offsets": [
        r"\bunits?\b", r"\bmetres?\b", r"\bmeters?\b", r"offset",
        r"translation", r"local coordinate", r"coordinate origin",
    ],
    "accuracy_and_controls": [
        r"accuracy", r"uncertainty", r"control point", r"check point",
        r"checkpoint", r"ground control", r"rtk", r"gnss", r"trajectory",
    ],
    "processing_and_sensor": [
        r"scanner", r"point cloud", r"photogrammetry", r"camera",
        r"boresight", r"lever arm", r"calibration", r"registration",
    ],
}
compiled = {
    name: [re.compile(pattern, re.IGNORECASE) for pattern in patterns]
    for name, patterns in categories.items()
}
hits = {name: [] for name in categories}
for index, line in enumerate(lines):
    for name, patterns in compiled.items():
        if any(pattern.search(line) for pattern in patterns):
            snippet = {
                "line": index + 1,
                "text": line.strip()[:500],
                "context": [
                    item.strip()[:500]
                    for item in lines[max(0, index - 1):min(len(lines), index + 2)]
                ],
            }
            if not hits[name] or hits[name][-1]["line"] != index + 1:
                hits[name].append(snippet)

for name in hits:
    hits[name] = hits[name][:60]

pdfinfo = pdfinfo_path.read_text(encoding="utf-8", errors="replace")
pages_match = re.search(r"^Pages:\s+(\d+)", pdfinfo, re.MULTILINE)
page_count = int(pages_match.group(1)) if pages_match else None

report = {
    "schemaVersion": "1.0.0",
    "status": "source-bytes-verified-text-extracted-manual-review-required",
    "sourceUrl": os.environ["BRF27_SOURCE_URL"],
    "filename": "TUM_Downtown_ULS_Photogrammetry_20241217_docu.pdf",
    "downloadedBytes": int(os.environ["BRF27_BYTE_SIZE"]),
    "publisherExpectedMd5": os.environ["BRF27_EXPECTED_MD5"],
    "actualMd5": os.environ["BRF27_ACTUAL_MD5"],
    "publisherMd5MatchesActualBytes": (
        os.environ["BRF27_EXPECTED_MD5"] == os.environ["BRF27_ACTUAL_MD5"]
    ),
    "actualSha256": os.environ["BRF27_ACTUAL_SHA256"],
    "pageCount": page_count,
    "extractedTextSha256": __import__("hashlib").sha256(
        text_path.read_bytes()
    ).hexdigest(),
    "extractedLineCount": len(lines),
    "keywordHits": {name: len(values) for name, values in hits.items()},
    "keywordEvidence": hits,
    "reviewPreviews": ["page-preview-02.png", "page-preview-04.png", "page-preview-07.png"],
    "reviewStatus": "pending-human-review",
    "limitations": [
        "Keyword matches are navigation hints, not an interpretation or validation of a CRS/vertical datum.",
        "The raw PDF is kept only in ephemeral workflow storage and is not committed or uploaded.",
        "No asset licence, same-building identity, source-to-reference transform, candidate GLB, or accuracy result is approved by this script.",
        "Do not fill the BRF-27 readiness manifest until a human has reviewed the source pages and recorded exact units, CRS, vertical datum, offsets and transformations.",
    ],
}
report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(json.dumps({
    "status": report["status"],
    "downloadedBytes": report["downloadedBytes"],
    "publisherMd5MatchesActualBytes": report["publisherMd5MatchesActualBytes"],
    "actualSha256": report["actualSha256"],
    "pageCount": report["pageCount"],
    "keywordHits": report["keywordHits"],
    "reviewStatus": report["reviewStatus"],
}, indent=2))
PY

echo "Evidence artifact files written to: $output_dir"

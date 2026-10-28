import importlib.util
import json
import struct
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "inspect_tum_citygml_metadata.py"
SPEC = importlib.util.spec_from_file_location("inspect_tum_citygml_metadata", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class FakeResponse:
    def __init__(self, body, status=206, headers=None, final_url="https://example.test/model.gml"):
        self.body = body
        self.status = status
        self.headers = headers or {}
        self.final_url = final_url
        self.read_calls = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def getcode(self):
        return self.status

    def geturl(self):
        return self.final_url

    def read(self, size=-1):
        self.read_calls.append(size)
        if size < 0:
            raise AssertionError("unbounded reads are forbidden")
        return self.body[:size]


def make_gml_prefix():
    return b'''<?xml version="1.0" encoding="UTF-8"?>
<core:CityModel xmlns:core="http://www.opengis.net/citygml/2.0"
 xmlns:gml="http://www.opengis.net/gml" xmlns:bldg="http://www.opengis.net/citygml/building/2.0"
 gml:id="DEBY_LOD3_4959460" srsName="urn:ogc:def:crs:EPSG::25832">
 <gml:boundedBy><gml:Envelope srsName="urn:ogc:def:crs:EPSG::25832" srsDimension="3">
  <gml:lowerCorner>690900.0 5335900.0 515.0</gml:lowerCorner>
  <gml:upperCorner>691020.0 5336020.0 540.0</gml:upperCorner>
 </gml:Envelope></gml:boundedBy>
 <core:cityObjectMember><bldg:Building gml:id="building-123">
'''


class TestCityGMLPrefixParser(unittest.TestCase):
    def test_extracts_root_id_envelope_crs_and_candidate_overlap_without_claiming_identity(self):
        parsed = MODULE.parse_citygml_prefix(make_gml_prefix(), "DEBY_LOD3_4959460.gml")
        self.assertEqual(parsed["status"], "metadata-prefix-parsed")
        self.assertEqual(parsed["filenameLdbvId"], "4959460")
        self.assertEqual(parsed["root"]["gmlId"], "DEBY_LOD3_4959460")
        self.assertIn("building-123", parsed["buildingGmlIds"])
        self.assertEqual(parsed["srsNamesObserved"], ["urn:ogc:def:crs:EPSG::25832"])
        envelope = parsed["firstEnvelope"]
        self.assertEqual(envelope["lowerCorner"], [690900.0, 5335900.0, 515.0])
        self.assertEqual(envelope["upperCorner"], [691020.0, 5336020.0, 540.0])
        overlap = parsed["horizontalOverlapWithUlsHeaderBounds"]
        self.assertEqual(overlap["status"], "different-datum-grid-overlap-needs-transform")
        self.assertFalse(overlap["transformApplied"])
        self.assertFalse(overlap["sameBuildingProven"])

    def test_does_not_claim_envelope_if_prefix_has_no_complete_xml_tag(self):
        parsed = MODULE.parse_citygml_prefix(b"<core:CityModel", "DEBY_LOD3_4959460.gml")
        self.assertEqual(parsed["status"], "blocked")
        self.assertEqual(parsed["reason"], "no-complete-xml-tag-in-prefix")

    def test_detects_lfs_pointer_without_mistaking_it_for_citygml(self):
        pointer = (
            b"version https://git-lfs.github.com/spec/v1\n"
            b"oid sha256:" + (b"a" * 64) + b"\nsize 12345678\n"
        )
        parsed = MODULE.parse_citygml_prefix(pointer, "DEBY_LOD3_4959460.gml")
        self.assertEqual(parsed["status"], "lfs-pointer")
        self.assertEqual(parsed["oidSha256"], "a" * 64)
        self.assertEqual(parsed["declaredObjectBytes"], 12345678)


class TestBoundedRangeSafety(unittest.TestCase):
    def test_http_200_response_is_never_read(self):
        fake = FakeResponse(b"x" * 100000, status=200, headers={"Content-Length": "100000"})
        result = MODULE.bounded_range_get(
            "https://example.test/model.gml",
            opener=lambda *_args, **_kwargs: fake,
        )
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["reason"], "origin-did-not-honor-range-request")
        self.assertEqual(fake.read_calls, [])

    def test_content_length_mismatch_is_rejected_before_read(self):
        fake = FakeResponse(
            b"x" * 10,
            status=206,
            headers={"Content-Range": "bytes 0-9/100", "Content-Length": "11"},
        )
        result = MODULE.bounded_range_get(
            "https://example.test/model.gml",
            opener=lambda *_args, **_kwargs: fake,
        )
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["reason"], "content-length-does-not-match-content-range")
        self.assertEqual(fake.read_calls, [])

    def test_valid_range_reads_only_the_declared_prefix_length(self):
        body = b"abcde"
        fake = FakeResponse(
            body,
            status=206,
            headers={"Content-Range": "bytes 0-4/100000", "Content-Length": "5"},
        )
        result = MODULE.bounded_range_get(
            "https://example.test/model.gml",
            opener=lambda *_args, **_kwargs: fake,
        )
        self.assertEqual(result["status"], "range-read")
        self.assertEqual(result["prefixBytes"], 5)
        self.assertEqual(fake.read_calls, [5])
        self.assertNotIn("fullFileSha256", result)


class TestLfsPrefixResolution(unittest.TestCase):
    def test_resolves_lfs_pointer_then_fetches_only_bounded_gml_prefix(self):
        pointer_oid = "b" * 64
        pointer = (
            b"version https://git-lfs.github.com/spec/v1\n"
            + b"oid sha256:" + pointer_oid.encode() + b"\nsize 9000000\n"
        )
        gml = make_gml_prefix()
        # Pad the response to the exact requested range length; trailing spaces
        # are legal whitespace in an incomplete XML prefix.
        gml_prefix = gml + (b" " * (4096 - len(gml)))
        routes = []

        def opener(request, timeout=30):
            url = request.full_url
            method = request.get_method()
            routes.append((url, method))
            if "/repository/files/" in url:
                return FakeResponse(
                    pointer, status=206,
                    headers={
                        "Content-Range": f"bytes 0-{len(pointer)-1}/{len(pointer)}",
                        "Content-Length": str(len(pointer)),
                    },
                )
            if "/info/lfs/objects/batch" in url and method == "POST":
                payload = json.dumps({
                    "objects": [{
                        "oid": pointer_oid,
                        "size": 9000000,
                        "actions": {"download": {
                            "href": "https://storage.example.test/lfs-object",
                            "header": {},
                        }},
                    }],
                }).encode()
                return FakeResponse(payload, status=200, headers={"Content-Length": str(len(payload))})
            if url == "https://storage.example.test/lfs-object":
                return FakeResponse(
                    gml_prefix, status=206,
                    headers={
                        "Content-Range": f"bytes 0-{len(gml_prefix)-1}/9000000",
                        "Content-Length": str(len(gml_prefix)),
                    },
                )
            raise AssertionError("Unexpected request URL: " + url)

        result = MODULE.get_model_prefix(
            "citygml/lod3-building-datasets/DEBY_LOD3_4959460.gml",
            opener=opener,
        )
        self.assertEqual(result["status"], "range-read")
        self.assertEqual(result["sourceMethod"], "git-lfs-batch-download-range")
        self.assertEqual(result["lfsObject"]["oidSha256Declared"], pointer_oid)
        self.assertFalse(result["lfsObject"]["fullObjectHashVerified"])
        parsed = MODULE.parse_citygml_prefix(result["body"], "DEBY_LOD3_4959460.gml")
        self.assertEqual(parsed["status"], "metadata-prefix-parsed")
        self.assertIn("urn:ogc:def:crs:EPSG::25832", parsed["srsNamesObserved"])
        self.assertEqual(len(routes), 3)


class TestPinnedCatalogPolicy(unittest.TestCase):
    def test_snapshot_commit_and_every_catalog_path_are_pinned_and_valid(self):
        snapshot_path = Path(__file__).resolve().parents[1] / "benchmarks" / "building-reconstruction" / "brf-30-tum-lod3-catalog-snapshot.json"
        snapshot = MODULE.load_snapshot(snapshot_path)
        self.assertEqual(snapshot["source"]["resolvedCommitSha"], "e032a71fc9b3c9c3d4869e3aca9677d1234086aa")
        self.assertEqual(len(snapshot["inventory"]["files"]), 27)
        self.assertFalse(any(snapshot["releaseFlags"].values()))


if __name__ == "__main__":
    unittest.main()

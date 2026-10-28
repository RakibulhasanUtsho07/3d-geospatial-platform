import importlib.util
import io
import struct
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "inspect_brf27_laz_header.py"
SPEC = importlib.util.spec_from_file_location("inspect_brf27_laz_header", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class FakeResponse:
    def __init__(self, body, status=206, headers=None, final_url="https://example.test/data.laz"):
        self._body = body
        self._read_count = 0
        self.status = status
        self.headers = headers or {}
        self._final_url = final_url

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def getcode(self):
        return self.status

    def geturl(self):
        return self._final_url

    def read(self, size=-1):
        self._read_count += 1
        if size < 0:
            raise AssertionError("unbounded read is forbidden")
        return self._body[:size]


def make_minimal_las_prefix(wkt=b'PROJCRS["WGS 84 / UTM zone 32N",ID["EPSG",32632]]'):
    header = bytearray(227)
    header[:4] = b"LASF"
    header[24] = 1
    header[25] = 4
    struct.pack_into("<H", header, 94, 227)
    struct.pack_into("<I", header, 96, 227 + 54 + len(wkt))
    struct.pack_into("<I", header, 100, 1)
    header[104] = 7
    struct.pack_into("<H", header, 105, 36)
    struct.pack_into("<3d", header, 131, 0.001, 0.001, 0.001)
    struct.pack_into("<3d", header, 155, 690000.0, 5336000.0, 0.0)
    struct.pack_into("<6d", header, 179, 691000.0, 690000.0, 5337000.0, 5336000.0, 200.0, 100.0)

    vlr_header = bytearray(54)
    struct.pack_into("<H", vlr_header, 0, 0)
    vlr_header[2:18] = b"LASF_Projection\0\0"
    struct.pack_into("<H", vlr_header, 18, 2112)
    struct.pack_into("<H", vlr_header, 20, len(wkt))
    vlr_header[22:22+len(b"WKT CRS")] = b"WKT CRS"
    return bytes(header + vlr_header + wkt)


class TestBoundedLazHeaderInspector(unittest.TestCase):
    def test_parses_header_scales_offsets_and_wkt_epsg(self):
        parsed = MODULE.parse_las_prefix(make_minimal_las_prefix())
        self.assertEqual(parsed["status"], "header-parsed")
        self.assertEqual(parsed["lasVersion"], "1.4")
        self.assertEqual(parsed["coordinateOffset"]["x"], 690000.0)
        self.assertEqual(parsed["coordinateScale"]["z"], 0.001)
        self.assertEqual(len(parsed["crsEvidence"]), 1)
        self.assertIn("32632", parsed["crsEvidence"][0]["epsgCodesFound"])

    def test_stops_when_prefix_does_not_contain_all_vlrs(self):
        parsed = MODULE.parse_las_prefix(make_minimal_las_prefix()[:240])
        self.assertEqual(parsed["status"], "header-parsed-vlr-partial")
        self.assertEqual(parsed["vlrParseStatus"], "prefix-ended-before-vlr-header")

    def test_invalid_signature_fails_closed(self):
        parsed = MODULE.parse_las_prefix(b"NOPE" + bytes(300))
        self.assertEqual(parsed["status"], "blocked")
        self.assertEqual(parsed["reason"], "invalid-las-signature")

    def test_full_response_200_is_not_read(self):
        fake = FakeResponse(b"x" * 100, status=200, headers={"Content-Length": "2800000000"})
        result = MODULE.inspect_urlopen("https://example.test/data.laz", opener=lambda *_a, **_k: fake)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["reason"], "origin-did-not-honor-range-request")
        self.assertEqual(fake._read_count, 0)

    def test_range_request_must_have_a_valid_content_range(self):
        fake = FakeResponse(b"x" * 10, status=206, headers={"Content-Range": "bytes 1-10/100"})
        result = MODULE.inspect_urlopen("https://example.test/data.laz", opener=lambda *_a, **_k: fake)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["reason"], "content-range-outside-bounded-prefix")
        self.assertEqual(fake._read_count, 0)

    def test_range_body_is_bounded_and_digest_is_only_for_prefix(self):
        body = make_minimal_las_prefix()
        fake = FakeResponse(
            body,
            status=206,
            headers={"Content-Range": f"bytes 0-{len(body)-1}/2800000000", "Content-Length": str(len(body))},
        )
        result = MODULE.inspect_urlopen("https://example.test/data.laz", opener=lambda *_a, **_k: fake)
        self.assertEqual(result["status"], "prefix-inspected")
        self.assertEqual(result["prefixBytes"], len(body))
        self.assertIsNone(result["fullFileSha256"])
        self.assertFalse(result["fullArchiveDownloaded"])
        self.assertFalse(result["publisherMd5Verified"])
        self.assertEqual(fake._read_count, 1)


if __name__ == "__main__":
    unittest.main()

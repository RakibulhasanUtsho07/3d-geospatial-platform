import hashlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "inspect_tum_citygml_candidate.py"
SPEC = importlib.util.spec_from_file_location("inspect_tum_citygml_candidate", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class FakeResponse:
    def __init__(self, body, status=200, headers=None, final_url="https://example.test/response"):
        self.body = body
        self.status = status
        self.headers = headers or {}
        self.final_url = final_url
        self.offset = 0
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
        if size < 0:
            raise AssertionError("unbounded read is forbidden")
        self.read_calls.append(size)
        part = self.body[self.offset:self.offset + size]
        self.offset += len(part)
        return part


def citygml_fixture():
    return b'''<?xml version="1.0" encoding="UTF-8"?>
<core:CityModel xmlns:core="http://www.opengis.net/citygml/2.0"
 xmlns:gml="http://www.opengis.net/gml" xmlns:bldg="http://www.opengis.net/citygml/building/2.0"
 gml:id="DEBY_LOD3_4959323" srsName="urn:ogc:def:crs:EPSG::25832">
 <gml:boundedBy><gml:Envelope srsName="urn:ogc:def:crs:EPSG::25832" srsDimension="3">
  <gml:lowerCorner>100 200 10</gml:lowerCorner>
  <gml:upperCorner>120 220 30</gml:upperCorner>
 </gml:Envelope></gml:boundedBy>
 <core:cityObjectMember><bldg:Building gml:id="DEBY_LOD2_4959323">
  <bldg:boundedBy><bldg:WallSurface gml:id="wall-1">
   <bldg:lod3MultiSurface><gml:MultiSurface><gml:surfaceMember><gml:Polygon gml:id="wall-poly">
    <gml:exterior><gml:LinearRing><gml:posList srsDimension="3">100 200 10 120 200 10 120 200 30 100 200 30 100 200 10</gml:posList></gml:LinearRing></gml:exterior>
   </gml:Polygon></gml:surfaceMember></gml:MultiSurface></bldg:lod3MultiSurface>
  </bldg:WallSurface></bldg:boundedBy>
  <bldg:lod3Door><bldg:Door gml:id="door-1"/></bldg:lod3Door>
  <bldg:lod3Window><bldg:Window gml:id="window-1"/></bldg:lod3Window>
 </bldg:Building></core:cityObjectMember>
</core:CityModel>'''


class TestCityGMLGeometryParser(unittest.TestCase):
    def test_extracts_full_xml_geometry_bounds_ids_and_crs(self):
        report = MODULE.parse_full_citygml(citygml_fixture())
        self.assertEqual(report["status"], "geometry-extracted")
        self.assertTrue(report["fullXmlDocumentValidated"])
        self.assertTrue(report["fullGeometryPayloadParsed"])
        self.assertEqual(report["root"]["gmlId"], "DEBY_LOD3_4959323")
        self.assertIn("DEBY_LOD2_4959323", report["buildingGmlIds"])
        self.assertIn("urn:ogc:def:crs:EPSG::25832", report["srsNamesObserved"])
        self.assertEqual(report["coordinateTupleCount"], 5)
        self.assertEqual(report["coordinateBounds"], {
            "minX": 100.0, "minY": 200.0, "minZ": 10.0,
            "maxX": 120.0, "maxY": 200.0, "maxZ": 30.0,
        })
        self.assertEqual(report["geometryCounts"]["Polygon"], 1)
        self.assertEqual(report["geometryCounts"]["WallSurface"], 1)
        self.assertEqual(report["geometryCounts"]["Door"], 1)
        self.assertEqual(report["geometryCounts"]["Window"], 1)

    def test_malformed_xml_does_not_claim_full_validation(self):
        report = MODULE.parse_full_citygml(b"<CityModel><posList>1 2 3</CityModel>")
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["reason"], "malformed-xml-document")
        self.assertFalse(report["fullXmlDocumentValidated"])

    def test_coordinate_data_without_triples_is_blocked(self):
        report = MODULE.parse_full_citygml(b"<CityModel><posList srsDimension='3'>1 2</posList></CityModel>")
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["reason"], "no-3d-coordinate-tuples-found")


class TestVerifiedLfsDownload(unittest.TestCase):
    def _run_mock_download(self, payload, status=200, declared_size=None, pointer_oid=None):
        oid = hashlib.sha256(payload).hexdigest()
        expected_size = len(payload)
        pointer_oid = pointer_oid or oid
        pointer_bytes = (
            "version https://git-lfs.github.com/spec/v1\n"
            + "oid sha256:" + oid + "\n"
            + "size " + str(expected_size) + "\n"
        ).encode()
        routes = []

        def opener(request, timeout=30):
            url = request.full_url
            method = request.get_method()
            routes.append((url, method))
            if "/repository/blobs/" in url:
                return FakeResponse(pointer_bytes, status=200, headers={"Content-Length": str(len(pointer_bytes))})
            if url.endswith("/info/lfs/objects/batch") and method == "POST":
                body = json.loads(request.data.decode("utf-8"))
                self.assertEqual(body["objects"][0]["oid"], oid)
                self.assertEqual(body["objects"][0]["size"], expected_size)
                response_body = json.dumps({"objects": [{
                    "oid": oid, "size": expected_size,
                    "actions": {"download": {"href": "https://storage.example.test/payload", "header": {}}},
                }]}).encode()
                return FakeResponse(response_body, status=200, headers={"Content-Length": str(len(response_body))})
            if url == "https://storage.example.test/payload":
                size_header = expected_size if declared_size is None else declared_size
                return FakeResponse(payload, status=status, headers={"Content-Length": str(size_header)})
            raise AssertionError("Unexpected request: " + url)

        result = MODULE.download_verified_lfs_object(
            "a" * 40, pointer_oid, expected_size, opener=opener, max_bytes=max(expected_size + 1, 1024)
        )
        return result, routes

    def test_valid_lfs_payload_requires_pointer_batch_and_whole_hash(self):
        payload = citygml_fixture()
        result, routes = self._run_mock_download(payload)
        self.assertEqual(result["status"], "verified")
        self.assertEqual(result["actualBytes"], len(payload))
        self.assertEqual(result["actualSha256"], hashlib.sha256(payload).hexdigest())
        self.assertEqual(result["payload"], payload)
        self.assertEqual(len(routes), 3)

    def test_http_206_is_not_accepted_as_a_complete_object(self):
        result, _routes = self._run_mock_download(citygml_fixture(), status=206)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["reason"], "lfs-full-object-http-status")

    def test_declared_size_mismatch_is_rejected_before_body_read(self):
        result, _routes = self._run_mock_download(citygml_fixture(), declared_size=1)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["reason"], "lfs-content-length-mismatch")

    def test_expected_payload_hash_mismatch_is_blocked(self):
        payload = citygml_fixture()
        result, _routes = self._run_mock_download(payload, pointer_oid="0" * 64)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["reason"], "lfs-pointer-does-not-match-pinned-catalog")

    def test_size_over_cap_is_rejected_without_requests(self):
        result = MODULE.download_verified_lfs_object(
            "a" * 40, "a" * 64, MODULE.MAX_FULL_OBJECT_BYTES + 1,
            opener=lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("should not call network")),
        )
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["reason"], "expected-object-size-outside-download-cap")


class TestPinnedCandidateReportContract(unittest.TestCase):
    def test_candidate_constants_point_to_single_traceable_catalog_object(self):
        self.assertEqual(MODULE.CANDIDATE_FILENAME, "DEBY_LOD3_4959323.gml")
        self.assertEqual(MODULE.CANDIDATE_BYTES, 51178520)
        self.assertEqual(len(MODULE.CANDIDATE_LFS_SHA256), 64)
        self.assertEqual(len(MODULE.CANDIDATE_BLOB_SHA), 40)



class TestPinnedCandidateLoader(unittest.TestCase):
    def test_requires_snapshot_and_matching_screening_hash_pins(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            files = [{"filename": f"other-{n}.gml", "path": f"{MODULE.CATALOG_PATH}/other-{n}.gml", "repositoryBlobId": "b" * 40} for n in range(26)]
            files.append({
                "filename": MODULE.CANDIDATE_FILENAME,
                "path": f"{MODULE.CATALOG_PATH}/{MODULE.CANDIDATE_FILENAME}",
                "repositoryBlobId": MODULE.CANDIDATE_BLOB_SHA,
            })
            snapshot = {
                "source": {"resolvedCommitSha": MODULE.SOURCE_COMMIT},
                "inventory": {"files": files},
            }
            models = [{"filename": f"other-{n}.gml"} for n in range(26)]
            models.append({
                "filename": MODULE.CANDIDATE_FILENAME,
                "repositoryBlobId": MODULE.CANDIDATE_BLOB_SHA,
                "lfsDeclaredSha256": MODULE.CANDIDATE_LFS_SHA256,
                "lfsDeclaredBytes": MODULE.CANDIDATE_BYTES,
                "prefixSha256": "c" * 64,
                "srsName": "EPSG:25832",
            })
            screening = {"source": {"commit": MODULE.SOURCE_COMMIT}, "models": models}
            snapshot_path = root / "snapshot.json"
            report_path = root / "screening.json"
            snapshot_path.write_text(json.dumps(snapshot), encoding="utf-8")
            report_path.write_text(json.dumps(screening), encoding="utf-8")
            resolved = MODULE.load_candidate_pins(snapshot_path, report_path)
            self.assertEqual(resolved["repositoryBlobId"], MODULE.CANDIDATE_BLOB_SHA)
            self.assertEqual(resolved["lfsDeclaredSha256"], MODULE.CANDIDATE_LFS_SHA256)
            self.assertEqual(resolved["lfsDeclaredBytes"], MODULE.CANDIDATE_BYTES)

    def test_rejects_screening_report_with_wrong_source_commit(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            files = [{"filename": f"other-{n}.gml", "path": f"{MODULE.CATALOG_PATH}/other-{n}.gml", "repositoryBlobId": "b" * 40} for n in range(26)]
            files.append({
                "filename": MODULE.CANDIDATE_FILENAME,
                "path": f"{MODULE.CATALOG_PATH}/{MODULE.CANDIDATE_FILENAME}",
                "repositoryBlobId": MODULE.CANDIDATE_BLOB_SHA,
            })
            snapshot_path = root / "snapshot.json"
            report_path = root / "screening.json"
            snapshot_path.write_text(json.dumps({"source": {"resolvedCommitSha": MODULE.SOURCE_COMMIT}, "inventory": {"files": files}}), encoding="utf-8")
            report_path.write_text(json.dumps({"source": {"commit": "0" * 40}, "models": []}), encoding="utf-8")
            with self.assertRaises(ValueError):
                MODULE.load_candidate_pins(snapshot_path, report_path)



class TestPersistedCandidateGeometryEvidence(unittest.TestCase):
    def test_persisted_full_source_result_is_hash_pinned_and_remains_fail_closed(self):
        report_path = Path(__file__).resolve().parents[1] / "benchmarks" / "building-reconstruction" / "brf-33-citygml-candidate-geometry.json"
        report = json.loads(report_path.read_text(encoding="utf-8"))
        self.assertEqual(report["status"], "full-object-hash-verified-xml-valid-geometry-extracted")
        self.assertEqual(report["source"]["commit"], MODULE.SOURCE_COMMIT)
        self.assertEqual(report["source"]["path"], f"{MODULE.CATALOG_PATH}/{MODULE.CANDIDATE_FILENAME}")
        self.assertEqual(report["source"]["lfsExpectedBytes"], MODULE.CANDIDATE_BYTES)
        self.assertEqual(report["source"]["lfsExpectedSha256"], MODULE.CANDIDATE_LFS_SHA256)
        self.assertEqual(report["byteVerification"]["actualBytes"], MODULE.CANDIDATE_BYTES)
        self.assertEqual(report["byteVerification"]["actualSha256"], MODULE.CANDIDATE_LFS_SHA256)
        self.assertTrue(report["geometry"]["fullXmlDocumentValidated"])
        self.assertTrue(report["geometry"]["fullGeometryPayloadParsed"])
        self.assertEqual(report["geometry"]["coordinateTupleCount3D"], 389813)
        self.assertEqual(report["geometry"]["coordinateTextErrors"], 0)
        self.assertEqual(report["geometry"]["srsNamesObserved"], ["EPSG:25832"])
        self.assertEqual(report["geometry"]["buildingGmlIds"], ["DEBY_LOD2_4959323"])
        self.assertEqual(report["geometry"]["geometryCounts"]["Polygon"], 62576)
        self.assertEqual(report["geometry"]["geometryCounts"]["LinearRing"], 63160)
        self.assertEqual(report["candidateStatus"], "inspection-only-not-selected")
        self.assertFalse(report["sameBuildingVerified"])
        self.assertFalse(report["platformGeneratedCandidateGlbExists"])
        self.assertFalse(report["independentHeldOutCheckpointsExist"])
        self.assertEqual(report["releaseFlags"], {
            "acceptanceEligible": False,
            "publicationEligible": False,
            "mapReady": False,
            "automaticApproval": False,
        })
        self.assertRegex(report["evidence"]["originalArtifactReportSha256"], r"^[0-9a-f]{64}$")

if __name__ == "__main__":
    unittest.main()

import importlib.util
import json
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "inspect_tum_lod3_catalog.py"
SPEC = importlib.util.spec_from_file_location("inspect_tum_lod3_catalog", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def response_json(value, headers=None):
    return 200, headers or {}, json.dumps(value).encode("utf-8")


class TestTumLod3CatalogInventory(unittest.TestCase):
    def test_pins_commit_paginates_and_only_lists_model_paths(self):
        calls = []

        def fake_fetch(url):
            calls.append(url)
            if "/repository/branches/main" in url:
                return response_json({"commit": {
                    "id": "a" * 40, "short_id": "a" * 8, "committed_date": "2026-10-01T00:00:00Z"
                }})
            if "/repository/tree?" in url:
                query = parse_qs(urlparse(url).query)
                self.assertEqual(query["ref"], ["a" * 40])
                self.assertEqual(query["recursive"], ["true"])
                if query["page"] == ["1"]:
                    return response_json([
                        {"type": "blob", "path": "citygml/lod3-building-datasets/DEBY_LOD3_123.gml", "id": "blob1"},
                        {"type": "tree", "path": "citygml/lod3-building-datasets/subfolder", "id": "tree1"},
                        {"type": "blob", "path": "outside/not-in-scope.gml", "id": "blob2"},
                    ], {"X-Next-Page": "2"})
                return response_json([
                    {"type": "blob", "path": "citygml/lod3-building-datasets/nested/reference.xml", "id": "blob3"},
                ], {"X-Next-Page": ""})
            if "/repository/files/LICENSE/raw" in url:
                return 200, {}, b"CC BY 4.0\nExample license text\n"
            raise AssertionError("Unexpected URL: " + url)

        report = MODULE.inspect_catalog(fake_fetch)
        self.assertEqual(report["status"], "catalog-inventoried-pending-file-review")
        self.assertEqual(report["project"]["resolvedCommitSha"], "a" * 40)
        self.assertEqual(report["pagination"]["pagesRead"], 2)
        self.assertEqual(report["inventory"]["gmlCityGmlFiles"], 1)
        self.assertEqual(report["inventory"]["otherXmlFiles"], 1)
        self.assertEqual(len(report["inventory"]["files"]), 2)
        self.assertTrue(all(not item["payloadDownloaded"] for item in report["inventory"]["files"]))
        self.assertEqual(report["licenseFileEvidence"]["firstLines"][0], "CC BY 4.0")
        self.assertEqual(report["buildingSelection"]["status"], "not-selected")
        self.assertFalse(report["releaseFlags"]["mapReady"])
        self.assertFalse(report["modelPayloadsDownloaded"])

    def test_branch_lookup_failure_fails_closed(self):
        report = MODULE.inspect_catalog(lambda _url: (404, {}, b"not found"))
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["reason"], "gitlab-branch-lookup-failed")
        self.assertFalse(report["releaseFlags"]["publicationEligible"])

    def test_invalid_commit_id_fails_closed(self):
        report = MODULE.inspect_catalog(
            lambda url: response_json({"commit": {"id": "NOT-A-COMMIT"}})
        )
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["reason"], "gitlab-commit-sha-invalid")

    def test_tree_api_error_records_failed_page_and_does_not_select_building(self):
        def fake_fetch(url):
            if "/repository/branches/main" in url:
                return response_json({"commit": {"id": "b" * 40}})
            if "/repository/tree?" in url:
                return 503, {}, b"maintenance"
            raise AssertionError("Unexpected URL: " + url)
        report = MODULE.inspect_catalog(fake_fetch)
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["reason"], "gitlab-tree-query-failed")
        self.assertEqual(report["failedPage"], "1")
        self.assertEqual(report["buildingSelection"]["status"], "not-selected")
        self.assertFalse(report["releaseFlags"]["acceptanceEligible"])


class TestPinnedCatalogSnapshot(unittest.TestCase):
    def test_snapshot_is_exact_revision_and_stays_fail_closed(self):
        snapshot_path = Path(__file__).resolve().parents[1] / "benchmarks" / "building-reconstruction" / "brf-30-tum-lod3-catalog-snapshot.json"
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
        self.assertEqual(snapshot["schemaVersion"], "1.0.0")
        self.assertEqual(snapshot["source"]["resolvedCommitSha"], "e032a71fc9b3c9c3d4869e3aca9677d1234086aa")
        self.assertEqual(snapshot["source"]["licenseFileSha256"], "9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411")
        self.assertEqual(snapshot["inventory"]["gmlFileCount"], 27)
        self.assertEqual(snapshot["inventory"]["filenamePrefixCounts"], {"DEBY": 27})
        files = snapshot["inventory"]["files"]
        self.assertEqual(len(files), 27)
        self.assertEqual(len({item["path"] for item in files}), 27)
        self.assertTrue(all(item["payloadDownloaded"] is False for item in files))
        self.assertTrue(all(item["buildingIdentityVerified"] is False for item in files))
        self.assertTrue(all(item["assetRightsReviewed"] is False for item in files))
        self.assertEqual(snapshot["buildingSelection"]["status"], "not-selected")
        self.assertFalse(any(snapshot["releaseFlags"].values()))


if __name__ == "__main__":
    unittest.main()

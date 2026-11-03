import hashlib, importlib.util, json, struct, unittest
from pathlib import Path

MODULE_PATH=Path(__file__).resolve().parents[1]/"scripts"/"convert_citygml_to_reference_glb.py"
SPEC=importlib.util.spec_from_file_location("citygml_glb",MODULE_PATH)
MODULE=importlib.util.module_from_spec(SPEC); assert SPEC and SPEC.loader; SPEC.loader.exec_module(MODULE)
COMMIT="e032a71fc9b3c9c3d4869e3aca9677d1234086aa"; SOURCE_PATH="citygml/lod3-building-datasets/fixture.gml"

def fixture(exterior="0 0 0  4 0 0  4 4 0  0 4 0  0 0 0",interior=None,dimension="3",crs="EPSG:25832"):
    hole="" if interior is None else f"<gml:interior><gml:LinearRing><gml:posList srsDimension='{dimension}'>{interior}</gml:posList></gml:LinearRing></gml:interior>"
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<core:CityModel xmlns:core="http://www.opengis.net/citygml/2.0" xmlns:gml="http://www.opengis.net/gml" xmlns:bldg="http://www.opengis.net/citygml/building/2.0">
 <core:cityObjectMember><bldg:Building gml:id="building-fixture" srsName="{crs}">
  <gml:Polygon gml:id="polygon-fixture" srsName="{crs}">
   <gml:exterior><gml:LinearRing><gml:posList srsDimension="{dimension}">{exterior}</gml:posList></gml:LinearRing></gml:exterior>
   {hole}
  </gml:Polygon>
 </bldg:Building></core:cityObjectMember></core:CityModel>""".encode()

def convert(payload,**overrides):
    args={"source_commit":COMMIT,"source_path":SOURCE_PATH,"expected_sha256":hashlib.sha256(payload).hexdigest(),
      "expected_bytes":len(payload),"source_crs":"EPSG:25832","rights_review_status":"pending-exact-file-scope-review","local_review_only":True}
    args.update(overrides); return MODULE.build_reference_glb(payload,**args)

def read_doc(glb):
    magic,version,total=struct.unpack_from("<III",glb,0)
    assert magic==MODULE.GLB_MAGIC and version==2 and total==len(glb)
    jlen,jtype=struct.unpack_from("<II",glb,12)
    assert jtype==MODULE.JSON_CHUNK
    return json.loads(glb[20:20+jlen].decode("utf-8").strip())

class TestCityGmlReferenceGlb(unittest.TestCase):
    def test_exports_self_contained_glb_with_explicit_origin_and_fail_closed_metadata(self):
        payload=fixture(); glb,report=convert(payload); doc=read_doc(glb); extra=doc["asset"]["extras"]
        self.assertEqual(report["status"],"reference-glb-built-local-review-only")
        self.assertEqual(report["output"]["polygonCount"],1); self.assertEqual(report["output"]["triangles"],2)
        self.assertEqual(report["output"]["vertexCount"],6); self.assertEqual(report["output"]["coordinateTupleCount"],5)
        self.assertNotIn("uri",doc["buffers"][0]); self.assertEqual(doc["meshes"][0]["primitives"][0]["mode"],4)
        self.assertEqual(extra["sourceCrs"],"EPSG:25832"); self.assertEqual(extra["glbOriginSourceCoordinates"],[2,2,0])
        self.assertEqual(extra["outputClassification"],"source-reference-geometry-not-platform-reconstruction")
        self.assertFalse(extra["sameBuildingVerified"]); self.assertFalse(extra["platformGeneratedCandidateGlbExists"])
        self.assertFalse(any(extra["releaseFlags"].values()))
        self.assertEqual(report["output"]["localBounds"]["min"],[-2.0,0.0,-2.0])
        self.assertEqual(report["output"]["localBounds"]["max"],[2.0,0.0,2.0])

    def test_rights_pending_blocks_by_default_private_review_requires_explicit_flag(self):
        payload=fixture()
        with self.assertRaisesRegex(MODULE.ConversionError,"local_review_only"):
            convert(payload,local_review_only=False)
        with self.assertRaisesRegex(MODULE.ConversionError,"rejected"):
            convert(payload,rights_review_status="rejected")
        glb,report=convert(payload,rights_review_status="approved",local_review_only=False,rights_evidence_url="https://example.test/rights-evidence",attribution_text="Fixture attribution",rights_reviewed_by="reviewer-fixture")
        self.assertTrue(glb.startswith(b"glTF")); self.assertEqual(report["status"],"reference-glb-built-review-required")
        self.assertFalse(any(report["releaseFlags"].values()))
        self.assertEqual(report["rightsEvidenceUrl"],"https://example.test/rights-evidence")
        self.assertEqual(report["requiredAttribution"],"Fixture attribution")
        self.assertEqual(report["rightsReviewedBy"],"reviewer-fixture")
        with self.assertRaisesRegex(MODULE.ConversionError,"approved rights require an HTTPS rights_evidence_url"):
            convert(payload,rights_review_status="approved",local_review_only=False,attribution_text="fixture",rights_reviewed_by="reviewer")

    def test_rejects_hash_size_commit_crs_and_path_mismatches(self):
        payload=fixture()
        with self.assertRaisesRegex(MODULE.ConversionError,"SHA-256"): convert(payload,expected_sha256="0"*64)
        with self.assertRaisesRegex(MODULE.ConversionError,"byte count"): convert(payload,expected_bytes=len(payload)+1)
        with self.assertRaisesRegex(MODULE.ConversionError,"immutable Git commit"): convert(payload,source_commit="main")
        with self.assertRaisesRegex(MODULE.ConversionError,"EPSG:25832"): convert(payload,source_crs="EPSG:32632")
        with self.assertRaisesRegex(MODULE.ConversionError,"repository-relative"): convert(payload,source_path="../outside.gml")

    def test_holes_malformed_xml_wrong_dimension_and_dtd_are_blocked(self):
        hole=fixture(interior="1 1 0  1 2 0  2 2 0  2 1 0  1 1 0")
        with self.assertRaisesRegex(MODULE.ConversionError,"holes are unsupported"): convert(hole)
        malformed=b"<CityModel><Polygon></CityModel>"
        with self.assertRaisesRegex(MODULE.ConversionError,"malformed or incomplete"):
            convert(malformed)
        wrong2d=fixture(exterior="0 0  4 0  4 4  0 4  0 0",dimension="2")
        with self.assertRaisesRegex(MODULE.ConversionError,"3D coordinates"): convert(wrong2d)
        with self.assertRaisesRegex(MODULE.ConversionError,"DTD/entity"):
            convert(b'<!DOCTYPE x [<!ENTITY boom "boom">]><CityModel/>')

    def test_nonplanar_and_bowtie_polygons_are_rejected(self):
        nonplanar=fixture(exterior="0 0 0  4 0 0  4 4 1  0 4 0  0 0 0")
        with self.assertRaisesRegex(MODULE.ConversionError,"non-planar"): convert(nonplanar)
        bowtie=fixture(exterior="0 0 0  4 4 0  4 0 0  0 4 0  0 0 0")
        with self.assertRaises(MODULE.ConversionError): convert(bowtie)

if __name__=="__main__": unittest.main()

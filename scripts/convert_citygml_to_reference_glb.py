#!/usr/bin/env python3
"""Create a local review-only GLB from a pinned CityGML source model."""
from __future__ import annotations
import argparse, hashlib, io, json, math, re, struct, sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

GLB_MAGIC=0x46546C67; JSON_CHUNK=0x4E4F534A; BIN_CHUNK=0x004E4942
MAX_INPUT_BYTES=64*1024*1024; MAX_OUTPUT_BYTES=128*1024*1024; MAX_TRIANGLES=2_000_000
PLANAR_TOLERANCE_M=0.02; EPSILON=1e-10
SHA256=re.compile(r"^[0-9a-f]{64}$"); COMMIT=re.compile(r"^[0-9a-f]{40}$")
FLOAT=re.compile(r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?")

class ConversionError(ValueError):
    """A source model cannot safely be represented by this adapter."""

def local_name(value: str) -> str:
    return value.rsplit("}",1)[-1].split(":",1)[-1]

def attr_local(element: ET.Element, wanted: str) -> str | None:
    for key,value in element.attrib.items():
        if local_name(key)==wanted: return value
    return None

def parse_coordinate_text(text: str | None, dimension: int, label: str) -> list[tuple[float,float,float]]:
    if not text or not text.strip(): raise ConversionError(label+" contains no coordinate text")
    tokens=text.replace(","," ").split()
    if dimension != 3: raise ConversionError(label+" must explicitly declare 3D coordinates; 2D/4D conversion is unsupported")
    if len(tokens)%3: raise ConversionError(label+" coordinate token count is not divisible by srsDimension")
    out=[]
    for i in range(0,len(tokens),3):
        if any(not FLOAT.fullmatch(t) for t in tokens[i:i+3]): raise ConversionError(label+" contains malformed coordinate tokens")
        p=tuple(float(t) for t in tokens[i:i+3])
        if any(not math.isfinite(v) for v in p): raise ConversionError(label+" contains a non-finite coordinate")
        out.append(p)
    return out

def dimension_for(element: ET.Element, stack_elements: list[ET.Element]) -> int:
    raw=attr_local(element,"srsDimension")
    if raw:
        try: return int(raw)
        except ValueError as exc: raise ConversionError("invalid srsDimension declaration") from exc
    for ancestor in reversed(stack_elements[:-1]):
        raw=attr_local(ancestor,"srsDimension")
        if raw:
            try: return int(raw)
            except ValueError as exc: raise ConversionError("invalid ancestor srsDimension") from exc
    return 3

def clean_ring(points: list[tuple[float,float,float]]) -> list[tuple[float,float,float]]:
    out=[]
    for p in points:
        if not out or math.dist(out[-1],p)>1e-8: out.append(p)
    if len(out)>1 and math.dist(out[0],out[-1])<=1e-8: out.pop()
    if len(out)<3: raise ConversionError("polygon exterior ring has fewer than three distinct vertices")
    return out

def cross3(a,b,c):
    u=[b[i]-a[i] for i in range(3)]; v=[c[i]-a[i] for i in range(3)]
    return (u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0])

def newell_normal(points):
    nx=ny=nz=0.0
    for a,b in zip(points,points[1:]+points[:1]):
        nx+=(a[1]-b[1])*(a[2]+b[2]); ny+=(a[2]-b[2])*(a[0]+b[0]); nz+=(a[0]-b[0])*(a[1]+b[1])
    length=math.sqrt(nx*nx+ny*ny+nz*nz)
    if not math.isfinite(length) or length<=EPSILON: raise ConversionError("polygon exterior ring has degenerate area")
    return (nx/length,ny/length,nz/length)

def cross2(a,b,c): return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])

def point_in_triangle(p,a,b,c):
    e=1e-9
    return cross2(a,b,p)>=-e and cross2(b,c,p)>=-e and cross2(c,a,p)>=-e

def triangulate_polygon(raw_points):
    points=clean_ring(raw_points); normal=newell_normal(points); origin=points[0]
    for p in points:
        if abs(sum((p[i]-origin[i])*normal[i] for i in range(3)))>PLANAR_TOLERANCE_M:
            raise ConversionError("non-planar polygon exceeds the 2 cm tolerance")
    drop=max(range(3),key=lambda i:abs(normal[i]))
    projected=[(p[1],p[2]) if drop==0 else (p[0],p[2]) if drop==1 else (p[0],p[1]) for p in points]
    order=list(range(len(points))); changed=True
    while changed and len(order)>3:
        changed=False
        for i in range(len(order)):
            a,b,c=order[i-1],order[i],order[(i+1)%len(order)]
            if abs(cross2(projected[a],projected[b],projected[c]))<=1e-10:
                order.pop(i); changed=True; break
    if len(order)<3: raise ConversionError("polygon collapses after duplicate/collinear-corner removal")
    area2=sum(projected[order[i]][0]*projected[order[(i+1)%len(order)]][1]-projected[order[(i+1)%len(order)]][0]*projected[order[i]][1] for i in range(len(order)))
    if abs(area2)<=EPSILON: raise ConversionError("polygon projected area is zero")
    if area2<0: order.reverse()
    tris=[]; guard=0; limit=len(order)*len(order)
    while len(order)>3 and guard<limit:
        guard+=1; clipped=False
        for i in range(len(order)):
            a,b,c=order[i-1],order[i],order[(i+1)%len(order)]
            if cross2(projected[a],projected[b],projected[c])<=1e-10: continue
            if any(k not in (a,b,c) and point_in_triangle(projected[k],projected[a],projected[b],projected[c]) for k in order): continue
            tris.append((a,b,c)); order.pop(i); clipped=True; break
        if not clipped: raise ConversionError("polygon could not be triangulated; check self-intersections")
    if len(order)!=3: raise ConversionError("polygon triangulation did not terminate")
    tris.append(tuple(order)); fixed=[]
    for a,b,c in tris:
        n=cross3(points[a],points[b],points[c])
        fixed.append((a,c,b) if sum(n[i]*normal[i] for i in range(3))<0 else (a,b,c))
    return points,fixed

def epsg_codes(values):
    found=set()
    for value in values:
        match=re.search(r"(?i)(?:EPSG(?::|/|::)|::)(\d{4,6})(?!\d)",value)
        if not match: match=re.search(r"(?i)\bEPSG\s*(\d{4,6})\b",value)
        if match: found.add("EPSG:"+match.group(1))
    return found

def parse_payload(payload: bytes, origin=None, build=False):
    if len(payload)>MAX_INPUT_BYTES: raise ConversionError("CityGML exceeds 64 MiB input ceiling")
    if re.search(rb"<!\s*(?:DOCTYPE|ENTITY)\b",payload,re.I): raise ConversionError("DTD/entity declarations are blocked")
    mins=[math.inf]*3; maxs=[-math.inf]*3; srs=[]; polygon_count=ring_count=coord_count=tri_count=0
    pos_data=bytearray(); norm_data=bytearray(); out_min=[math.inf]*3; out_max=[-math.inf]*3
    stack_tags=[]; stack_elements=[]; polygon=None; ring=None; root=None; building_ids=[]
    try:
        for event,el in ET.iterparse(io.BytesIO(payload),events=("start","end")):
            tag=local_name(el.tag)
            if event=="start":
                stack_tags.append(tag); stack_elements.append(el)
                if root is None: root={"element":tag,"gmlId":attr_local(el,"id")}
                sr=attr_local(el,"srsName")
                if sr and sr not in srs and len(srs)<40: srs.append(sr)
                gid=attr_local(el,"id")
                if gid and tag in {"Building","BuildingPart"} and gid not in building_ids:
                    building_ids.append(gid)
                    if len(building_ids)>100: raise ConversionError("building ID inventory exceeds 100 IDs")
                if tag=="Polygon":
                    if polygon is not None: raise ConversionError("nested GML Polygon elements are unsupported")
                    polygon={"rings":[],"gmlId":gid}
                elif tag=="LinearRing" and polygon is not None:
                    ancestors=stack_tags[:-1]
                    ring={"points":[],"exterior":"exterior" in ancestors and "interior" not in ancestors}
            else:
                if tag in {"posList","pos"} and polygon is not None and ring is not None:
                    dim=dimension_for(el,stack_elements)
                    coords=parse_coordinate_text(el.text,dim,tag); ring["points"].extend(coords)
                    for p in coords:
                        coord_count+=1
                        for i in range(3): mins[i]=min(mins[i],p[i]); maxs[i]=max(maxs[i],p[i])
                elif tag=="LinearRing" and polygon is not None and ring is not None:
                    polygon["rings"].append({"points":clean_ring(ring["points"]),"exterior":ring["exterior"]})
                    ring_count+=1; ring=None
                elif tag=="Polygon" and polygon is not None:
                    exteriors=[r for r in polygon["rings"] if r["exterior"]]
                    interiors=[r for r in polygon["rings"] if not r["exterior"]]
                    if len(exteriors)!=1: raise ConversionError("each Polygon must have exactly one exterior LinearRing")
                    if interiors: raise ConversionError("polygon interior rings/holes are unsupported; conversion is blocked rather than filling holes")
                    pts=exteriors[0]["points"]
                    if build:
                        pts,tris=triangulate_polygon(pts)
                        for p in pts:
                            transformed=(p[0]-origin[0],p[2]-origin[2],-(p[1]-origin[1]))
                            for i in range(3): out_min[i]=min(out_min[i],transformed[i]); out_max[i]=max(out_max[i],transformed[i])
                        for a,b,c in tris:
                            triangle=[(pts[i][0]-origin[0],pts[i][2]-origin[2],-(pts[i][1]-origin[1])) for i in (a,b,c)]
                            n=cross3(*triangle); length=math.sqrt(sum(v*v for v in n))
                            if not math.isfinite(length) or length<=EPSILON: raise ConversionError("triangulation produced a degenerate triangle")
                            n=tuple(v/length for v in n)
                            for v in triangle:
                                pos_data.extend(struct.pack("<3f",*v)); norm_data.extend(struct.pack("<3f",*n))
                            tri_count+=1
                            if tri_count>MAX_TRIANGLES: raise ConversionError("triangle count exceeds 2,000,000 safety cap")
                    else:
                        triangulate_polygon(pts)
                    polygon_count+=1; polygon=None
                el.clear()
                stack_tags.pop(); stack_elements.pop()
    except ET.ParseError as exc:
        raise ConversionError("CityGML XML is malformed or incomplete") from exc
    if polygon is not None or ring is not None: raise ConversionError("CityGML ended before a Polygon/LinearRing was complete")
    if polygon_count<1 or ring_count<1 or coord_count<3 or not math.isfinite(mins[0]): raise ConversionError("CityGML has no supported 3D polygon geometry")
    return {
        "root":root,"buildingGmlIds":building_ids,"srsNamesObserved":srs,
        "coordinateTupleCount":coord_count,"polygonCount":polygon_count,"linearRingCount":ring_count,"triangles":tri_count,
        "sourceBounds":{"minX":mins[0],"minY":mins[1],"minZ":mins[2],"maxX":maxs[0],"maxY":maxs[1],"maxZ":maxs[2]},
        "outputBounds":{"min":out_min,"max":out_max} if build else None,
        "positionBytes":pos_data,"normalBytes":norm_data
    }

def pack_glb(gltf,binary):
    j=json.dumps(gltf,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode("utf-8")
    j+=b" "*((4-len(j)%4)%4); binary+=b"\x00"*((4-len(binary)%4)%4)
    total=12+8+len(j)+8+len(binary)
    if total>MAX_OUTPUT_BYTES: raise ConversionError("generated GLB exceeds 128 MiB output ceiling")
    return struct.pack("<III",GLB_MAGIC,2,total)+struct.pack("<II",len(j),JSON_CHUNK)+j+struct.pack("<II",len(binary),BIN_CHUNK)+binary

def build_reference_glb(payload: bytes, *, source_commit: str, source_path: str, expected_sha256: str,
                        expected_bytes: int, source_crs: str, rights_review_status="pending-exact-file-scope-review",
                        local_review_only=False, rights_evidence_url=None, attribution_text=None, rights_reviewed_by=None):
    if not COMMIT.fullmatch(source_commit): raise ConversionError("source_commit must be a 40-character immutable Git commit SHA")
    if not isinstance(source_path,str) or not source_path.strip() or source_path.startswith("/") or "\\" in source_path or ".." in Path(source_path).parts:
        raise ConversionError("source_path must be a normalized repository-relative path")
    if source_crs!="EPSG:25832": raise ConversionError("only the pinned EPSG:25832 source frame is supported")
    if rights_review_status not in {"pending-exact-file-scope-review","approved","rejected"}: raise ConversionError("invalid rights_review_status")
    if rights_review_status=="rejected": raise ConversionError("source asset rights are rejected; conversion is blocked")
    if rights_review_status!="approved" and not local_review_only: raise ConversionError("exact-file rights are not approved; local_review_only is required for private diagnostics")
    if rights_review_status=="approved":
        if not isinstance(rights_evidence_url,str) or not re.fullmatch(r"https://[^\\s]+",rights_evidence_url):
            raise ConversionError("approved rights require an HTTPS rights_evidence_url")
        if not isinstance(attribution_text,str) or not attribution_text.strip():
            raise ConversionError("approved rights require non-empty attribution_text")
        if not isinstance(rights_reviewed_by,str) or not rights_reviewed_by.strip():
            raise ConversionError("approved rights require a non-empty rights_reviewed_by reviewer reference")
    if not isinstance(expected_bytes,int) or not 1<=expected_bytes<=MAX_INPUT_BYTES: raise ConversionError("expected_bytes is outside input ceiling")
    if not SHA256.fullmatch(expected_sha256): raise ConversionError("expected_sha256 must be a 64-character lowercase SHA-256")
    if len(payload)!=expected_bytes: raise ConversionError("source byte count does not match pinned expected_bytes")
    observed=hashlib.sha256(payload).hexdigest()
    if observed!=expected_sha256: raise ConversionError("source whole-object SHA-256 does not match pinned expected_sha256")
    first=parse_payload(payload,build=False)
    if epsg_codes(first["srsNamesObserved"])!={source_crs}: raise ConversionError("observed CityGML srsName values do not agree with configured source CRS")
    b=first["sourceBounds"]
    origin=((b["minX"]+b["maxX"])/2,(b["minY"]+b["maxY"])/2,b["minZ"])
    geom=parse_payload(payload,origin=origin,build=True)
    if geom["triangles"]<1: raise ConversionError("no triangles were exported")
    pos=geom["positionBytes"]; normals=geom["normalBytes"]; binary=pos+normals
    vertex_count=geom["triangles"]*3
    gltf={
      "asset":{"version":"2.0","generator":"3d-geospatial-platform BRF-34 CityGML reference adapter","extras":{
        "outputClassification":"source-reference-geometry-not-platform-reconstruction","sourceCommit":source_commit,"sourcePath":source_path,
        "sourceSha256":observed,"sourceBytes":len(payload),"sourceCrs":source_crs,"glbOriginSourceCoordinates":list(origin),
        "sourceToGlbAxisMapping":"x'=E-originE; y'=H-originH; z'=-(N-originN); no scale or CRS transform",
        "rightsReviewStatus":rights_review_status,"localReviewOnly":local_review_only,
        "rightsEvidenceUrl":rights_evidence_url if rights_review_status=="approved" else None,
        "requiredAttribution":attribution_text if rights_review_status=="approved" else None,
        "rightsReviewedBy":rights_reviewed_by if rights_review_status=="approved" else None,"sameBuildingVerified":False,
        "platformGeneratedCandidateGlbExists":False,"independentHeldOutCheckpointsExist":False,
        "releaseFlags":{"acceptanceEligible":False,"publicationEligible":False,"mapReady":False,"automaticApproval":False}}},
      "scene":0,"scenes":[{"nodes":[0]}],"nodes":[{"name":"SourceReferenceGeometry","mesh":0}],
      "meshes":[{"name":"CityGML_SourceReference","primitives":[{"attributes":{"POSITION":0,"NORMAL":1},"material":0,"mode":4}]}],
      "materials":[{"name":"Neutral_Source_Surface","doubleSided":True,"pbrMetallicRoughness":{"baseColorFactor":[0.65,0.68,0.72,1],"metallicFactor":0,"roughnessFactor":1}}],
      "accessors":[
        {"bufferView":0,"byteOffset":0,"componentType":5126,"count":vertex_count,"type":"VEC3","min":geom["outputBounds"]["min"],"max":geom["outputBounds"]["max"]},
        {"bufferView":1,"byteOffset":0,"componentType":5126,"count":vertex_count,"type":"VEC3"}],
      "bufferViews":[
        {"buffer":0,"byteOffset":0,"byteLength":len(pos),"target":34962},
        {"buffer":0,"byteOffset":len(pos),"byteLength":len(normals),"target":34962}],
      "buffers":[{"byteLength":len(binary)}]
    }
    glb=pack_glb(gltf,binary)
    report={
      "schemaVersion":"1.0.0","status":"reference-glb-built-local-review-only" if rights_review_status!="approved" else "reference-glb-built-review-required",
      "generatedAt":datetime.now(timezone.utc).isoformat(),
      "source":{"commit":source_commit,"path":source_path,"sha256":observed,"bytes":len(payload),"crs":source_crs},
      "output":{"format":"GLB 2.0","bytes":len(glb),"sha256":hashlib.sha256(glb).hexdigest(),"triangles":geom["triangles"],
        "vertexCount":vertex_count,"coordinateTupleCount":geom["coordinateTupleCount"],"polygonCount":geom["polygonCount"],
        "linearRingCount":geom["linearRingCount"],"sourceBounds":b,"localBounds":geom["outputBounds"],"originSourceCoordinates":list(origin)},
      "limitations":["Reference conversion only, not platform reconstruction.","Polygon holes are blocked rather than filled.",
        "Only planar 3D exterior rings within 2 cm tolerance are supported.","No CRS/vertical transform or same-building linkage is inferred.",
        "No source textures or image-derived appearance are generated.","Not for publication until exact-file rights/attribution are reviewed."],
      "rightsReviewStatus":rights_review_status,"localReviewOnly":local_review_only,
      "rightsEvidenceUrl":rights_evidence_url if rights_review_status=="approved" else None,
      "requiredAttribution":attribution_text if rights_review_status=="approved" else None,
      "rightsReviewedBy":rights_reviewed_by if rights_review_status=="approved" else None,
      "sameBuildingVerified":False,
      "platformGeneratedCandidateGlbExists":False,"independentHeldOutCheckpointsExist":False,
      "releaseFlags":{"acceptanceEligible":False,"publicationEligible":False,"mapReady":False,"automaticApproval":False},
      "_glb":glb}
    return glb,report

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_gml"); parser.add_argument("output_glb")
    parser.add_argument("--source-commit",required=True); parser.add_argument("--source-path",required=True)
    parser.add_argument("--expected-sha256",required=True); parser.add_argument("--expected-bytes",type=int,required=True)
    parser.add_argument("--source-crs",default="EPSG:25832"); parser.add_argument("--rights-review-status",default="pending-exact-file-scope-review")
    parser.add_argument("--rights-evidence-url"); parser.add_argument("--attribution-text"); parser.add_argument("--rights-reviewed-by")
    parser.add_argument("--local-review-only",action="store_true"); parser.add_argument("--report-json")
    args=parser.parse_args(); src=Path(args.input_gml); dest=Path(args.output_glb)
    if src.resolve()==dest.resolve(): raise ConversionError("input and output paths must differ")
    if src.is_symlink() or not src.is_file(): raise ConversionError("input must be a regular non-symlink file")
    if dest.exists() or dest.is_symlink(): raise ConversionError("output path must not already exist")
    if src.stat().st_size>MAX_INPUT_BYTES: raise ConversionError("input file exceeds 64 MiB ceiling")
    glb,report=build_reference_glb(src.read_bytes(),source_commit=args.source_commit,source_path=args.source_path,
      expected_sha256=args.expected_sha256,expected_bytes=args.expected_bytes,source_crs=args.source_crs,
      rights_review_status=args.rights_review_status,local_review_only=args.local_review_only,rights_evidence_url=args.rights_evidence_url,
      attribution_text=args.attribution_text,rights_reviewed_by=args.rights_reviewed_by)
    dest.parent.mkdir(parents=True,exist_ok=True)
    with dest.open("xb") as stream: stream.write(glb)
    report_path=Path(args.report_json) if args.report_json else dest.with_suffix(".report.json")
    public={k:v for k,v in report.items() if k!="_glb"}
    with report_path.open("x",encoding="utf-8") as stream: json.dump(public,stream,indent=2,sort_keys=True); stream.write("\n")
    print(json.dumps({"status":public["status"],"sourceSha256":public["source"]["sha256"],"glbBytes":public["output"]["bytes"],
      "glbSha256":public["output"]["sha256"],"triangles":public["output"]["triangles"],"rightsReviewStatus":public["rightsReviewStatus"],
      "localReviewOnly":public["localReviewOnly"],"releaseFlags":public["releaseFlags"]},indent=2))

if __name__=="__main__":
    try: main()
    except (ConversionError,OSError,json.JSONDecodeError,ET.ParseError) as exc:
        print(str(exc),file=sys.stderr); raise SystemExit(2)

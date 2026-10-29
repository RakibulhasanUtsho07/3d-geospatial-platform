"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

import {
  buildFloorPlanRasterReviewPayload,
  canonicalFloorPlanReviewJson,
  validateFloorPlanReviewProposal,
} from "@/core/building-generation/floor-plan-review-payload.mjs";

type PointPx = [number, number];
type Candidate = { id: string; orientation?: string; start: { x: number; y: number }; end: { x: number; y: number }; lengthPx?: number; confidenceScore?: number };
type ProposalReport = {
  schemaVersion: string; engine: string; status: string;
  source: { sha256: string; mimeType: string; byteSize: number };
  raster: { width: number; height: number; originalWidth?: number; originalHeight?: number; pixelUnits: string };
  candidates: Candidate[]; mapReady: false; publicationEligible: false; [key: string]: unknown;
};
type ReviewDecision = "undecided" | "accept-wall" | "reject";
type Opening = { id: string; type: "door" | "window"; offsetPx: number; widthPx: number; heightM: number; sillHeightM: number };
type CandidateReview = {
  proposalId: string; decision: ReviewDecision; wallId: string; startPx: PointPx; endPx: PointPx;
  reason: string; correctionReason: string; heightM: string; thicknessM: string; openings: Opening[];
};
type ReviewedRoom = { id: string; name: string; polygonPx: PointPx[]; reviewed: boolean };
type PickMode = null | "calibrationA" | "calibrationB" | "origin" | "room";
type DragState =
  | { kind: "wall"; id: string; endpoint: "startPx" | "endPx" }
  | { kind: "room"; id: string; index: number }
  | null;

const panel = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";
const field = "mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";
const button = "inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40";
const primaryButton = "inline-flex items-center justify-center rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-40";

function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }
function pointsString(points: PointPx[]) { return points.map((p) => String(p[0]) + "," + String(p[1])).join(" "); }
function num(value: string) { return value.trim() === "" ? Number.NaN : Number(value); }
function safeId(value: string) { return /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value); }
async function digestHex(bytes: ArrayBuffer | Uint8Array) {
  if (!globalThis.crypto?.subtle) throw new Error("SHA-256 requires a secure browser context (HTTPS or localhost).");
  const buffer = bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer : bytes;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export default function FloorPlanReviewPage() {
  const [report, setReport] = useState<ProposalReport | null>(null);
  const [reportHash, setReportHash] = useState("");
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceHash, setSourceHash] = useState("");
  const objectUrlRef = useRef("");
  const sourceCheckTokenRef = useRef(0);
  const [sourceState, setSourceState] = useState<"missing" | "checking" | "matched" | "mismatch" | "error">("missing");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [reviews, setReviews] = useState<Record<string, CandidateReview>>({});
  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  const [rooms, setRooms] = useState<ReviewedRoom[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState("");
  const [pickMode, setPickMode] = useState<PickMode>(null);
  const [dragging, setDragging] = useState<DragState>(null);
  const [pendingRoomPoints, setPendingRoomPoints] = useState<PointPx[]>([]);
  const [roomIdDraft, setRoomIdDraft] = useState("room-1");
  const [roomNameDraft, setRoomNameDraft] = useState("Room 1");
  const [reviewer, setReviewer] = useState("");
  const [notes, setNotes] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [buildingId, setBuildingId] = useState("");
  const [floorPlanId, setFloorPlanId] = useState("");
  const [floorPlanName, setFloorPlanName] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [origin, setOrigin] = useState<PointPx | null>(null);
  const [pointA, setPointA] = useState<PointPx | null>(null);
  const [pointB, setPointB] = useState<PointPx | null>(null);
  const [distanceM, setDistanceM] = useState("");
  const [dimensionEvidence, setDimensionEvidence] = useState("");
  const [longitude, setLongitude] = useState("");
  const [latitude, setLatitude] = useState("");
  const [heightM, setHeightM] = useState("");
  const [headingDegrees, setHeadingDegrees] = useState("");
  const [elevationM, setElevationM] = useState("");
  const [wallHeightM, setWallHeightM] = useState("");
  const [wallThicknessM, setWallThicknessM] = useState("");
  const [floorThicknessM, setFloorThicknessM] = useState("");
  const [topologyToleranceM, setTopologyToleranceM] = useState("0.15");
  const [openingType, setOpeningType] = useState<"door" | "window">("door");
  const [openingOffsetPx, setOpeningOffsetPx] = useState("");
  const [openingWidthPx, setOpeningWidthPx] = useState("");
  const [openingHeightM, setOpeningHeightM] = useState("");
  const [openingSillM, setOpeningSillM] = useState("");

  useEffect(() => {
    const cleanupOnPageHide = () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = "";
      }
    };
    window.addEventListener("pagehide", cleanupOnPageHide);
    return () => window.removeEventListener("pagehide", cleanupOnPageHide);
  }, []);

  const candidates = report?.candidates ?? [];
  const selectedReview = selectedCandidateId ? reviews[selectedCandidateId] : undefined;
  const selectedRoom = rooms.find((room) => room.id === selectedRoomId);
  const acceptedCount = Object.values(reviews).filter((item) => item.decision === "accept-wall").length;
  const rejectedCount = Object.values(reviews).filter((item) => item.decision === "reject").length;
  const undecidedCount = candidates.length - acceptedCount - rejectedCount;
  const reviewedRooms = rooms.filter((room) => room.reviewed).length;
  const stageText = useMemo(() => {
    if (!report) return "Load a proposal report to begin.";
    if (sourceState === "checking") return "Verifying exact source bytes…";
    if (sourceState === "mismatch") return "Source mismatch — review/export is blocked.";
    if (sourceState !== "matched") return "Select the exact raster used to create the report.";
    return "Source bytes match. All review actions remain local to this browser.";
  }, [report, sourceState]);

  async function verifySource(file: File, proposal: ProposalReport) {
    const token = ++sourceCheckTokenRef.current;
    setSourceState("checking");
    setSourceHash("");
    setError("");
    try {
      const hash = await digestHex(await file.arrayBuffer());
      if (token !== sourceCheckTokenRef.current) return;
      setSourceHash(hash);
      const matches = hash === proposal.source.sha256 &&
        file.size === proposal.source.byteSize &&
        file.type.toLowerCase() === proposal.source.mimeType.toLowerCase();
      setSourceState(matches ? "matched" : "mismatch");
      if (!matches) setError("Selected image does not match the recorded source hash, byte size and MIME type. Export is blocked.");
    } catch (cause) {
      if (token !== sourceCheckTokenRef.current) return;
      setSourceState("error");
      setError(cause instanceof Error ? cause.message : "Could not hash source image.");
    }
  }

  async function loadProposal(file?: File) {
    if (!file) return;
    setError(""); setSuccess("");
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("Proposal report must be 10 MiB or smaller.");
      const parsed = JSON.parse(await file.text()) as ProposalReport;
      validateFloorPlanReviewProposal(parsed);
      const proposalHash = await digestHex(new TextEncoder().encode(canonicalFloorPlanReviewJson(parsed)));
      setReport(parsed); setReportHash(proposalHash);
      if (sourceFile) void verifySource(sourceFile, parsed);
      else { sourceCheckTokenRef.current += 1; setSourceHash(""); setSourceState("missing"); }
      const initial: Record<string, CandidateReview> = {};
      parsed.candidates.forEach((candidate, index) => {
        initial[candidate.id] = {
          proposalId: candidate.id, decision: "undecided", wallId: "wall-" + (index + 1),
          startPx: [candidate.start.x, candidate.start.y], endPx: [candidate.end.x, candidate.end.y],
          reason: "", correctionReason: "", heightM: "", thicknessM: "", openings: [],
        };
      });
      setReviews(initial); setSelectedCandidateId(parsed.candidates[0]?.id ?? "");
      setRooms([]); setSelectedRoomId(""); setOrigin(null); setPointA(null); setPointB(null);
      setPendingRoomPoints([]); setPickMode(null); setConfirmed(false);
      if (!sourceId) setSourceId("floor-plan-source");
      if (!buildingId) setBuildingId("building-demo");
      if (!floorPlanId) setFloorPlanId("ground-floor");
      if (!floorPlanName) setFloorPlanName("Reviewed floor plan");
      setSuccess("Proposal loaded and hashed. Every detected line starts undecided.");
    } catch (cause) {
      sourceCheckTokenRef.current += 1;
      setReport(null); setReportHash(""); setReviews({}); setSourceState("missing");
      setError(cause instanceof Error ? cause.message : "Could not load this proposal report.");
    }
  }

  function pixelAt(event: ReactMouseEvent<SVGSVGElement> | ReactPointerEvent<SVGSVGElement>): PointPx {
    if (!report) return [0, 0];
    const rect = event.currentTarget.getBoundingClientRect();
    return [
      Math.round(clamp((event.clientX - rect.left) / rect.width * report.raster.width, 0, report.raster.width - 1) * 100) / 100,
      Math.round(clamp((event.clientY - rect.top) / rect.height * report.raster.height, 0, report.raster.height - 1) * 100) / 100,
    ];
  }

  function updateCandidate(id: string, patch: Partial<CandidateReview>) {
    setReviews((previous) => ({ ...previous, [id]: { ...previous[id], ...patch } }));
  }
  function updateSelected(patch: Partial<CandidateReview>) {
    if (selectedCandidateId) updateCandidate(selectedCandidateId, patch);
  }
  function canvasClick(event: ReactMouseEvent<SVGSVGElement>) {
    if (!report || !pickMode) return;
    const point = pixelAt(event);
    if (pickMode === "calibrationA") { setPointA(point); setPickMode(null); return; }
    if (pickMode === "calibrationB") { setPointB(point); setPickMode(null); return; }
    if (pickMode === "origin") { setOrigin(point); setPickMode(null); return; }
    if (pickMode === "room") setPendingRoomPoints((previous) => [...previous, point]);
  }
  function startDrag(event: ReactPointerEvent<SVGCircleElement>, next: Exclude<DragState, null>) {
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); setDragging(next);
  }
  function canvasMove(event: ReactPointerEvent<SVGSVGElement>) {
    if (!dragging || !report) return;
    const point = pixelAt(event);
    if (dragging.kind === "wall") {
      updateCandidate(dragging.id, { [dragging.endpoint]: point } as Partial<CandidateReview>);
    } else {
      setRooms((previous) => previous.map((room) => room.id === dragging.id
        ? { ...room, polygonPx: room.polygonPx.map((item, index) => index === dragging.index ? point : item), reviewed: false }
        : room));
    }
  }
  function finishRoom() {
    if (pendingRoomPoints.length < 3) { setError("A room polygon needs at least three points."); return; }
    if (!safeId(roomIdDraft) || rooms.some((room) => room.id === roomIdDraft)) { setError("Room ID is invalid or already used."); return; }
    setRooms((previous) => [...previous, { id: roomIdDraft, name: roomNameDraft.trim() || roomIdDraft, polygonPx: pendingRoomPoints, reviewed: false }]);
    setSelectedRoomId(roomIdDraft); setPendingRoomPoints([]); setRoomIdDraft("room-" + (rooms.length + 2));
    setRoomNameDraft("Room " + (rooms.length + 2)); setPickMode(null); setError("");
  }
  function addOpening() {
    if (!selectedReview || selectedReview.decision !== "accept-wall") return;
    const opening: Opening = {
      id: "opening-" + (candidates.findIndex((item) => item.id === selectedCandidateId) + 1) + "-" + (selectedReview.openings.length + 1),
      type: openingType, offsetPx: num(openingOffsetPx), widthPx: num(openingWidthPx), heightM: num(openingHeightM), sillHeightM: num(openingSillM),
    };
    updateSelected({ openings: [...selectedReview.openings, opening] });
    setOpeningOffsetPx(""); setOpeningWidthPx(""); setOpeningHeightM(""); setOpeningSillM("");
    setSuccess("Opening added to the selected wall draft. Export validation will check it again."); setError("");
  }

  async function exportReview() {
    setError(""); setSuccess("");
    if (!report || sourceState !== "matched" || !sourceHash || !reportHash) {
      setError("Load a valid proposal and select the exact source image before exporting."); return;
    }
    try {
      const payload = buildFloorPlanRasterReviewPayload({
        proposalReport: report, sourceSha256: sourceHash, proposalReportSha256: reportHash,
        reviewer, reviewedAt: new Date().toISOString(), notes, sourceId, buildingId, floorPlanId, floorPlanName,
        confirmedAgainstSource: confirmed, originPixel: origin ?? [],
        calibration: { pointA: pointA ?? [], pointB: pointB ?? [], distanceM: num(distanceM), evidenceDescription: dimensionEvidence },
        placement: { longitude: num(longitude), latitude: num(latitude), heightM: num(heightM), headingDegrees: num(headingDegrees) },
        level: { elevationM: num(elevationM), wallHeightM: num(wallHeightM), wallThicknessM: num(wallThicknessM), floorThicknessM: num(floorThicknessM) },
        topologyToleranceM: num(topologyToleranceM),
        candidateReviews: candidates.map((candidate) => reviews[candidate.id]),
        rooms: rooms.map((room) => ({ ...room, decision: room.reviewed ? "accept" : "pending" })),
      });
      const output = JSON.stringify(payload, null, 2) + "\n";
      const url = URL.createObjectURL(new Blob([output], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = (floorPlanId || "floor-plan") + "-review.json";
      document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
      setSuccess("Review JSON exported. No source image or review was uploaded.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not export review JSON."); }
  }

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 text-slate-900 md:px-8">
      <div className="mx-auto max-w-[1500px] space-y-6">
        <header className="flex flex-col gap-3 border-b border-slate-200 pb-5 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-blue-700">P3.7 · Private review tooling</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">Floor-plan review workspace</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Inspect line proposals, correct endpoints, draw reviewed room polygons, calibrate scale and export hash-bound review JSON.</p>
          </div>
          <div className="max-w-md rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">Local-only browser workflow. No image or review is uploaded. Export does not approve or publish a model.</div>
        </header>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className={panel}>
            <h2 className="text-base font-semibold">1. Load source inputs</h2>
            <label className="mt-4 block text-sm font-medium">Proposal report JSON
              <input className={field} type="file" accept=".json,application/json" onChange={(e) => void loadProposal(e.currentTarget.files?.[0])} />
            </label>
            <label className="mt-4 block text-sm font-medium">Original raster source
              <input className={field} type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => {
                const nextFile = e.currentTarget.files?.[0] ?? null;
                if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
                objectUrlRef.current = nextFile ? URL.createObjectURL(nextFile) : "";
                setSourceUrl(objectUrlRef.current);
                setSourceFile(nextFile);
                setSuccess("");
                setError("");
                if (nextFile && report) void verifySource(nextFile, report);
                else { sourceCheckTokenRef.current += 1; setSourceHash(""); setSourceState("missing"); }
              }} />
            </label>
            <div className={"mt-4 rounded-lg border px-3 py-2 text-sm " + (sourceState === "matched" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : sourceState === "mismatch" || sourceState === "error" ? "border-rose-200 bg-rose-50 text-rose-800" : "border-slate-200 bg-slate-50 text-slate-700")}>{stageText}</div>
            {report && <dl className="mt-4 grid gap-2 text-xs sm:grid-cols-2">
              <div className="rounded-lg bg-slate-50 p-3"><dt className="text-slate-500">Raster frame</dt><dd className="mt-1 font-mono font-semibold">{report.raster.width} × {report.raster.height} px</dd></div>
              <div className="rounded-lg bg-slate-50 p-3"><dt className="text-slate-500">Candidates</dt><dd className="mt-1 font-semibold">{candidates.length}</dd></div>
              <div className="rounded-lg bg-slate-50 p-3"><dt className="text-slate-500">Proposal SHA-256</dt><dd className="mt-1 break-all font-mono">{reportHash}</dd></div>
              <div className="rounded-lg bg-slate-50 p-3"><dt className="text-slate-500">Source SHA-256</dt><dd className="mt-1 break-all font-mono">{sourceHash || "Waiting for source match"}</dd></div>
            </dl>}
          </div>
          <div className={panel}>
            <h2 className="text-base font-semibold">2. Reviewer and source binding</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-medium">Reviewer name<input className={field} value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="Reviewer name" /></label>
              <label className="text-sm font-medium">Source ID<input className={field} value={sourceId} onChange={(e) => setSourceId(e.target.value)} placeholder="floor-plan-source" /></label>
              <label className="text-sm font-medium">Building ID<input className={field} value={buildingId} onChange={(e) => setBuildingId(e.target.value)} placeholder="building-id" /></label>
              <label className="text-sm font-medium">Floor-plan ID<input className={field} value={floorPlanId} onChange={(e) => setFloorPlanId(e.target.value)} placeholder="ground-floor" /></label>
              <label className="text-sm font-medium sm:col-span-2">Floor-plan display name<input className={field} value={floorPlanName} onChange={(e) => setFloorPlanName(e.target.value)} placeholder="Ground floor plan" /></label>
              <label className="text-sm font-medium sm:col-span-2">Review notes<textarea className={field} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Record how the source and dimension annotation were checked." /></label>
            </div>
            <label className="mt-4 flex items-start gap-3 rounded-lg border border-slate-200 p-3 text-sm">
              <input className="mt-1 h-4 w-4 accent-blue-700" type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              <span>I reviewed the original source and explicitly confirm the vectors marked reviewed below.</span>
            </label>
          </div>
        </section>

        <section className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(370px,0.8fr)]">
          <div className={panel}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><h2 className="text-base font-semibold">3. Trace review canvas</h2><p className="mt-1 text-sm text-slate-600">Click a line to select it. Drag its circular endpoints. Coordinates remain in the normalized proposal pixel frame.</p></div>
              <div className="flex flex-wrap gap-2">
                <button className={button} type="button" disabled={!report} onClick={() => setPickMode(pickMode === "calibrationA" ? null : "calibrationA")}>Pick scale A</button>
                <button className={button} type="button" disabled={!report} onClick={() => setPickMode(pickMode === "calibrationB" ? null : "calibrationB")}>Pick scale B</button>
                <button className={button} type="button" disabled={!report} onClick={() => setPickMode(pickMode === "origin" ? null : "origin")}>Pick origin</button>
                <button className={button} type="button" disabled={!report} onClick={() => { setPendingRoomPoints([]); setPickMode(pickMode === "room" ? null : "room"); setError(""); }}>Draw room</button>
              </div>
            </div>
            {report && sourceUrl ? (
              <div className="mt-4 overflow-hidden rounded-xl border border-slate-300 bg-slate-100">
                <div className="relative w-full select-none" style={{ aspectRatio: String(report.raster.width) + " / " + String(report.raster.height) }}>
                  <Image src={sourceUrl} alt="Locally loaded floor-plan source" fill unoptimized className="object-fill" draggable={false} />
                  <svg className={"absolute inset-0 h-full w-full " + (pickMode ? "cursor-crosshair" : "cursor-default")} viewBox={"0 0 " + report.raster.width + " " + report.raster.height} preserveAspectRatio="none" onClick={canvasClick} onPointerMove={canvasMove} onPointerUp={() => setDragging(null)} onPointerCancel={() => setDragging(null)} style={{ touchAction: "none" }} aria-label="Interactive floor-plan trace canvas">
                    {candidates.map((candidate) => {
                      const item = reviews[candidate.id];
                      if (!item) return null;
                      const colour = item.decision === "accept-wall" ? "#059669" : item.decision === "reject" ? "#e11d48" : "#2563eb";
                      return <g key={candidate.id}>
                        <line x1={item.startPx[0]} y1={item.startPx[1]} x2={item.endPx[0]} y2={item.endPx[1]} stroke={colour} strokeWidth={selectedCandidateId === candidate.id ? 4 : 2.2} strokeLinecap="round" opacity={selectedCandidateId === candidate.id ? 1 : 0.75} onClick={(e) => { e.stopPropagation(); setSelectedCandidateId(candidate.id); setSelectedRoomId(""); }} />
                        {selectedCandidateId === candidate.id && <>
                          <circle cx={item.startPx[0]} cy={item.startPx[1]} r="5" fill="#ffffff" stroke={colour} strokeWidth="2" onPointerDown={(e) => startDrag(e, { kind: "wall", id: candidate.id, endpoint: "startPx" })} />
                          <circle cx={item.endPx[0]} cy={item.endPx[1]} r="5" fill="#ffffff" stroke={colour} strokeWidth="2" onPointerDown={(e) => startDrag(e, { kind: "wall", id: candidate.id, endpoint: "endPx" })} />
                          <text x={(item.startPx[0] + item.endPx[0]) / 2 + 4} y={(item.startPx[1] + item.endPx[1]) / 2 - 5} fill={colour} stroke="white" strokeWidth="2" paintOrder="stroke" fontSize="12">{candidate.id}</text>
                        </>}
                      </g>;
                    })}
                    {rooms.map((room) => <g key={room.id}>
                      <polygon points={pointsString(room.polygonPx)} fill={room.reviewed ? "rgba(5,150,105,0.18)" : "rgba(217,119,6,0.12)"} stroke={selectedRoomId === room.id ? "#d97706" : "#0d9488"} strokeWidth={selectedRoomId === room.id ? 3 : 1.5} strokeDasharray={room.reviewed ? undefined : "5 4"} onClick={(e) => { e.stopPropagation(); setSelectedRoomId(room.id); setSelectedCandidateId(""); }} />
                      <text x={room.polygonPx[0][0] + 3} y={room.polygonPx[0][1] - 4} fill="#0f766e" fontSize="13" stroke="white" strokeWidth="2" paintOrder="stroke">{room.name}</text>
                      {selectedRoomId === room.id && room.polygonPx.map((p, index) => <circle key={room.id + "-" + index} cx={p[0]} cy={p[1]} r="4.5" fill="#ffffff" stroke="#d97706" strokeWidth="2" onPointerDown={(e) => startDrag(e, { kind: "room", id: room.id, index })} />)}
                    </g>)}
                    {pendingRoomPoints.length > 0 && <g><polyline points={pointsString(pendingRoomPoints)} fill="none" stroke="#d97706" strokeWidth="2.5" strokeDasharray="5 4" />{pendingRoomPoints.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r="4" fill="#d97706" />)}</g>}
                    {pointA && <circle cx={pointA[0]} cy={pointA[1]} r="5" fill="#7c3aed" stroke="white" strokeWidth="2" />}
                    {pointB && <circle cx={pointB[0]} cy={pointB[1]} r="5" fill="#db2777" stroke="white" strokeWidth="2" />}
                    {origin && <path d={"M " + (origin[0] - 6) + " " + origin[1] + " L " + (origin[0] + 6) + " " + origin[1] + " M " + origin[0] + " " + (origin[1] - 6) + " L " + origin[0] + " " + (origin[1] + 6)} stroke="#111827" strokeWidth="2.5" />}
                  </svg>
                </div>
                <div className="flex flex-wrap gap-4 border-t border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                  <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-blue-600" />Undecided</span>
                  <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-emerald-600" />Accepted wall</span>
                  <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-rose-600" />Rejected</span>
                  <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-amber-600" />Room boundary</span>
                </div>
              </div>
            ) : <div className="mt-4 flex min-h-64 items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-500">Load a matching proposal JSON and original raster to open the canvas.</div>}
            {pickMode && <p className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800">{pickMode === "calibrationA" ? "Click the first endpoint of a known dimension." : pickMode === "calibrationB" ? "Click the second endpoint of the same dimension." : pickMode === "origin" ? "Click the explicit floor-plan origin." : "Click room boundary vertices in order, then finish the polygon."}</p>}
            {pickMode === "room" && <div className="mt-3 grid gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <label className="text-sm font-medium">Room ID<input className={field} value={roomIdDraft} onChange={(e) => setRoomIdDraft(e.target.value)} /></label>
              <label className="text-sm font-medium">Room name<input className={field} value={roomNameDraft} onChange={(e) => setRoomNameDraft(e.target.value)} /></label>
              <button className={primaryButton} type="button" disabled={pendingRoomPoints.length < 3} onClick={finishRoom}>Finish room ({pendingRoomPoints.length} pts)</button>
            </div>}
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-500">Undecided</p><p className="mt-1 text-2xl font-semibold">{undecidedCount}</p></div>
              <div className="rounded-lg bg-emerald-50 p-3"><p className="text-xs text-emerald-700">Accepted wall lines</p><p className="mt-1 text-2xl font-semibold text-emerald-800">{acceptedCount}</p></div>
              <div className="rounded-lg bg-rose-50 p-3"><p className="text-xs text-rose-700">Rejected lines</p><p className="mt-1 text-2xl font-semibold text-rose-800">{rejectedCount}</p></div>
            </div>
          </div>

          <div className="space-y-4">
            <section className={panel}>
              <h2 className="text-base font-semibold">4. Selected line review</h2>
              {!selectedReview ? <p className="mt-3 text-sm text-slate-500">Select a line from the list below or click its trace.</p> : <>
                <p className="mt-1 break-all font-mono text-xs text-slate-500">{selectedReview.proposalId}</p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button className={button} type="button" onClick={() => updateSelected({ decision: "accept-wall", reason: "" })}>Accept as wall</button>
                  <button className={button} type="button" onClick={() => updateSelected({ decision: "reject" })}>Reject line</button>
                </div>
                {selectedReview.decision === "reject" ? <label className="mt-3 block text-sm font-medium">Rejection reason<textarea className={field} rows={2} value={selectedReview.reason} onChange={(e) => updateSelected({ reason: e.target.value })} placeholder="Why is this not a wall?" /></label> :
                selectedReview.decision === "accept-wall" ? <div className="mt-3 space-y-3">
                  <label className="block text-sm font-medium">Wall ID<input className={field} value={selectedReview.wallId} onChange={(e) => updateSelected({ wallId: e.target.value })} /></label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-xs font-medium">Start X, px<input className={field} type="number" step="0.01" value={selectedReview.startPx[0]} onChange={(e) => updateSelected({ startPx: [num(e.target.value), selectedReview.startPx[1]] })} /></label>
                    <label className="text-xs font-medium">Start Y, px<input className={field} type="number" step="0.01" value={selectedReview.startPx[1]} onChange={(e) => updateSelected({ startPx: [selectedReview.startPx[0], num(e.target.value)] })} /></label>
                    <label className="text-xs font-medium">End X, px<input className={field} type="number" step="0.01" value={selectedReview.endPx[0]} onChange={(e) => updateSelected({ endPx: [num(e.target.value), selectedReview.endPx[1]] })} /></label>
                    <label className="text-xs font-medium">End Y, px<input className={field} type="number" step="0.01" value={selectedReview.endPx[1]} onChange={(e) => updateSelected({ endPx: [selectedReview.endPx[0], num(e.target.value)] })} /></label>
                  </div>
                  <label className="block text-sm font-medium">Correction reason (needed if moved over 25 px)<textarea className={field} rows={2} value={selectedReview.correctionReason} onChange={(e) => updateSelected({ correctionReason: e.target.value })} placeholder="Explain substantial endpoint changes." /></label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-sm font-medium">Wall height (m)<input className={field} type="number" min="2" max="8" step="0.01" value={selectedReview.heightM} onChange={(e) => updateSelected({ heightM: e.target.value })} placeholder="Use level height" /></label>
                    <label className="text-sm font-medium">Wall thickness (m)<input className={field} type="number" min="0.05" max="0.75" step="0.01" value={selectedReview.thicknessM} onChange={(e) => updateSelected({ thicknessM: e.target.value })} placeholder="Use level thickness" /></label>
                  </div>
                  <div className="rounded-xl border border-slate-200 p-3">
                    <h3 className="text-sm font-semibold">Doors and windows</h3>
                    {selectedReview.openings.map((opening) => <div key={opening.id} className="mt-2 flex items-center justify-between gap-2 rounded-md bg-slate-50 px-2 py-2 text-xs">
                      <span>{opening.type} · offset {opening.offsetPx}px · width {opening.widthPx}px</span>
                      <button type="button" className="text-rose-700 underline" onClick={() => updateSelected({ openings: selectedReview.openings.filter((item) => item.id !== opening.id) })}>Remove</button>
                    </div>)}
                    <label className="mt-3 block text-sm font-medium">Opening type<select className={field} value={openingType} onChange={(e) => setOpeningType(e.target.value as "door" | "window")}><option value="door">Door</option><option value="window">Window</option></select></label>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <label className="text-xs font-medium">Offset along wall (px)<input className={field} type="number" min="0" step="0.1" value={openingOffsetPx} onChange={(e) => setOpeningOffsetPx(e.target.value)} /></label>
                      <label className="text-xs font-medium">Width (px)<input className={field} type="number" min="0.5" step="0.1" value={openingWidthPx} onChange={(e) => setOpeningWidthPx(e.target.value)} /></label>
                      <label className="text-xs font-medium">Opening height (m)<input className={field} type="number" min="0.4" step="0.01" value={openingHeightM} onChange={(e) => setOpeningHeightM(e.target.value)} /></label>
                      <label className="text-xs font-medium">Sill height (m)<input className={field} type="number" min="0" step="0.01" value={openingSillM} onChange={(e) => setOpeningSillM(e.target.value)} /></label>
                    </div>
                    <button className={button + " mt-3 w-full"} type="button" disabled={!openingOffsetPx || !openingWidthPx || !openingHeightM || !openingSillM} onClick={addOpening}>Add reviewed opening</button>
                  </div>
                </div> : <p className="mt-3 text-sm text-slate-500">Choose Accept as wall or Reject line. Undecided lines cannot be exported.</p>}
              </>}
            </section>

            <section className={panel}>
              <h2 className="text-base font-semibold">5. Room polygons</h2>
              <p className="mt-1 text-sm text-slate-600">Draw boundary points on the canvas, finish the polygon, then mark it reviewed. Drag selected vertices to correct them.</p>
              <div className="mt-3 space-y-2">
                {rooms.map((room) => <div key={room.id} className={"rounded-lg border p-3 " + (selectedRoomId === room.id ? "border-amber-400 bg-amber-50" : "border-slate-200")}>
                  <button className="flex w-full items-center justify-between gap-2 text-left" type="button" onClick={() => { setSelectedRoomId(room.id); setSelectedCandidateId(""); }}>
                    <span className="min-w-0"><span className="block truncate text-sm font-semibold">{room.name}</span><span className="mt-1 block font-mono text-xs text-slate-500">{room.id} · {room.polygonPx.length} vertices</span></span>
                    <span className={"text-xs font-semibold " + (room.reviewed ? "text-emerald-700" : "text-amber-700")}>{room.reviewed ? "Reviewed" : "Needs review"}</span>
                  </button>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button className={button} type="button" onClick={() => setRooms((previous) => previous.map((item) => item.id === room.id ? { ...item, reviewed: !item.reviewed } : item))}>{room.reviewed ? "Undo review" : "Mark reviewed"}</button>
                    <button className={button} type="button" onClick={() => setRooms((previous) => previous.filter((item) => item.id !== room.id))}>Delete</button>
                  </div>
                </div>)}
                {rooms.length === 0 && <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-500">No room polygon yet. Choose Draw room, click at least three boundary points, then Finish room.</p>}
              </div>
              {selectedRoom && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">Selected room: {selectedRoom.name}. Any vertex change resets its review flag.</p>}
            </section>

            <section className={panel}>
              <h2 className="text-base font-semibold">6. Scale and origin</h2>
              <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-500">Point A</p><p className="mt-1 font-mono">{pointA ? pointA.join(", ") : "Not set"}</p></div>
                <div className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-500">Point B</p><p className="mt-1 font-mono">{pointB ? pointB.join(", ") : "Not set"}</p></div>
                <div className="col-span-2 rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-500">Pixel origin</p><p className="mt-1 font-mono">{origin ? origin.join(", ") : "Not set"}</p></div>
              </div>
              <label className="mt-3 block text-sm font-medium">Known distance A–B (m)<input className={field} type="number" min="0.1" max="10000" step="0.01" value={distanceM} onChange={(e) => setDistanceM(e.target.value)} /></label>
              <label className="mt-3 block text-sm font-medium">Dimension evidence description<textarea className={field} rows={2} value={dimensionEvidence} onChange={(e) => setDimensionEvidence(e.target.value)} placeholder="Source dimension label or survey reference." /></label>
              {pointA && pointB && distanceM && Number(distanceM) > 0 && <p className="mt-3 rounded-lg bg-blue-50 p-3 text-sm text-blue-900">Scale estimate: {(Number(distanceM) / Math.hypot(pointA[0] - pointB[0], pointA[1] - pointB[1])).toFixed(6)} m/px. Not independently surveyed.</p>}
            </section>

            <section className={panel}>
              <h2 className="text-base font-semibold">7. Explicit placement and level</h2>
              <p className="mt-1 text-sm text-slate-600">Fill values from reviewed evidence; they are not inferred.</p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <label className="text-sm font-medium">Longitude<input className={field} type="number" min="-180" max="180" step="0.0000001" value={longitude} onChange={(e) => setLongitude(e.target.value)} /></label>
                <label className="text-sm font-medium">Latitude<input className={field} type="number" min="-85" max="85" step="0.0000001" value={latitude} onChange={(e) => setLatitude(e.target.value)} /></label>
                <label className="text-sm font-medium">Origin height (m)<input className={field} type="number" min="-1000" max="10000" step="0.01" value={heightM} onChange={(e) => setHeightM(e.target.value)} /></label>
                <label className="text-sm font-medium">Heading (degrees)<input className={field} type="number" min="0" max="359.999999" step="0.01" value={headingDegrees} onChange={(e) => setHeadingDegrees(e.target.value)} /></label>
                <label className="text-sm font-medium">Level elevation (m)<input className={field} type="number" min="-1000" max="10000" step="0.01" value={elevationM} onChange={(e) => setElevationM(e.target.value)} /></label>
                <label className="text-sm font-medium">Wall height (m)<input className={field} type="number" min="2" max="8" step="0.01" value={wallHeightM} onChange={(e) => setWallHeightM(e.target.value)} /></label>
                <label className="text-sm font-medium">Wall thickness (m)<input className={field} type="number" min="0.05" max="0.75" step="0.01" value={wallThicknessM} onChange={(e) => setWallThicknessM(e.target.value)} /></label>
                <label className="text-sm font-medium">Floor thickness (m)<input className={field} type="number" min="0.03" max="0.5" step="0.01" value={floorThicknessM} onChange={(e) => setFloorThicknessM(e.target.value)} /></label>
                <label className="col-span-2 text-sm font-medium">Boundary tolerance (m)<input className={field} type="number" min="0.05" max="0.5" step="0.01" value={topologyToleranceM} onChange={(e) => setTopologyToleranceM(e.target.value)} /></label>
              </div>
            </section>
          </div>
        </section>

        <section className={panel}>
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div><h2 className="text-base font-semibold">8. All detector-line decisions</h2><p className="mt-1 text-sm text-slate-600">Each candidate must be accepted as a wall or rejected with a reason. Confidence values are suggestions only.</p></div>
            <button className={button} type="button" onClick={() => setSelectedCandidateId(candidates.find((item) => reviews[item.id]?.decision === "undecided")?.id ?? candidates[0]?.id ?? "")} disabled={!report}>Next undecided line</button>
          </div>
          {report && <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {candidates.map((candidate) => {
              const item = reviews[candidate.id];
              const status = item?.decision ?? "undecided";
              return <button key={candidate.id} type="button" onClick={() => { setSelectedCandidateId(candidate.id); setSelectedRoomId(""); }} className={"rounded-xl border p-3 text-left transition " + (selectedCandidateId === candidate.id ? "border-blue-500 bg-blue-50 ring-2 ring-blue-100" : "border-slate-200 bg-white hover:border-slate-300")}>
                <div className="flex items-center justify-between gap-2"><span className="font-mono text-xs font-semibold">{candidate.id}</span><span className={"rounded-full px-2 py-1 text-[10px] font-semibold uppercase " + (status === "accept-wall" ? "bg-emerald-100 text-emerald-800" : status === "reject" ? "bg-rose-100 text-rose-800" : "bg-slate-100 text-slate-600")}>{status}</span></div>
                <p className="mt-2 text-xs text-slate-500">{candidate.orientation ?? "line"} · {candidate.lengthPx?.toFixed?.(1) ?? "—"} px · confidence {candidate.confidenceScore?.toFixed?.(2) ?? "n/a"}</p>
                <p className="mt-2 font-mono text-[11px] text-slate-600">({item?.startPx[0]}, {item?.startPx[1]}) → ({item?.endPx[0]}, {item?.endPx[1]})</p>
                {status === "reject" && !item.reason.trim() && <p className="mt-2 text-xs text-rose-700">Rejection reason required</p>}
              </button>;
            })}
          </div>}
        </section>

        {(error || success) && <div role={error ? "alert" : "status"} className={"rounded-xl border p-4 text-sm " + (error ? "border-rose-200 bg-rose-50 text-rose-800" : "border-emerald-200 bg-emerald-50 text-emerald-800")}>{error || success}</div>}

        <footer className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 md:flex-row md:items-center md:justify-between">
          <div><p className="font-semibold">Export review-only JSON</p><p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">Export is intended for the calibration CLI. Hashes bind the original image and proposal report; every line, room boundary, scale and placement value remains a reviewer-supplied assertion. No server request is made and no model is published.</p><div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-500"><span>{undecidedCount} undecided lines</span><span>{reviewedRooms}/{rooms.length} rooms reviewed</span><span>Source: {sourceState}</span></div></div>
          <button className={primaryButton} type="button" onClick={() => void exportReview()} disabled={!report || sourceState !== "matched" || undecidedCount > 0 || rooms.length === 0 || reviewedRooms !== rooms.length || !confirmed || !pointA || !pointB || !origin}>Validate and download review JSON</button>
        </footer>
      </div>
    </main>
  );
}

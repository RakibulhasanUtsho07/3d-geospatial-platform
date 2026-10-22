import { NextResponse } from "next/server";

import { authorizeGenerationApiRequest, getGenerationWorkspaceRoot } from "@/core/building-generation/generation-api-auth.mjs";
import {
  ingestUploadedGenerationMedia,
  MAX_GENERATION_MEDIA_UPLOAD_BYTES,
} from "@/core/building-generation/generation-media-upload.mjs";

const MAX_MULTIPART_OVERHEAD_BYTES = 128 * 1024;
const MAX_REQUEST_BODY_BYTES = MAX_GENERATION_MEDIA_UPLOAD_BYTES + MAX_MULTIPART_OVERHEAD_BYTES;

function formText(form: FormData, key: string, maxLength: number, required = false): string | undefined {
  const value = form.get(key);
  if (value === null || value === "") {
    if (required) throw new TypeError(key + " is required.");
    return undefined;
  }
  if (typeof value !== "string") throw new TypeError(key + " must be a text field.");
  if (value.length > maxLength) throw new RangeError(key + " exceeds " + maxLength + " characters.");
  const normalized = value.trim();
  if (required && !normalized) throw new TypeError(key + " is required.");
  return normalized || undefined;
}

async function readBoundedBody(request: Request): Promise<Buffer> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    throw new RangeError("Upload request exceeds the 50 MiB file limit plus multipart overhead.");
  }
  if (!request.body) return Buffer.alloc(0);

  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      total += chunk.length;
      if (total > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new RangeError("Upload request exceeds the 50 MiB file limit plus multipart overhead.");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function responseError(error: unknown) {
  if (error instanceof RangeError) {
    return NextResponse.json({ error: error.message }, { status: 413 });
  }
  if (error instanceof TypeError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  const message = error instanceof Error ? error.message : "";
  if (/already exists/i.test(message)) {
    return NextResponse.json({ error: message }, { status: 409 });
  }
  return NextResponse.json({ error: "Could not persist uploaded media." }, { status: 500 });
}

export async function POST(request: Request) {
  const auth = authorizeGenerationApiRequest(request);
  if (!auth.allowed) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let workspaceRoot: string;
  try {
    workspaceRoot = getGenerationWorkspaceRoot();
  } catch {
    return NextResponse.json({ error: "Generation workspace is not configured on this server." }, { status: 503 });
  }

  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) {
    return NextResponse.json({ error: "Content-Type must be multipart/form-data with a boundary." }, { status: 415 });
  }

  let body: Buffer;
  try {
    body = await readBoundedBody(request);
  } catch (error) {
    return responseError(error);
  }

  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");

  let form: FormData;
  try {
    form = await new Response(body, { headers }).formData();
  } catch {
    return NextResponse.json({ error: "Upload body must be valid multipart form data." }, { status: 400 });
  }

  const entry = form.get("file");
  if (!entry || typeof entry === "string" || typeof entry.arrayBuffer !== "function") {
    return NextResponse.json({ error: "A file field named 'file' is required." }, { status: 400 });
  }
  if (entry.size === 0) {
    return NextResponse.json({ error: "Uploaded file is empty." }, { status: 400 });
  }
  if (entry.size > MAX_GENERATION_MEDIA_UPLOAD_BYTES) {
    return NextResponse.json({ error: "Uploaded file exceeds the 50 MiB API limit." }, { status: 413 });
  }

  try {
    const buildingId = formText(form, "buildingId", 80, true)!;
    const sourceId = formText(form, "sourceId", 80, true)!;
    const kind = formText(form, "kind", 20);
    const licence = formText(form, "licence", 300);
    const author = formText(form, "author", 500);
    const attribution = formText(form, "attribution", 500);
    const sourceUrl = formText(form, "sourceUrl", 500);
    const capturedAt = formText(form, "capturedAt", 500);
    const description = formText(form, "description", 2000);

    const result = await ingestUploadedGenerationMedia({
      workspaceRoot,
      buildingId,
      sourceId,
      kind,
      licence,
      author,
      attribution,
      sourceUrl,
      capturedAt,
      description,
      title: entry.name.slice(0, 500) || "uploaded-media",
      bytes: Buffer.from(await entry.arrayBuffer()),
    });

    return NextResponse.json({
      source: result.record,
      note: "Source is stored with usageStatus=unreviewed. Review rights before queueing generation.",
    }, { status: 201 });
  } catch (error) {
    return responseError(error);
  }
}

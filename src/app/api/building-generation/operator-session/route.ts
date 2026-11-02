import { NextResponse } from "next/server";

import {
  createGenerationOperatorSessionValue,
  GENERATION_OPERATOR_SESSION_COOKIE,
  GENERATION_OPERATOR_SESSION_SECONDS,
  isSameOriginGenerationRequest,
  verifyGenerationOperatorLoginToken,
  verifyGenerationOperatorSession,
} from "@/core/building-generation/generation-api-auth.mjs";

const MAX_BODY_BYTES = 8 * 1024;

function cookie(value: string, maxAge: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return GENERATION_OPERATOR_SESSION_COOKIE + "=" + value +
    "; HttpOnly; SameSite=Strict; Path=/api/building-generation; Max-Age=" + maxAge + secure;
}

export async function GET(request: Request) {
  const session = verifyGenerationOperatorSession(request);
  if (!session.allowed) {
    return NextResponse.json({ error: session.error }, { status: session.status });
  }
  return NextResponse.json(
    { authenticated: true, expiresAt: session.expiresAt },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  if (!isSameOriginGenerationRequest(request)) {
    return NextResponse.json({ error: "Operator login must be submitted from this origin." }, { status: 403 });
  }
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return NextResponse.json({ error: "Content-Type must be application/json." }, { status: 415 });
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Operator login request exceeds its size limit." }, { status: 413 });
  }

  let input: unknown;
  try {
    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Operator login request exceeds its size limit." }, { status: 413 });
    }
    input = JSON.parse(body) as unknown;
  } catch {
    return NextResponse.json({ error: "Operator login request must be valid JSON." }, { status: 400 });
  }
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      !("token" in input) || typeof input.token !== "string") {
    return NextResponse.json({ error: "An operator token is required." }, { status: 400 });
  }

  const auth = verifyGenerationOperatorLoginToken(input.token);
  if (!auth.allowed) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const sessionValue = createGenerationOperatorSessionValue();
    return NextResponse.json(
      { authenticated: true, expiresInSeconds: GENERATION_OPERATOR_SESSION_SECONDS },
      {
        status: 200,
        headers: {
          "Set-Cookie": cookie(sessionValue, GENERATION_OPERATOR_SESSION_SECONDS),
          "Cache-Control": "no-store",
        },
      },
    );
  } catch {
    return NextResponse.json({ error: "Operator session signing is not configured." }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  if (!isSameOriginGenerationRequest(request)) {
    return NextResponse.json({ error: "Operator logout must be submitted from this origin." }, { status: 403 });
  }
  return NextResponse.json(
    { authenticated: false },
    {
      headers: {
        "Set-Cookie": cookie("", 0),
        "Cache-Control": "no-store",
      },
    },
  );
}

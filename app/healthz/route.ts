export const runtime = "nodejs";

export async function GET() {
  // keep it tiny for fast health probes
  return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
}
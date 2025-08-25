// app/healthz/route.ts
export const runtime = "nodejs";

export async function GET() {
  const hasApify = !!process.env.APIFY_TOKEN && !!process.env.APIFY_ACTOR_ID;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const ok = hasApify && hasOpenAI;

  return Response.json(
    {
      status: ok ? "ok" : "config-missing",
      apify: hasApify,
      openai: hasOpenAI,
      ts: Date.now()
    },
    { status: ok ? 200 : 500 }
  );
}

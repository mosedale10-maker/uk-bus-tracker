/**
 * Edge gate for ukbustracker.co.uk — when the PC tunnel is down,
 * show a friendly "connection issues" page instead of Cloudflare Error 1033.
 */

const LOGO_PATH = "/__gate/ukbustracker-logo.jpg";

const DOWN_HTML = `<!DOCTYPE html>
<html lang="en-GB">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>UK Bus Tracker — Connection issues</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      font-family: "Segoe UI", system-ui, sans-serif;
      color: #0f172a;
      background:
        radial-gradient(1200px 600px at 10% -10%, #fde68a 0%, transparent 55%),
        radial-gradient(900px 500px at 100% 0%, #bfdbfe 0%, transparent 50%),
        #f1f5f9;
    }
    main {
      width: min(520px, 100%);
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 16px;
      padding: 28px 26px 24px;
      box-shadow: 0 18px 40px rgba(15, 23, 42, 0.08);
      text-align: center;
    }
    .logo {
      width: 148px;
      height: 148px;
      object-fit: contain;
      border-radius: 50%;
      margin: 0 auto 14px;
      display: block;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12);
    }
    .brand {
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #64748b;
      font-weight: 700;
    }
    h1 {
      margin: 10px 0 12px;
      font-size: 1.65rem;
      line-height: 1.2;
    }
    p {
      margin: 0 0 12px;
      line-height: 1.55;
      color: #334155;
      text-align: left;
    }
    .hint {
      margin-top: 18px;
      font-size: 0.92rem;
      color: #64748b;
    }
    button {
      margin-top: 8px;
      appearance: none;
      border: 0;
      border-radius: 999px;
      background: #fbbf24;
      color: #111;
      font-weight: 800;
      font-size: 0.95rem;
      padding: 10px 16px;
      cursor: pointer;
    }
    button:hover { filter: brightness(0.97); }
  </style>
</head>
<body>
  <main>
    <img class="logo" src="${LOGO_PATH}" width="148" height="148" alt="UK Bus Tracker logo" />
    <div class="brand">UK Bus Tracker</div>
    <h1>We’re having connection issues</h1>
    <p>
      The live map host is temporarily unreachable. Your account and data are safe.
      We hope to be back up as soon as possible.
    </p>
    <p class="hint">This page refreshes automatically. You can also try again now.</p>
    <button type="button" onclick="location.reload()">Try again</button>
  </main>
  <script>
    setTimeout(function () { location.reload(); }, 30000);
  </script>
</body>
</html>`;

function wantsHtml(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const accept = request.headers.get("accept") || "";
  if (accept.includes("text/html")) return true;
  const url = new URL(request.url);
  return url.pathname === "/" || !url.pathname.startsWith("/api/");
}

function downResponse(request) {
  if (wantsHtml(request)) {
    return new Response(DOWN_HTML, {
      status: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": "30",
      },
    });
  }
  return Response.json(
    {
      ok: false,
      error: "connection_issues",
      message: "UK Bus Tracker is having connection issues. Please try again shortly.",
    },
    {
      status: 503,
      headers: { "cache-control": "no-store", "retry-after": "30" },
    },
  );
}

async function isOriginUnreachable(response) {
  const status = response.status;
  if (status === 530 || status === 502 || status === 504) return true;
  if (status !== 503) return false;
  const ct = response.headers.get("content-type") || "";
  if (!ct.includes("text/html")) return false;
  try {
    const text = await response.clone().text();
    return /Error 1033|Cloudflare Tunnel|cf-error|cloudflare\.com\/5xx/i.test(text);
  } catch {
    return true;
  }
}

async function serveGateLogo(request, env) {
  if (!env?.ASSETS) return null;
  const assetReq = new Request(new URL("/ukbustracker-logo.jpg", request.url), request);
  const res = await env.ASSETS.fetch(assetReq);
  if (!res.ok) return null;
  const headers = new Headers(res.headers);
  headers.set("cache-control", "public, max-age=86400");
  headers.set("content-type", "image/jpeg");
  return new Response(res.body, { status: 200, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === LOGO_PATH) {
      const logo = await serveGateLogo(request, env);
      if (logo) return logo;
    }
    try {
      const response = await fetch(request);
      if (await isOriginUnreachable(response)) return downResponse(request);
      return response;
    } catch {
      return downResponse(request);
    }
  },
};

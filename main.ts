import { DORM, createClient } from "dormroom/DORM";

export { DORM };
export interface Env {
  X_CLIENT_ID: string;
  X_CLIENT_SECRET: string;
  X_REDIRECT_URI: string;
  LOGIN_REDIRECT_URI: string;
  X_LOGIN_DO: DurableObjectNamespace;
}

export const html = (strings: TemplateStringsArray, ...values: any[]) => {
  return strings.reduce(
    (result, str, i) => result + str + (values[i] || ""),
    "",
  );
};

// CORS headers for responses
function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

async function generateRandomString(length: number): Promise<string> {
  const randomBytes = new Uint8Array(length);
  crypto.getRandomValues(randomBytes);
  return Array.from(randomBytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function generateCodeChallenge(codeVerifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Helper to extract cookie value
function getCookieValue(
  cookieString: string | null,
  name: string,
): string | null {
  if (!cookieString) return null;
  const matches = cookieString.match(new RegExp(`${name}=([^;]+)`));
  return matches ? decodeURIComponent(matches[1]) : null;
}

const config = {
  statements: [
    `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    name TEXT,
    profile_image_url TEXT,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    has_subscription BOOLEAN DEFAULT FALSE,
    subscription_status TEXT
  )
  `,
  ],
  version: "v2",
};

const ROOT_DB_NAME = "db:root";

export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext) => {
    // Deconstruct Cookies
    const url = new URL(request.url);
    const method = request.method;
    const cookie = request.headers.get("Cookie");
    const xAccessToken = getCookieValue(cookie, "x_access_token");
    const userId = getCookieValue(cookie, "x_user_id");
    const accessToken = xAccessToken || url.searchParams.get("apiKey");

    // Handle CORS preflight requests
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: getCorsHeaders(),
      });
    }

    // TODO: Make DORM in a way that this logic isn't so complex. Connection with middleware should be more staight forward for the admin
    // We want to use the userID db if the prefix is /admin/[id]
    const dbName = url.pathname.startsWith("/admin/")
      ? url.pathname.split("/")[2]
      : undefined;
    const prefix = `/admin/${dbName}`;

    // Initialize DORM client for user database
    const client = createClient(env.X_LOGIN_DO, config, {
      ctx,
      name: dbName || userId || ROOT_DB_NAME,
      mirrorName:
        dbName !== ROOT_DB_NAME
          ? ROOT_DB_NAME
          : userId
            ? ROOT_DB_NAME
            : undefined,
      locationHint: userId ? undefined : "enam",
    });

    // Handle DB middleware requests (for exploring the DB)
    const middlewareResponse = await client.middleware(request, {
      prefix,
      secret: env.X_CLIENT_SECRET,
    });
    if (middlewareResponse) return middlewareResponse;

    // X Login routes
    if (url.pathname === "/login") {
      const scope = url.searchParams.get("scope");
      const state = await generateRandomString(16);
      const codeVerifier = await generateRandomString(43);
      const codeChallenge = await generateCodeChallenge(codeVerifier);

      const Location = `https://x.com/i/oauth2/authorize?response_type=code&client_id=${
        env.X_CLIENT_ID
      }&redirect_uri=${encodeURIComponent(
        env.X_REDIRECT_URI,
      )}&scope=${encodeURIComponent(
        scope || "users.read follows.read tweet.read offline.access",
      )}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`;

      const headers = new Headers(getCorsHeaders());

      headers.append("Location", Location);

      headers.append(
        "Set-Cookie",
        `x_oauth_state=${state}; HttpOnly; Domain=xymake.com; Path=/; Secure; SameSite=Lax; Max-Age=600`,
      );
      headers.append(
        "Set-Cookie",
        `x_code_verifier=${codeVerifier}; HttpOnly; Domain=xymake.com; Path=/; Secure; SameSite=Lax; Max-Age=600`,
      );

      return new Response("Redirecting", {
        status: 307,
        headers,
      });
    }

    // X OAuth callback route
    if (url.pathname === "/callback") {
      const urlState = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const cookieString = request.headers.get("Cookie") || "";

      const stateCookie = getCookieValue(cookieString, "x_oauth_state");
      const codeVerifier = getCookieValue(cookieString, "x_code_verifier");

      // Validate state and code verifier
      if (
        !urlState ||
        !stateCookie ||
        urlState !== stateCookie ||
        !codeVerifier
      ) {
        return new Response(
          `Invalid state or missing code verifier. Session validation failed.`,
          {
            status: 400,
            headers: getCorsHeaders(),
          },
        );
      }

      try {
        // Exchange code for access token
        const tokenResponse = await fetch(
          "https://api.twitter.com/2/oauth2/token",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Authorization: `Basic ${btoa(
                `${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`,
              )}`,
            },
            body: new URLSearchParams({
              code: code || "",
              redirect_uri: env.X_REDIRECT_URI,
              grant_type: "authorization_code",
              code_verifier: codeVerifier,
            }),
          },
        );

        if (!tokenResponse.ok) {
          throw new Error(
            `Twitter API responded with ${
              tokenResponse.status
            }: ${await tokenResponse.text()}`,
          );
        }

        const tokenData: any = await tokenResponse.json();
        const { access_token, refresh_token } = tokenData;

        // Fetch user data to store in the database
        const userResponse = await fetch(
          "https://api.x.com/2/users/me?user.fields=profile_image_url",
          {
            headers: {
              Authorization: `Bearer ${access_token}`,
              "Content-Type": "application/json",
            },
          },
        );

        if (!userResponse.ok) {
          throw new Error(
            `X API error: ${userResponse.status} ${await userResponse.text()}`,
          );
        }

        const userData: any = await userResponse.json();
        const { id, name, username, profile_image_url } = userData.data;

        if (!id) {
          throw new Error(`X API error: no ID found`);
        }

        // NB: Gotta recreate client since we need to connect with the userId unique db, with root as mirror
        const userClient = createClient(env.X_LOGIN_DO, config, {
          ctx,
          name: String(id),
          mirrorName: ROOT_DB_NAME,
        });

        // Store or update user in database
        const existingUserResult = await userClient.select("users", { id });

        if (
          existingUserResult.ok &&
          existingUserResult.json &&
          existingUserResult.json.length > 0
        ) {
          // Update existing user with new tokens and login time
          // Preserve subscription status if it exists
          const existingUser = existingUserResult.json[0];

          const result = await userClient.update(
            "users",
            {
              access_token,
              refresh_token: refresh_token || null,
              name,
              profile_image_url,
              last_login: new Date().toISOString(),
              // Keep existing subscription status if it exists
              has_subscription: existingUser.has_subscription || false,
              subscription_status: existingUser.subscription_status || null,
            },
            { id },
          );
        } else {
          // Create new user
          const insert = await userClient.insert("users", {
            id,
            username,
            name,
            profile_image_url,
            access_token,
            refresh_token: refresh_token || null,
            has_subscription: false,
            subscription_status: null,
          });
        }

        const headers = new Headers({
          ...getCorsHeaders(),
          Location: url.origin + (env.LOGIN_REDIRECT_URI || "/"),
        });

        // Set access token cookie and clear temporary cookies
        headers.append(
          "Set-Cookie",
          `x_access_token=${encodeURIComponent(
            access_token,
          )}; HttpOnly; Domain=xymake.com; Path=/; Secure; SameSite=Lax; Max-Age=34560000`,
        );
        headers.append(
          "Set-Cookie",
          `x_user_id=${encodeURIComponent(
            id,
          )}; HttpOnly; Domain=xymake.com; Path=/; Secure; SameSite=Lax; Max-Age=34560000`,
        );
        headers.append(
          "Set-Cookie",
          `x_oauth_state=; Domain=xymake.com; Max-Age=0; Path=/`,
        );
        headers.append(
          "Set-Cookie",
          `x_code_verifier=; Domain=xymake.com; Max-Age=0; Path=/`,
        );

        return new Response("Redirecting", {
          status: 307,
          headers,
        });
      } catch (error) {
        return new Response(
          html`
            <!DOCTYPE html>
            <html lang="en">
              <head>
                <title>Login Failed</title>
              </head>
              <body>
                <h1>X Login Failed</h1>
                <p>
                  ${error instanceof Error ? error.message : "Unknown error"}
                </p>
                <script>
                  setTimeout(() => (window.location.href = "/"), 5000);
                </script>
                <p>Redirecting to homepage in 5 seconds...</p>
                <a href="/">Return to homepage</a>
              </body>
            </html>
          `,
          {
            status: 500,
            headers: {
              "Content-Type": "text/html",
              "Set-Cookie": `x_oauth_state=; Domain=xymake.com; Max-Age=0; Path=/, x_code_verifier=; Max-Age=0; Domain=xymake.com; Path=/`,
              ...getCorsHeaders(),
            },
          },
        );
      }
    }

    // Logout route
    if (url.pathname === "/logout") {
      // Update last_login in the database if we have the user ID
      if (userId) {
        await client.update(
          "users",
          { last_login: new Date().toISOString() },
          { id: userId },
        );
      }

      const headers = new Headers({
        Location: "/",
        ...getCorsHeaders(),
      });

      headers.append(
        "Set-Cookie",
        "x_access_token=; Max-Age=0; Domain=xymake.com; Path=/; HttpOnly; Secure; SameSite=Lax",
      );
      headers.append(
        "Set-Cookie",
        "x_user_id=; Max-Age=0; Domain=xymake.com; Path=/; HttpOnly; Secure; SameSite=Lax",
      );

      return new Response("Logging out...", { status: 302, headers });
    }

    // Dashboard route - show user profile if logged in
    if (url.pathname === "/dashboard") {
      if (!accessToken || !userId) {
        // Redirect to login if no access token
        return new Response("Redirecting to login...", {
          status: 302,
          headers: {
            Location: "/login",
            ...getCorsHeaders(),
          },
        });
      }

      // Try to get user data from database with matching access_token

      const dbUserResult = await client.select("users", {
        id: userId,
        access_token: accessToken,
      });

      if (!dbUserResult.ok || !dbUserResult.json?.length) {
        return new Response("Redirecting to login...", {
          status: 302,
          headers: { Location: "/login", ...getCorsHeaders() },
        });
      }

      const userData = dbUserResult.json[0];

      // Stripe payment button HTML - you'll add your own keys
      const stripeButton = `
          <div class="mt-8 max-w-md mx-auto">
            <h3 class="text-xl font-semibold mb-4 ${
              userData.has_subscription ? "text-green-400" : ""
            }">
              ${
                userData.has_subscription
                  ? "✓ Premium Subscription Active"
                  : "Upgrade to Premium"
              }
            </h3>
            ${
              !userData.has_subscription
                ? `
              <div class="x-border bg-slate-700 rounded-xl p-6 mb-6">
                <p class="mb-4">Get exclusive features with a premium membership:</p>
                <ul class="list-disc pl-5 mb-6 text-slate-300">
                  <li>Advanced analytics</li>
                  <li>Custom profile themes</li>
                  <li>Priority support</li>
                </ul>
                <div id="stripe-button-container">
                   <div class="mb-8">
            <stripe-buy-button buy-button-id="buy_btn_1REsM3HdjTpW3q7ir46YIEPf"
                publishable-key="pk_live_51OByVPHdjTpW3q7iqVMf1htAJOQ9If61YZYQlDMc2vhx0XSgqu4Tpfpb6t4pRFJDWhJ7ZqdwMsnQn9RtDuztnnQA00NorRRKLl">
            </stripe-buy-button>
        </div>

                </div>
              </div>
            `
                : ""
            }
          </div>
        `;

      return new Response(
        html`
          <!DOCTYPE html>
          <html lang="en" class="bg-slate-900">
            <head>
              <script
                async
                src="https://js.stripe.com/v3/buy-button.js"
              ></script>
              <meta charset="utf8" />
              <script src="https://cdn.tailwindcss.com"></script>
              <title>X User Dashboard</title>
              <style>
                @import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap");
                body {
                  font-family: "Inter", sans-serif;
                }
                .x-border {
                  border: 1px solid rgba(255, 255, 255, 0.1);
                }
              </style>
              <script
                async
                src="https://js.stripe.com/v3/buy-button.js"
              ></script>
            </head>
            <body class="text-slate-100">
              <main class="max-w-6xl mx-auto px-4 py-16">
                <div class="text-center mb-20">
                  <h1
                    class="text-5xl font-bold mb-6 bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent"
                  >
                    X Dashboard
                  </h1>

                  <div
                    class="max-w-md mx-auto bg-slate-800 rounded-xl p-6 mb-8"
                  >
                    <div class="flex items-center gap-4">
                      <img
                        src="${userData.profile_image_url}"
                        alt="Profile"
                        class="w-16 h-16 rounded-full"
                      />
                      <div class="text-left">
                        <h2 class="text-xl font-semibold">${userData.name}</h2>
                        <p class="text-slate-400">@${userData.username}</p>
                        ${userData.has_subscription
                          ? `<p class="text-green-400 mt-1">Premium Member</p>`
                          : `<p class="text-slate-400 mt-1">Free Plan</p>`}
                      </div>
                    </div>
                  </div>

                  ${stripeButton}

                  <div class="flex justify-center gap-4 mt-8">
                    <a
                      href="/"
                      class="bg-blue-500 hover:bg-blue-600 px-6 py-3 rounded-lg font-medium transition-colors"
                    >
                      Home
                    </a>
                    <a
                      href="/logout"
                      class="border border-blue-500 text-blue-500 px-6 py-3 rounded-lg font-medium hover:bg-blue-500/10 transition-colors"
                    >
                      Logout
                    </a>
                  </div>
                </div>
              </main>
            </body>
          </html>
        `,
        {
          headers: {
            "content-type": "text/html",
            ...getCorsHeaders(),
          },
        },
      );
    }

    return new Response("Not found", { status: 404 });
  },
};

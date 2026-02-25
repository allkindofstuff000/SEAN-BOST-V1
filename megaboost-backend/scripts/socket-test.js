const { io } = require("socket.io-client");

const TARGET_URL = String(process.env.SOCKET_TEST_URL || "http://72.62.200.207").trim();
const IDENTIFIER = String(
  process.env.SOCKET_TEST_IDENTIFIER || process.env.ADMIN_EMAIL || ""
).trim();
const PASSWORD = String(
  process.env.SOCKET_TEST_PASSWORD || process.env.ADMIN_PASSWORD || ""
).trim();
const AUTH_TOKEN = String(process.env.MB_AUTH_TOKEN || "").trim();

function extractCookieHeader(response) {
  if (!response?.headers) return "";

  if (typeof response.headers.getSetCookie === "function") {
    const values = response.headers.getSetCookie();
    if (Array.isArray(values) && values.length > 0) {
      return values.map((item) => item.split(";")[0]).join("; ");
    }
  }

  const raw = response.headers.get("set-cookie");
  if (!raw) return "";

  return raw
    .split(/,(?=\s*[A-Za-z0-9_\-]+=)/g)
    .map((item) => item.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

async function resolveAuthOptions() {
  if (AUTH_TOKEN) {
    return {
      auth: {
        token: AUTH_TOKEN
      }
    };
  }

  if (!IDENTIFIER || !PASSWORD) {
    throw new Error(
      "Missing auth credentials. Set MB_AUTH_TOKEN or SOCKET_TEST_IDENTIFIER + SOCKET_TEST_PASSWORD."
    );
  }

  const loginResponse = await fetch(`${TARGET_URL}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      identifier: IDENTIFIER,
      password: PASSWORD
    })
  });

  const payloadText = await loginResponse.text();
  let payload = null;
  try {
    payload = payloadText ? JSON.parse(payloadText) : null;
  } catch {
    payload = payloadText;
  }

  if (!loginResponse.ok) {
    throw new Error(
      `Login failed (${loginResponse.status}): ${typeof payload === "string" ? payload : payload?.message || "Unknown error"}`
    );
  }

  const cookieHeader = extractCookieHeader(loginResponse);
  if (!cookieHeader) {
    throw new Error("Login succeeded but no auth cookie was returned.");
  }

  return {
    extraHeaders: {
      Cookie: cookieHeader
    }
  };
}

async function run() {
  try {
    const authOptions = await resolveAuthOptions();
    const socket = io(TARGET_URL, {
      ...authOptions,
      withCredentials: true,
      transports: ["polling", "websocket"],
      timeout: 15000
    });

    const timeoutId = setTimeout(() => {
      console.error("socket-test: connection timeout");
      socket.disconnect();
      process.exit(1);
    }, 20000);

    socket.on("connect", () => {
      console.log("connected");
      console.log(`socket id: ${socket.id}`);
      clearTimeout(timeoutId);
      socket.disconnect();
      process.exit(0);
    });

    socket.on("connect_error", (error) => {
      clearTimeout(timeoutId);
      console.error(`socket-test: connect_error: ${error?.message || error}`);
      socket.disconnect();
      process.exit(1);
    });

    socket.io.engine.on("upgrade", (transport) => {
      console.log(`transport upgraded to: ${transport.name}`);
    });
  } catch (error) {
    console.error(`socket-test: ${error.message}`);
    process.exit(1);
  }
}

run();

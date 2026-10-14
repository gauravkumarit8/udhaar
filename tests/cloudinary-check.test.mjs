import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import { interpretCloudinaryCheck, verifyCloudinaryCredentials } from "../scripts/lib/cloudinary-check.mjs";

/**
 * "Configured" is not "working". These cases are the difference between a
 * check-deploy line that means something and one that just reports that three
 * environment variables are non-empty.
 */
describe("interpretCloudinaryCheck", () => {
  it("accepts a 200 as proof the credentials work", () => {
    const result = interpretCloudinaryCheck({ status: 200, cloudName: "demo" });
    expect(result.level).toBe("ok");
    expect(result.detail).toMatch(/demo/);
  });

  it("treats 401 as a hard failure - the secret is wrong or rotated", () => {
    const result = interpretCloudinaryCheck({ status: 401, cloudName: "demo" });
    expect(result.level).toBe("fail");
    expect(result.hint).toMatch(/API secret/i);
  });

  it("treats a missing cloud as a hard failure and says which name was used", () => {
    const result = interpretCloudinaryCheck({ status: 404, cloudName: "typo-cloud" });
    expect(result.level).toBe("fail");
    expect(result.detail).toContain("typo-cloud");
    expect(result.hint).toMatch(/cloud name/i);
  });

  it("does NOT fail a key that is merely restricted from the admin API", () => {
    // A 403 here would mean "this key may be restricted to upload endpoints",
    // where proofs still work. Reporting it as broken would send someone
    // hunting a problem that isn't there.
    const result = interpretCloudinaryCheck({ status: 403, cloudName: "demo" });
    expect(result.level).toBe("warn");
  });

  it("does NOT fail when the network is the problem", () => {
    const result = interpretCloudinaryCheck({ error: new Error("fetch failed") });
    expect(result.level).toBe("warn");
    expect(result.detail).toMatch(/could not reach/i);
  });

  it("warns on rate limiting and on Cloudinary being down", () => {
    expect(interpretCloudinaryCheck({ status: 429, cloudName: "demo" }).level).toBe("warn");
    expect(interpretCloudinaryCheck({ status: 503, cloudName: "demo" }).level).toBe("warn");
  });

  it("warns on anything it does not recognise, rather than guessing", () => {
    const result = interpretCloudinaryCheck({ status: 418, cloudName: "demo" });
    expect(result.level).toBe("warn");
    expect(result.detail).toMatch(/418/);
  });
});

/** A throwaway HTTP server so the real code path can be exercised offline. */
function serve(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

describe("verifyCloudinaryCredentials", () => {
  const servers = [];
  afterEach(() => {
    while (servers.length) servers.pop().close();
  });

  it("sends the API key as Basic auth and reports a 200", async () => {
    let seenAuth = null;
    const server = await serve((req, res) => {
      seenAuth = req.headers.authorization;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ resources: [] }));
    });
    servers.push(server);

    const { port } = server.address();
    const result = await verifyCloudinaryCredentials({
      cloudName: "demo",
      apiKey: "1234567890",
      apiSecret: "s3cret",
      apiBase: `http://127.0.0.1:${port}`,
    });

    expect(result.level).toBe("ok");
    expect(seenAuth).toBe(`Basic ${Buffer.from("1234567890:s3cret").toString("base64")}`);
  });

  it("reports a rejected secret as a failure", async () => {
    const server = await serve((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid credentials" } }));
    });
    servers.push(server);

    const { port } = server.address();
    const result = await verifyCloudinaryCredentials({
      cloudName: "demo",
      apiKey: "k",
      apiSecret: "wrong",
      apiBase: `http://127.0.0.1:${port}`,
    });

    expect(result.level).toBe("fail");
    expect(result.detail).toMatch(/401/);
  });

  it("turns an unreachable host into a warning instead of throwing", async () => {
    // Port 1 on localhost is closed: no external network needed for this case.
    const result = await verifyCloudinaryCredentials({
      cloudName: "demo",
      apiKey: "k",
      apiSecret: "s",
      apiBase: "http://127.0.0.1:1",
    });
    expect(result.level).toBe("warn");
    expect(result.detail).toMatch(/could not reach/i);
  });

  it("skips cleanly when nothing is configured", async () => {
    const result = await verifyCloudinaryCredentials({ cloudName: "", apiKey: "", apiSecret: "" });
    expect(result.level).toBe("warn");
    expect(result.detail).toMatch(/not configured/i);
  });
});

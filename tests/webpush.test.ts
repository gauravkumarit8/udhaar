import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The web-push module is the half of notifications that a browser can actually
 * receive, so its failure modes matter more than its happy path: a dead
 * subscription must be pruned, a transient failure must never look like a
 * delivery, and a misconfigured server must not pretend it sent anything.
 */
const mocks = vi.hoisted(() => ({
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(),
  generateVAPIDKeys: vi.fn(() => ({ publicKey: "pub", privateKey: "priv" })),
}));

vi.mock("web-push", () => ({
  default: {
    setVapidDetails: mocks.setVapidDetails,
    sendNotification: mocks.sendNotification,
    generateVAPIDKeys: mocks.generateVAPIDKeys,
  },
}));

const subscription = {
  id: "sub-1",
  endpoint: "https://fcm.googleapis.com/fcm/send/abc",
  p256dh: "BNc...",
  auth: "k9...",
};

async function loadModule(env: Record<string, string | undefined>) {
  vi.resetModules();
  setEnv(env);
  return import("@/lib/webpush");
}

// Mutating process.env in place (rather than replacing it) keeps TypeScript
// happy, and only the keys this module reads are touched.
const VAPID_KEYS = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const;
const originalEnv = Object.fromEntries(VAPID_KEYS.map((key) => [key, process.env[key]]));

function setEnv(env: Record<string, string | undefined>) {
  for (const key of VAPID_KEYS) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  mocks.setVapidDetails.mockReset();
  mocks.sendNotification.mockReset().mockResolvedValue({ statusCode: 201 });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const key of VAPID_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  vi.restoreAllMocks();
});

describe("configuration", () => {
  it("reports the channel as off without keys, and on with them", async () => {
    const off = await loadModule({});
    expect(off.isWebPushConfigured()).toBe(false);
    expect(off.webPushPublicKey()).toBeNull();

    const on = await loadModule({
      VAPID_PUBLIC_KEY: "BPublicKey",
      VAPID_PRIVATE_KEY: "private-key",
    });
    expect(on.isWebPushConfigured()).toBe(true);
    // The browser needs exactly this value to subscribe.
    expect(on.webPushPublicKey()).toBe("BPublicKey");
  });

  it("never sends without keys - it reports a failure instead", async () => {
    const { sendWebPush } = await loadModule({});

    expect(await sendWebPush(subscription, { title: "hi" })).toBe("failed");
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });
});

describe("sendWebPush", () => {
  it("sends the notification payload and reports success", async () => {
    const { sendWebPush } = await loadModule({
      VAPID_PUBLIC_KEY: "BPublicKey",
      VAPID_PRIVATE_KEY: "private-key",
    });

    const outcome = await sendWebPush(subscription, { title: "₹1,000 due", body: "Tomorrow" });

    expect(outcome).toBe("sent");
    expect(mocks.setVapidDetails).toHaveBeenCalledWith(
      "mailto:noreply@example.com",
      "BPublicKey",
      "private-key"
    );

    const [target, payload] = mocks.sendNotification.mock.calls[0];
    expect(target).toEqual({
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    });
    expect(JSON.parse(payload)).toEqual({ title: "₹1,000 due", body: "Tomorrow" });
  });

  it("uses VAPID_SUBJECT when given one", async () => {
    const { sendWebPush } = await loadModule({
      VAPID_PUBLIC_KEY: "pub",
      VAPID_PRIVATE_KEY: "priv",
      VAPID_SUBJECT: "mailto:hello@udhaar.app",
    });

    await sendWebPush(subscription, { title: "hi" });

    expect(mocks.setVapidDetails).toHaveBeenCalledWith(
      "mailto:hello@udhaar.app",
      "pub",
      "priv"
    );
  });

  it("reports a browser that is gone (410) so the row can be deleted", async () => {
    const { sendWebPush } = await loadModule({ VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" });
    mocks.sendNotification.mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }));

    expect(await sendWebPush(subscription, { title: "hi" })).toBe("gone");
  });

  it("reports 404 as gone too - the endpoint no longer exists", async () => {
    const { sendWebPush } = await loadModule({ VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" });
    mocks.sendNotification.mockRejectedValue(Object.assign(new Error("nope"), { statusCode: 404 }));

    expect(await sendWebPush(subscription, { title: "hi" })).toBe("gone");
  });

  it("treats anything else as a failure, never as delivered", async () => {
    const { sendWebPush } = await loadModule({ VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" });
    mocks.sendNotification.mockRejectedValue(Object.assign(new Error("boom"), { statusCode: 500 }));

    expect(await sendWebPush(subscription, { title: "hi" })).toBe("failed");
  });

  it("survives a rejection without a status code", async () => {
    const { sendWebPush } = await loadModule({ VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" });
    mocks.sendNotification.mockRejectedValue(new Error("socket hang up"));

    expect(await sendWebPush(subscription, { title: "hi" })).toBe("failed");
  });
});

// ── The fan-out: browser subscriptions ride along with every notification ──
//
// `sendPushToUser` is what every notification in the app calls, so this is the
// seam that decides whether a browser ever hears anything - and whether a dead
// subscription gets cleaned up or fails forever.
const webSubscription = {
  id: "sub-1",
  endpoint: "https://fcm.googleapis.com/fcm/send/abc",
  p256dh: "BNc...",
  auth: "k9...",
};

/** Awaitable *and* chainable, so `.where()` and `.where().limit(1)` both work. */
function query(rows: unknown[]) {
  return Object.assign(Promise.resolve(rows), { limit: async () => rows });
}

/** Loads src/lib/push with a stubbed db that answers per select call. */
async function loadPush(
  env: Record<string, string | undefined>,
  answers: { user?: unknown[]; subscriptions?: unknown[] }
) {
  vi.resetModules();
  setEnv(env);

  const deleted: unknown[] = [];
  let selects = 0;

  vi.doMock("@/db", () => ({
    db: {
      select: () => {
        selects += 1;
        return { from: () => ({ where: () => query(selects === 1 ? answers.user ?? [] : answers.subscriptions ?? []) }) };
      },
      insert: () => ({ values: async () => {} }),
      delete: () => ({
        where: async (where: unknown) => {
          deleted.push(where);
        },
      }),
    },
  }));

  return { push: await import("@/lib/push"), deleted };
}

describe("browser subscriptions ride along with every push", () => {
  it("sends to a subscribed browser through the same sendPushToUser call", async () => {
    const { push } = await loadPush(
      { VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" },
      { user: [{ pushEnabled: true }], subscriptions: [webSubscription] }
    );

    const result = await push.sendPushToUser("user-1", "₹1,000 due", "Tomorrow", { loanId: "l1" });

    expect(result.sent).toBe(1);
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.sendNotification.mock.calls[0][1])).toMatchObject({
      title: "₹1,000 due",
      body: "Tomorrow",
      loanId: "l1",
    });
  });

  it("deletes a subscription the push service says is gone, and claims nothing was sent", async () => {
    const { push, deleted } = await loadPush(
      { VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" },
      { user: [{ pushEnabled: true }], subscriptions: [webSubscription] }
    );
    mocks.sendNotification.mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }));

    const result = await push.sendPushToUser("user-1", "hi", "there");

    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(deleted).toHaveLength(1);
  });

  it("does nothing at all when the server has no VAPID keys", async () => {
    const { push } = await loadPush({}, { user: [{ pushEnabled: true }], subscriptions: [webSubscription] });

    const result = await push.sendPushToUser("user-1", "hi", "there");

    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("respects the user's push preference before any channel is touched", async () => {
    const { push } = await loadPush(
      { VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" },
      { user: [{ pushEnabled: false }], subscriptions: [webSubscription] }
    );

    const result = await push.sendPushToUser("user-1", "hi", "there");

    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });
});

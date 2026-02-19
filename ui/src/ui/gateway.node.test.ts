import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wsInstances = vi.hoisted((): MockWebSocket[] => []);
const clearDeviceAuthTokenMock = vi.hoisted(() => vi.fn());

type CloseHandler = (event: { code: number; reason: string }) => void;

class MockWebSocket {
  static readonly OPEN = 1;

  readyState = MockWebSocket.OPEN;
  private closeHandlers: CloseHandler[] = [];

  constructor(_url: string) {
    wsInstances.push(this);
  }

  addEventListener(event: string, handler: EventListener): void {
    if (event === "close") {
      this.closeHandlers.push(handler as unknown as CloseHandler);
    }
  }

  send(_data: string): void {}

  close(_code?: number, _reason?: string): void {}

  emitClose(code: number, reason: string): void {
    for (const handler of this.closeHandlers) {
      handler({ code, reason });
    }
  }
}

vi.mock("./device-auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./device-auth.ts")>();
  return {
    ...actual,
    clearDeviceAuthToken: (...args: unknown[]) => clearDeviceAuthTokenMock(...args),
  };
});

const { GatewayBrowserClient } = await import("./gateway.ts");

function getLatestWs(): MockWebSocket {
  const ws = wsInstances.at(-1);
  if (!ws) {
    throw new Error("missing mock websocket instance");
  }
  return ws;
}

describe("GatewayBrowserClient close handling", () => {
  beforeEach(() => {
    clearDeviceAuthTokenMock.mockReset();
    wsInstances.length = 0;
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears stale token on device token mismatch close", () => {
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
    });
    (
      client as unknown as {
        deviceIdentity: { deviceId: string };
      }
    ).deviceIdentity = { deviceId: "dev-ui-1" };

    client.start();
    getLatestWs().emitClose(
      1008,
      "unauthorized: DEVICE token mismatch (rotate/reissue device token)",
    );

    expect(clearDeviceAuthTokenMock).toHaveBeenCalledWith({
      deviceId: "dev-ui-1",
      role: "operator",
    });
    client.stop();
  });

  it("does not clear token for unrelated close reasons", () => {
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
    });
    (
      client as unknown as {
        deviceIdentity: { deviceId: string };
      }
    ).deviceIdentity = { deviceId: "dev-ui-2" };

    client.start();
    getLatestWs().emitClose(1008, "unauthorized: gateway token mismatch");

    expect(clearDeviceAuthTokenMock).not.toHaveBeenCalled();
    client.stop();
  });
});

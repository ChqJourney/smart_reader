import { vi } from "vitest";

/**
 * Helper to mock @tauri-apps/api/core invoke for tests.
 * Returns a setup function that replaces the module with the provided handlers.
 */
export function mockTauriInvoke(
  handlers: Record<string, (...args: any[]) => any>
) {
  const invoke = vi.fn((command: string, args?: Record<string, any>) => {
    const handler = handlers[command];
    if (!handler) {
      return Promise.reject(
        new Error(`No mock handler for command: ${command}`)
      );
    }
    return Promise.resolve(handler(args));
  });

  vi.doMock("@tauri-apps/api/core", () => ({
    invoke,
  }));

  return invoke;
}

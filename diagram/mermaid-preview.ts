import type {
  ExtensionAPI,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";

type Listen = ExtensionUIContext["onTerminalInput"];

/** Ask the pane about a three-byte RGB pixel without creating an image or moving the cursor. */
export function queryPaneGraphics(
  listen: Listen,
  write: (query: string) => void,
  timeoutMs = 350,
): { supported: Promise<boolean>; dispose: () => void } {
  const id = String(tui.allocateImageId());
  const prefix = `\x1b_Gi=${id};`;
  let cleanup: (() => void) | undefined;
  const supported = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
    const unsubscribe = listen((data) => {
      if (!data.startsWith(prefix) || !data.endsWith("\x1b\\"))
        return undefined;
      clearTimeout(timer);
      resolve(data === prefix + "OK\x1b\\");
      unsubscribe();
      return { consume: true };
    });
    cleanup = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve(false);
    };
    try {
      write(`\x1b_Ga=q,i=${id},s=1,v=1,t=d,f=24;AAAA\x1b\\`);
    } catch {
      cleanup();
    }
  });
  // A delayed response still belongs to this query. Keep its exact-ID
  // input filter until the reply arrives or the extension session ends.
  return {
    supported,
    dispose() {
      cleanup?.();
    },
  };
}

export function registerMermaidPreview(pi: ExtensionAPI): void {
  let pending: ReturnType<typeof queryPaneGraphics> | undefined;
  pi.on("session_start", async (_event, ctx) => {
    if (
      ctx.mode !== "tui" ||
      !ctx.hasUI ||
      !process.stdin.isTTY ||
      !process.stdout.isTTY ||
      !Object.hasOwn(tui, "needsZellijImageProbe") ||
      !tui.needsZellijImageProbe()
    )
      return;
    pending?.dispose();
    const probe = queryPaneGraphics(
      (listener) => ctx.ui.onTerminalInput(listener),
      (query) => {
        process.stdout.write(query);
      },
    );
    pending = probe;
    const supported = await probe.supported;
    if (pending === probe) tui.setZellijKittySupport(supported);
  });
  pi.on("session_shutdown", () => {
    pending?.dispose();
    pending = undefined;
  });
}

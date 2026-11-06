// Module Web Worker that runs user scripts off the main thread. The lockdown import must stay
// first: it removes network and shared-storage globals before the engine is evaluated.
import "./script-worker-lockdown.ts";
import { runScript } from "@darkfactory/scripting";
import { handleScriptMessage, SCRIPT_WORKER_READY } from "./script-sandbox.ts";

type WorkerScope = Readonly<{
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent<unknown>) => void
  ) => void;
  postMessage: (message: unknown) => void;
}>;

const scope = globalThis as unknown as WorkerScope;
scope.addEventListener("message", (event) => {
  const response = handleScriptMessage(event.data, runScript);
  if (response !== null) scope.postMessage(response);
});
// Script time limits start from here, not from loading this module and the engine.
scope.postMessage({ type: SCRIPT_WORKER_READY });

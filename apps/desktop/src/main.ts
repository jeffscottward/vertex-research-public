// What: Electron main entry. One instance at a time (a second launch focuses the first), then
// starts the shell with the Electron adapter once the app is ready.
import { app } from "electron";

import { startDesktop } from "./app.ts";
import { createElectronPorts } from "./electron-ports.ts";

app.setName("Vertex");
app.setAppUserModelId("xyz.vertex.desktop");
if (app.requestSingleInstanceLock()) {
  void app.whenReady().then(() => startDesktop(createElectronPorts()));
} else {
  app.quit();
}

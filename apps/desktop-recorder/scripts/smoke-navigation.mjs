import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../src/renderer/index.html", import.meta.url), "utf8");
const renderer = await readFile(new URL("../src/renderer/renderer.ts", import.meta.url), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hasId(id) {
  return html.includes(`id="${id}"`) || html.includes(`id='${id}'`);
}

for (const screen of ["create", "setup", "capture", "review"]) {
  assert(html.includes(`data-screen="${screen}"`), `Missing ${screen} sidebar button`);
  assert(renderer.includes(`${screen}: [`), `Missing ${screen} screen mapping`);
}

for (const id of [
  "setupAuthPanel",
  "apiUrl",
  "accessToken",
  "saveRecorderSettings",
  "testConnection",
  "clearToken",
  "openRecorderTokenPage",
  "copyDiagnostics",
  "refreshSources",
  "screenTab",
  "windowTab",
  "browserTab",
  "startRecording",
  "stopRecording",
  "selectFolder",
  "uploadRecording",
  "recentRecordings",
]) {
  assert(hasId(id), `Missing DOM element #${id}`);
}

for (const requiredSnippet of [
  "showScreen(target)",
  "el(\"saveRecorderSettings\").addEventListener",
  "el(\"testConnection\").addEventListener",
  "el(\"refreshSources\").addEventListener",
  "el(\"startRecording\").addEventListener",
  "el(\"stopRecording\").addEventListener",
  "el(\"selectFolder\").addEventListener",
  "el(\"uploadRecording\").addEventListener",
  "screen-hidden",
  "diagBuildIdentity",
]) {
  assert(renderer.includes(requiredSnippet) || html.includes(requiredSnippet), `Missing handler/wiring: ${requiredSnippet}`);
}

console.log("desktop recorder navigation smoke passed");

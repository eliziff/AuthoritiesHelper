// Node's own notice that node:sqlite is experimental means nothing to someone using this program;
// every other warning still prints. Imported first, before node:sqlite loads.
const [printer] = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (!(warning.name === "ExperimentalWarning" && /SQLite/u.test(warning.message))) printer?.(warning);
});

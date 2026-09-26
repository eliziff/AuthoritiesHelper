// stream/promises.pipeline for the runtime's own writers (the in-page HTTP response).
export async function pipeline(source, destination) {
  for await (const chunk of source) {
    if (destination.write(chunk) === false) await new Promise((resolve) => destination.once("drain", resolve));
  }
  destination.end();
}
export default { pipeline };

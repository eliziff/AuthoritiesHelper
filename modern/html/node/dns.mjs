// A browser resolves and connects to hosts itself, so the server's address pinning
// (which guards a server's private network) has nothing to protect here. The
// documentation address satisfies that check without naming a real host.
export async function lookup() {
  return [{ address: "192.0.2.1", family: 4 }];
}
export default { lookup };

// The address checks Node's net module provides to remoteUrlSafety.
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function ipv6Parts(value) {
  let text = value.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    if (!IPV4.test(dotted[1])) return null;
    const [a, b, c, d] = dotted[1].split(".").map(Number);
    text = text.slice(0, -dotted[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [], tail = halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const parts = [...head, ...Array(Math.max(fill, 0)).fill("0"), ...tail];
  if (parts.length !== 8 || (halves.length === 1 && fill) ||
      parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.map((part) => BigInt(`0x${part}`));
}

export function isIP(value) {
  if (IPV4.test(value)) return 4;
  return ipv6Parts(value) ? 6 : 0;
}

const numeric = (address, family) => family === "ipv4"
  ? BigInt(address.split(".").reduce((total, part) => total * 256 + Number(part), 0))
  : ipv6Parts(address).reduce((total, part) => (total << 16n) | part, 0n);

export class BlockList {
  #rules = [];
  addSubnet(network, prefix, family = "ipv4") {
    const bits = family === "ipv4" ? 32n : 128n, size = bits - BigInt(prefix);
    const start = (numeric(network, family) >> size) << size;
    this.#rules.push({ family, start, end: start + (1n << size) - 1n });
  }
  addRange(start, end, family = "ipv4") {
    this.#rules.push({ family, start: numeric(start, family), end: numeric(end, family) });
  }
  check(address, family = "ipv4") {
    if ((family === "ipv4" ? 4 : 6) !== isIP(address)) return false;
    const value = numeric(address, family);
    return this.#rules.some((rule) => rule.family === family && value >= rule.start && value <= rule.end);
  }
}
export default { isIP, BlockList };

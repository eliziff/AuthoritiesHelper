// Node facilities the browser runtime does not have. Reaching one is an actionable error.
const unavailable = (what) => () => { throw new Error(`${what} is not available in the browser version of Authorities.`); };
export const execFile = unavailable("Running local programs");
export const spawn = execFile;
export class DatabaseSync { constructor() { unavailable("Local legal data")(); } }
export default { execFile, spawn, DatabaseSync };

const quiet = { hasSubscribers: false, publish() {}, subscribe() {}, unsubscribe() {} };
export const channel = () => quiet;
export const subscribe = () => {};
export const unsubscribe = () => {};
export default { channel, subscribe, unsubscribe };

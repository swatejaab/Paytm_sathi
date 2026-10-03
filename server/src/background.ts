// Work that continues after the HTTP response (simulated partner updates). A long-running server needs nothing extra;
// on Vercel the function entry registers waitUntil so the instance stays alive until the work finishes.
type Waiter = (promise: Promise<unknown>) => void;

let waiter: Waiter | null = null;

export function setBackgroundWaiter(next: Waiter): void {
  waiter = next;
}

export function keepAlive(promise: Promise<unknown>): void {
  waiter?.(promise.catch(() => undefined));
}

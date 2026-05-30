/**
 * Tiny concurrency limiter. No deps.
 *   const run = createLimit(6);
 *   await Promise.all(items.map(item => run(() => doWork(item))));
 */
export function createLimit(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (active >= concurrency) return;
    const job = queue.shift();
    if (job) job();
  };

  return function run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        active++;
        fn().then(
          (v) => {
            active--;
            resolve(v);
            next();
          },
          (e) => {
            active--;
            reject(e);
            next();
          },
        );
      };
      if (active < concurrency) start();
      else queue.push(start);
    });
  };
}

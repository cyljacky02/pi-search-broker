/** Track promises and drain the current batch; callers own admission and cancellation. */
export function createPendingWork() {
  const active = new Set();

  function track(work) {
    active.add(work);
    work.then(() => active.delete(work), () => active.delete(work));
    return work;
  }

  return { track, drain: () => Promise.allSettled([...active]) };
}

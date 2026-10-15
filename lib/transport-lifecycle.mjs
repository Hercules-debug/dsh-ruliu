/** Serialize transport replacement so old routes and listeners leave before new ones enter. */
export function createTransportLifecycle({ read, mount, report }) {
  let active
  let closed = false
  let tail = Promise.resolve()
  const refresh = () => {
    const snapshot = read()
    const task = tail.then(async () => {
      if (closed) return
      if (active !== undefined) {
        const previous = active
        active = undefined
        await previous.dispose()
      }
      if (closed || !snapshot.enabled) return
      active = mount(snapshot)
      await active.await()
    })
    tail = task.catch(report)
    return task
  }
  const dispose = async () => {
    closed = true
    await tail
    if (active !== undefined) {
      const previous = active
      active = undefined
      await previous.dispose()
    }
  }
  return { refresh, dispose }
}

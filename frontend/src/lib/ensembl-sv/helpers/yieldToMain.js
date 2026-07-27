const i = async () => {
  "scheduler" in globalThis && "yield" in scheduler ? await scheduler.yield() : await new Promise((e) => setTimeout(e));
};
export {
  i as default
};

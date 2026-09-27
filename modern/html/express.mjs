// The part of Express the Authorities runtime router uses: Router, use, get/post and json().
// Requests arrive from the page through the in-page HTTP adapter (runtime-worker.mjs).

function matches(route, request) {
  return (!route.method || route.method === request.method) && (!route.path || route.path === request.path);
}

export function Router() {
  const stack = [];
  function handle(request, response, done) {
    let index = 0;
    const next = (error) => {
      const layer = stack[index++];
      if (!layer) return done(error);
      if (!matches(layer, request)) return next(error);
      if (layer.handlers) {
        let step = 0;
        const run = (stepError) => {
          if (stepError) return next(stepError);
          const handler = layer.handlers[step++];
          if (!handler) return next();
          try { handler(request, response, run); } catch (thrown) { next(thrown); }
        };
        return error ? next(error) : run();
      }
      if (error) return next(error);
      try { layer.use(request, response, next); } catch (thrown) { next(thrown); }
    };
    next();
  }
  const router = (request, response, done) => handle(request, response, done);
  router.handle = handle;
  router.use = (use) => { stack.push({ use }); return router; };
  for (const method of ["get", "post", "put", "patch", "delete"])
    router[method] = (path, ...handlers) => { stack.push({ method: method.toUpperCase(), path, handlers }); return router; };
  return router;
}

// Bodies are decoded by the in-page adapter before routing.
export const json = () => (_request, _response, next) => next();
export default { Router, json };

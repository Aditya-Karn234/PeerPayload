const express = require("express");

// Express 4 doesn't catch a rejected promise from an async handler: the
// request hangs and, on Node 15+, the unhandled rejection kills the whole
// process — one bad request or a database blip took the backend down. This
// router wraps every handler so a rejection goes to next(err) and the error
// middleware in server.js answers it instead.
function wrap(handler) {
  // Error middleware is identified by arity 4; leave it untouched.
  if (typeof handler !== "function" || handler.length === 4)
    return handler;

  return function wrapped(req, res, next) {
    try {
      const result = handler(req, res, next);

      if (result && typeof result.catch === "function")
        result.catch(next);
    } catch (err) {
      next(err);
    }
  };
}

function createRouter() {
  const router = express.Router();

  for (const method of ["use", "get", "post", "put", "patch", "delete", "all"]) {
    const original = router[method].bind(router);

    router[method] = (...args) => original(...args.map((arg) => (Array.isArray(arg) ? arg.map(wrap) : wrap(arg))));
  }

  return router;
}

module.exports = { createRouter, wrap };

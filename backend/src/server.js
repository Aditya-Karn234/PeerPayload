require("dotenv").config();

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server: SocketIOServer } = require("socket.io");

const config = require("./config");
const transfersRouter = require("./routes/transfers");
const networkRouter = require("./routes/network");
const authRouter = require("./routes/auth");
const usersRouter = require("./routes/users");
const presenceRouter = require("./routes/presence");
const directoryRouter = require("./routes/directory");
const { requireAuth } = require("./middleware/auth");
const { verifySessionToken } = require("./auth/tokens");
const signalBus = require("./signalBus");

const app = express();

// Render terminates TLS at its proxy; without this req.ip is the proxy's
// address and the login limiter would lump every client together.
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/auth", authRouter);
app.use("/users", usersRouter);
app.use("/presence", presenceRouter);
app.use("/directory", directoryRouter);
app.use("/transfers", requireAuth, transfersRouter);
app.use("/network", requireAuth, networkRouter);

app.use((req, res) => res.status(404).json({ error: "not found" }));

// Every handler error ends here (routes use lib/router's createRouter, which
// forwards async rejections). Answers the request instead of crashing the
// process; malformed client input becomes a 400, anything else a 500.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  let status = 500;

  if (err.status >= 400 && err.status < 600)
    status = err.status; // e.g. body-parser's 400 for malformed JSON
  else if (err.name === "PrismaClientValidationError")
    status = 400; // a value the schema rejects slipped past route validation

  if (status >= 500)
    console.error(`${req.method} ${req.originalUrl} failed:`, err);

  if (res.headersSent)
    return;

  // Only http-errors style errors (expose: true) carry a message meant for
  // clients; never echo internal or Prisma error text.
  const message = status >= 500 ? "internal server error" : err.expose ? err.message : "invalid request";

  res.status(status).json({ error: message });
});

const server = http.createServer(app);

const io = new SocketIOServer(server, {
  cors: { origin: "*" },
});

// Authenticated per-user signaling — replaces the old personal-tool's
// anonymous per-transfer-id rooms (which existed to relay backend-run
// engine progress; the backend doesn't run the engine anymore, so that
// mechanism has nothing left to relay). A socket here identifies a
// specific logged-in user and joins exactly one room for them; every
// signalBus event forwards straight into that one room.
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const result = token ? await verifySessionToken(token) : null;

    if (!result)
      return next(new Error("unauthorized"));

    socket.userId = result.user.id;
    next();
  } catch (err) {
    // A database failure here must not become an unhandled rejection.
    // "unavailable" (not "unauthorized") so the client retries instead of
    // logging the user out.
    console.error("socket auth failed:", err);
    next(new Error("unavailable"));
  }
});

io.on("connection", (socket) => {
  socket.join(`user:${socket.userId}`);
});

signalBus.on("incoming-transfer", (userId, transfer) => {
  io.to(`user:${userId}`).emit("incoming-transfer", transfer);
});

signalBus.on("transfer-accepted", (userId, transfer) => {
  io.to(`user:${userId}`).emit("transfer-accepted", transfer);
});

signalBus.on("transfer-rejected", (userId, transfer) => {
  io.to(`user:${userId}`).emit("transfer-rejected", transfer);
});

signalBus.on("session-revoked", (userId) => {
  io.to(`user:${userId}`).emit("session-revoked");
});

server.listen(config.port, () => {
  console.log(`Backend listening on http://localhost:${config.port}`);
});

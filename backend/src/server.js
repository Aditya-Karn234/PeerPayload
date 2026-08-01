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

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/auth", authRouter);
app.use("/users", usersRouter);
app.use("/presence", presenceRouter);
app.use("/directory", directoryRouter);
app.use("/transfers", requireAuth, transfersRouter);
app.use("/network", requireAuth, networkRouter);

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
  const token = socket.handshake.auth?.token;
  const result = token ? await verifySessionToken(token) : null;

  if (!result)
    return next(new Error("unauthorized"));

  socket.userId = result.user.id;
  next();
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

# Build context is the repo root (see docker-compose.yml) so this stage can
# reach shared/, sender/, receiver/ alongside backend/ — the backend spawns
# the compiled engine binaries as subprocesses, so this image needs to
# contain both, not just the Node app.

# ---- Stage 1: compile the C++ engine -----------------------------------
FROM debian:bookworm-slim AS engine-build

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential cmake libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /engine
COPY CMakeLists.txt ./
COPY shared ./shared
COPY engine ./engine
COPY sender ./sender
COPY receiver ./receiver

RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build -- -j"$(nproc)"

# ---- Stage 2: Node dependencies + Prisma client -------------------------
FROM node:22-bookworm-slim AS backend-deps

WORKDIR /app
COPY backend/package*.json ./
RUN npm ci
COPY backend/prisma ./prisma
RUN npx prisma generate

# ---- Stage 3: runtime -----------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# libssl3 is the dynamic OpenSSL dependency the engine binaries were linked
# against in stage 1 (Linux doesn't statically link OpenSSL here — see
# shared/CMakeLists.txt's else() branch). Matching Debian codenames
# (bookworm) across every stage avoids an SONAME/ABI mismatch.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libssl3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=backend-deps /app/node_modules ./node_modules
COPY --from=backend-deps /app/prisma ./prisma
COPY backend/package.json ./
COPY backend/src ./src
COPY backend/docker-entrypoint.sh ./docker-entrypoint.sh

COPY --from=engine-build /engine/build/sender/sender /usr/local/bin/dts-sender
COPY --from=engine-build /engine/build/receiver/receiver /usr/local/bin/dts-receiver

RUN chmod +x ./docker-entrypoint.sh

ENV ENGINE_SENDER_PATH=/usr/local/bin/dts-sender
ENV ENGINE_RECEIVER_PATH=/usr/local/bin/dts-receiver
ENV PORT=4000

EXPOSE 4000

ENTRYPOINT ["./docker-entrypoint.sh"]

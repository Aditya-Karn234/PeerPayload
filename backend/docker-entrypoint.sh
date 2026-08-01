#!/bin/sh
# Applies any pending Prisma migrations before the server starts — this is
# what `npx prisma migrate dev` did manually in local dev; a container needs
# to do it itself on every startup instead, since there's no developer to
# run it by hand.
set -e

npx prisma migrate deploy

exec node src/server.js

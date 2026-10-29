# The public demo on aislop.cloud.
#
# PIPELINE_MODE=demo swaps the generator for pre-rendered sample sheets, so
# this image contains no API key, calls no provider and spawns no child
# process. There is nothing here that can spend money. Accounts, sessions, the
# credit ledger and the job queue are the real code.
#
# No `npm install`: the server has zero runtime dependencies.

FROM node:22-alpine

WORKDIR /app

COPY package.json server.js ./
COPY lib ./lib
COPY demo ./demo
COPY web/dist ./web/dist

# DATA_DIR is inside the container, so every deploy starts clean. For a demo
# that is the point — the banner tells visitors so.
RUN mkdir -p /app/data && chown -R node:node /app/data

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/app/data \
    PIPELINE_MODE=demo \
    SIGNUP_CREDITS=2000 \
    COOKIE_PATH=/spriteforge/ \
    MAX_ACCOUNTS=400 \
    MAX_CHARACTERS=8 \
    WORKERS=2 \
    PER_USER=1

# ADMIN_TOKEN is deliberately unset: /api/admin/* answers 404 without it, so
# the demo has no privileged surface at all.

EXPOSE 8080
USER node

CMD ["node", "server.js"]

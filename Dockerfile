# Hugging Face Space (Docker) - one container = one server process = one shared world.
FROM node:20-slim
WORKDIR /app
COPY --chown=node:node package.json package-lock.json* ./
# npm install (not ci) so a lock file that is behind package.json doesn't break the build
RUN npm install --no-audit --no-fund
COPY --chown=node:node . .
RUN npm run build && chown -R node:node /app
USER node
ENV NODE_ENV=production PORT=7860 HOSTNAME=0.0.0.0
EXPOSE 7860
CMD ["npx", "next", "start", "-p", "7860", "-H", "0.0.0.0"]

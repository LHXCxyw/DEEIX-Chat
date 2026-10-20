FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && ./node_modules/.bin/playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright \
    && npm cache clean --force
COPY --chown=node:node src ./src
USER node

# sandbox 不支持时自检失败，绝不以禁用 sandbox 降级。
EXPOSE 8010
CMD ["node", "src/server.js"]

# 通过 run-offline.ps1 创建 network=none 容器；不提供 HTTP 网络入口。
FROM runtime AS offline
USER 65532:65532
LABEL io.deeix.agent.runner="deeix-agent-offline-screenshot" \
      io.deeix.agent.sandbox-policy="moby-27.5.1-chromium-userns-v2" \
      io.deeix.agent.runner-version="1.0.0" \
      io.deeix.agent.protocol="1"
ENTRYPOINT ["/usr/local/bin/node", "/app/src/offline-cli.js"]
HEALTHCHECK CMD ["/usr/local/bin/node", "/app/src/offline-cli.js", "--selftest"]
CMD ["--selftest"]

# 独立交互镜像；版本和入口不可与静态 renderer 混用。
FROM runtime AS project-browser
USER 65532:65532
LABEL io.deeix.agent.runner="deeix-agent-project-browser" \
      io.deeix.agent.sandbox-policy="moby-27.5.1-chromium-userns-v2" \
      io.deeix.agent.runner-version="1.0.0" \
      io.deeix.agent.protocol="1"
ENTRYPOINT ["/usr/local/bin/node", "/app/src/project-browser-cli.js"]
HEALTHCHECK CMD ["/usr/local/bin/node", "/app/src/project-browser-cli.js", "--selftest"]
CMD ["--selftest"]

# 保持默认镜像为关闭生产动作的控制服务。
FROM runtime AS production
